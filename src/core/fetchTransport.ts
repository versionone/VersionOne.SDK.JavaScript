import { ApiError } from "./errors";
import type { RequestBody, RequestOptions, ResponseType, Transport } from "./transport";

/**
 * The HTTP layer, and nothing above it: it knows how to build a URL, send a
 * body in the shape it was given, read a response in the shape it was asked
 * for, and turn a failure into an ApiError. It does not know what an asset
 * is. The wire layer (one module per endpoint) knows the envelopes; the
 * model layer knows the types.
 *
 * Retries live here because this is the only place that can tell a network
 * failure from an answer, but they are narrow on purpose: only requests the
 * caller marks idempotent (every GET is; a POST to api/asset is not — a
 * retried batch write after a timeout is a double write), and only on a
 * network error, a 5xx, or a 429 (the instance throttles per token; it
 * sends no Retry-After, but one is honoured when present, up to 30 s). Any
 * other 4xx is an answer and is never retried.
 */
export interface FetchTransportConfig {
  baseUrl: string;
  /** A ready Authorization header value — "Bearer …" or "Basic …". Wins over accessToken. */
  authorization?: string;
  /** An access token; sent as "Bearer <token>". */
  accessToken?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Client-side ceiling per attempt. Generous by default: the politeness rule
   * is about the work a request asks of the server, not about client
   * impatience, and a slow or recovering host should not be hammered by
   * timeouts that turn into retries.
   */
  timeoutMs?: number;
  /**
   * Extra attempts after the first, for idempotent requests only (a GET,
   * a query.v1 read, a guarded batch that says so), after a network
   * failure or a 5xx. Default 1: one resend, 150 ms later. 0 turns it off.
   * A plain write is never resent whatever this says.
   */
  retries?: number;
  fetchImpl?: typeof fetch;
  /**
   * fetch's credentials mode. A browser app on the instance's own origin
   * that authenticates with the session cookie sets "same-origin" or
   * "include" (pair it with defaultHeaders { "X-Requested-With":
   * "XMLHttpRequest" } so the server answers 401 rather than a login page).
   * Left unset, fetch's default applies.
   */
  credentials?: RequestCredentials;
  /**
   * Called when the server answers 401 (or a status in unauthorizedStatuses):
   * the place to re-authenticate — open a login popup, re-run setup. Resolve
   * "retry" to send the request once more, "fail" to throw the error.
   *
   * A retry is offered only for an idempotent request (every GET; a write the
   * caller marked idempotent). A plain api/asset write is never resent
   * automatically, even after a 401: the hook still runs, so the session
   * can be repaired, and the caller decides whether to send again.
   */
  onUnauthorized?: (context: UnauthorizedContext) => UnauthorizedDecision | Promise<UnauthorizedDecision>;
  /** Which statuses call onUnauthorized. Default [401]; a cookie-session app may add 403. */
  unauthorizedStatuses?: readonly number[];
}

export type UnauthorizedDecision = "retry" | "fail";

export interface UnauthorizedContext {
  error: ApiError;
  request: RequestOptions;
  /** Whether a "retry" will be honoured: false for a non-idempotent write. */
  retryable: boolean;
}

/** The ApiError a caller's abort turns into. */
function abortedError(signal: AbortSignal): ApiError {
  return new ApiError("Request aborted", 0, "ABORTED", { cause: signal.reason });
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBase);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** The body as fetch wants it, with the content type it implies. */
function encodeBody(body: RequestBody | undefined, contentType: string | undefined): { body?: BodyInit; contentType?: string } {
  if (body === undefined) return {};
  if (typeof body === "string") return { body, contentType: contentType ?? "text/plain" };
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return { body: body as BodyInit, contentType: contentType ?? "application/octet-stream" };
  }
  // A form is handed to fetch as is: it writes the multipart boundary itself.
  if (typeof FormData !== "undefined" && body instanceof FormData) return { body };
  // A Blob (a browser File, say) is bytes with a type of its own.
  if (typeof Blob !== "undefined" && body instanceof Blob) return { body, contentType: contentType ?? (body.type || "application/octet-stream") };
  return { body: JSON.stringify(body), contentType: contentType ?? "application/json" };
}

async function readBody(response: Response, responseType: ResponseType): Promise<unknown> {
  if (responseType === "bytes") return new Uint8Array(await response.arrayBuffer());
  if (responseType === "text") return response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (responseType === "json" || contentType.includes("json")) {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      if (responseType === "json") throw new ApiError("Response is not JSON", response.status, "BAD_JSON", { body: text.slice(0, 500) });
      return text;
    }
  }
  return response.text();
}

/**
 * The message of an error response, from the shapes the Agility endpoints
 * actually send: rest-1's { _type: "Error", error, exceptions: [{ message }] },
 * api/asset's { Exceptions: ["…"] } (a request it could not parse — 400
 * with the parser's message since 2026-11, an opaque 500 before), a bare
 * { message }, or text.
 */
function messageOf(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const first = Array.isArray(d.exceptions) && d.exceptions[0] && typeof d.exceptions[0] === "object" ? (d.exceptions[0] as Record<string, unknown>).message : undefined;
    const listed = Array.isArray(d.Exceptions) ? d.Exceptions.filter((x): x is string => typeof x === "string" && !!x).join("; ") : undefined;
    for (const candidate of [d.error, first, listed, d.message]) {
      if (typeof candidate === "string" && candidate) return candidate;
    }
  }
  if (typeof data === "string" && data.trim()) return data.trim().slice(0, 200);
  return `HTTP ${status}`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The longest a Retry-After is honoured before the request is given up instead. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * How long to wait before resending after a 429 or a 5xx: the server's
 * Retry-After (seconds, or an HTTP date) when it sends one and it is
 * within reason, else a short backoff. Null when the server asks for
 * longer than is reasonable to block a caller for.
 */
function retryDelay(response: { status: number; headers: { get(name: string): string | null } }, attempt: number): number | null {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms > MAX_RETRY_AFTER_MS) return null;
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return 150 * (attempt + 1);
}

/** A status the same request may succeed after: too many requests, or a server-side failure. */
const retriable = (status: number): boolean => status === 429 || status >= 500;

export function createFetchTransport(config: FetchTransportConfig): Transport {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const retries = Math.max(0, config.retries ?? 1);
  const authorization = config.authorization ?? (config.accessToken ? `Bearer ${config.accessToken}` : undefined);
  const unauthorizedStatuses = config.unauthorizedStatuses ?? [401];

  return {
    async request<T>(options: RequestOptions): Promise<T> {
      const url = buildUrl(config.baseUrl, options.path, options.query);
      const { body, contentType } = encodeBody(options.body, options.contentType);
      const headers: Record<string, string> = { accept: "application/json", ...config.defaultHeaders, ...options.headers };
      // A bodiless request carries no content type: rest-1 rejects a GET that claims JSON.
      if (contentType) headers["content-type"] = contentType;
      if (authorization) headers.authorization = authorization;
      const responseType: ResponseType = options.responseType ?? "auto";
      const idempotent = options.idempotent ?? options.method === "GET";
      const attempts = idempotent ? retries + 1 : 1;

      const callerSignal = options.signal;

      let lastError: unknown;
      let reauthorized = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (callerSignal?.aborted) throw abortedError(callerSignal);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => controller.abort();
        callerSignal?.addEventListener("abort", onAbort, { once: true });
        const settle = () => {
          clearTimeout(timeoutId);
          callerSignal?.removeEventListener("abort", onAbort);
        };
        let response: Response;
        try {
          const init: RequestInit = { method: options.method, headers, body, signal: controller.signal };
          if (config.credentials) init.credentials = config.credentials;
          response = await fetchImpl(url, init);
        } catch (error) {
          settle();
          // The caller gave up: final, whatever attempt this was.
          if (callerSignal?.aborted) throw abortedError(callerSignal);
          // Network failure or timeout: the only case a retry can help.
          lastError = error instanceof Error && error.name === "AbortError"
            ? new ApiError(`Timed out after ${timeoutMs} ms`, 0, "TIMEOUT", { cause: error })
            : new ApiError(error instanceof Error ? error.message : String(error), 0, "NETWORK_ERROR", { cause: error });
          if (attempt + 1 < attempts) await delay(150 * (attempt + 1));
          continue;
        }

        try {
          if (response.ok) {
            options.onResponse?.({ status: response.status, headers: response.headers });
            return (await readBody(response, responseType)) as T;
          }
          if (response.status === 304 && options.acceptNotModified) {
            // The caller asked "has it changed?" and the answer is no.
            options.onResponse?.({ status: 304, headers: response.headers });
            return undefined as T;
          }

          // An answer, not a failure to get one. 5xx may be retried when
          // idempotent; anything else is final.
          const data = await readBody(response, responseType === "bytes" ? "text" : responseType === "json" ? "auto" : responseType);
          lastError = new ApiError(messageOf(data, response.status), response.status, undefined, data);
        } catch (error) {
          if (callerSignal?.aborted) throw abortedError(callerSignal);
          throw error;
        } finally {
          settle();
        }

        if (config.onUnauthorized && !reauthorized && unauthorizedStatuses.includes(response.status)) {
          // One re-authentication per request: a second refusal is final.
          reauthorized = true;
          const decision = await config.onUnauthorized({ error: lastError as ApiError, request: options, retryable: idempotent });
          if (callerSignal?.aborted) throw abortedError(callerSignal);
          if (decision === "retry" && idempotent) {
            // Not counted against `retries`: those are for failures to get an answer.
            attempt -= 1;
            continue;
          }
          break;
        }
        if (retriable(response.status) && attempt + 1 < attempts) {
          const wait = retryDelay(response, attempt);
          if (wait === null) break;
          await delay(wait);
          continue;
        }
        break;
      }
      throw lastError instanceof ApiError ? lastError : new ApiError("Unknown transport error", 0, "UNKNOWN_ERROR", { cause: lastError });
    }
  };
}

import { ApiError, apiErrorFromResponse } from "./errors";
import { DEFAULT_TIMEOUT_MS, deadline, declareSelfGoverned, resendable } from "./retry";
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
   * "retry" is honoured only for an idempotent request (every GET, and a
   * read sent by POST). No api/asset write is resent on it, even after a
   * 401, and that includes a guarded write (`sendGuarded`, `batch.run`
   * with a guard), which the SDK no longer marks idempotent: the hook
   * still runs, so the session can be repaired, and the caller decides
   * whether to send again. "retry-write" resends a write too, guarded or
   * plain, once, on the hook's own assertion that the refusal means
   * nothing ran (see UnauthorizedDecision). So `retryable: false` on a
   * guarded write does not mean it cannot be resumed after signing in
   * again: it means "retry-write" is the answer that resumes it.
   */
  onUnauthorized?: (context: UnauthorizedContext) => UnauthorizedDecision | Promise<UnauthorizedDecision>;
  /** Which statuses call onUnauthorized. Default [401]; a cookie-session app may add 403. */
  unauthorizedStatuses?: readonly number[];
}

/**
 * What the hook decides after re-authenticating:
 *   "fail"         throw the refusal.
 *   "retry"        send the request once more if it is idempotent; a plain
 *                  write is not resent and its refusal is thrown.
 *   "retry-write"  send the request once more whatever it is, a plain
 *                  write included. By answering this the hook ASSERTS that
 *                  on its server a refusal with one of
 *                  `unauthorizedStatuses` means nothing in the request was
 *                  executed — the sign-in was checked before any command
 *                  ran — so sending it again cannot apply anything twice.
 *                  What is known: on one product release, an api/asset
 *                  create sent with no session and one sent with an
 *                  invalid session were each answered 401 with an empty
 *                  body before any command ran, and nothing was created
 *                  (a consumer's check, by an exact-name query afterwards).
 *                  What is not: a session that was valid and has expired,
 *                  a 403, and rest-1. The SDK's own tests run where every
 *                  request is authenticated and check none of it, so
 *                  beyond that case it remains your assertion. Answer it
 *                  only where it holds (a missing or lapsed sign-in; not a
 *                  permission problem, which api/asset reports per command
 *                  inside a 200). Honoured once per request, like "retry".
 */
export type UnauthorizedDecision = "retry" | "retry-write" | "fail";

export interface UnauthorizedContext {
  error: ApiError;
  request: RequestOptions;
  /** Whether a "retry" will be honoured: false for any write, guarded or plain (which only "retry-write" resends). */
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

export function createFetchTransport(config: FetchTransportConfig): Transport {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, config.retries ?? 1);
  const authorization = config.authorization ?? (config.accessToken ? `Bearer ${config.accessToken}` : undefined);
  const unauthorizedStatuses = config.unauthorizedStatuses ?? [401];

  return declareSelfGoverned({
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
        // The one timeout rule (core/retry.ts): this attempt's deadline, or the caller's abort, whichever is first.
        // fetch lets go when its signal fires, so nothing more is needed here than to say which of the two it was.
        const limit = deadline(timeoutMs, callerSignal);
        const settle = limit.clear;
        let response: Response;
        try {
          const init: RequestInit = { method: options.method, headers, body, signal: limit.signal };
          if (config.credentials) init.credentials = config.credentials;
          // Looked up at each request, not when the transport was made: whatever replaces the global fetch later (a test's stub, an instrumented fetch) is what gets called.
          response = await (config.fetchImpl ?? globalThis.fetch)(url, init);
        } catch (error) {
          settle();
          // The caller gave up: final, whatever attempt this was.
          if (callerSignal?.aborted) throw abortedError(callerSignal);
          // A timeout ends the wait, not the work: the request may still be running, so it is never sent again.
          if (limit.expired()) throw new ApiError(`Timed out after ${timeoutMs} ms`, 0, "TIMEOUT", { cause: error });
          // No connection: the one failure here that a resend can help.
          lastError = new ApiError(error instanceof Error ? error.message : String(error), 0, "NETWORK_ERROR", { cause: error });
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
          lastError = apiErrorFromResponse(response.status, data);
        } catch (error) {
          if (callerSignal?.aborted) throw abortedError(callerSignal);
          // The deadline passed while the body was still arriving: a timeout like any other.
          if (limit.expired()) throw new ApiError(`Timed out after ${timeoutMs} ms`, 0, "TIMEOUT", { cause: error });
          throw error;
        } finally {
          settle();
        }

        if (config.onUnauthorized && options.reauthorize !== false && !reauthorized && unauthorizedStatuses.includes(response.status)) {
          // One re-authentication per request: a second refusal is final.
          reauthorized = true;
          const decision = await config.onUnauthorized({ error: lastError as ApiError, request: options, retryable: idempotent });
          if (callerSignal?.aborted) throw abortedError(callerSignal);
          if ((decision === "retry" && idempotent) || decision === "retry-write") {
            // Not counted against `retries`: those are for failures to get an answer.
            attempt -= 1;
            continue;
          }
          break;
        }
        if (resendable(lastError) && attempt + 1 < attempts) {
          const wait = retryDelay(response, attempt);
          if (wait === null) break;
          await delay(wait);
          continue;
        }
        break;
      }
      throw lastError instanceof ApiError ? lastError : new ApiError("Unknown transport error", 0, "UNKNOWN_ERROR", { cause: lastError });
    }
  });
}

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
 * network error or a 5xx. A 4xx is an answer and is never retried.
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
  /** Extra attempts after the first, for idempotent requests only. Default 0. */
  retries?: number;
  fetchImpl?: typeof fetch;
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

export function createFetchTransport(config: FetchTransportConfig): Transport {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const retries = Math.max(0, config.retries ?? 0);
  const authorization = config.authorization ?? (config.accessToken ? `Bearer ${config.accessToken}` : undefined);

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

      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(url, { method: options.method, headers, body, signal: controller.signal });
        } catch (error) {
          clearTimeout(timeoutId);
          // Network failure or timeout: the only case a retry can help.
          lastError = error instanceof Error && error.name === "AbortError"
            ? new ApiError(`Timed out after ${timeoutMs} ms`, 0, "TIMEOUT", { cause: error })
            : new ApiError(error instanceof Error ? error.message : String(error), 0, "NETWORK_ERROR", { cause: error });
          if (attempt + 1 < attempts) await delay(150 * (attempt + 1));
          continue;
        }
        clearTimeout(timeoutId);

        if (response.ok) return (await readBody(response, responseType)) as T;

        // An answer, not a failure to get one. 5xx may be retried when
        // idempotent; anything else is final.
        const data = await readBody(response, responseType === "bytes" ? "text" : responseType === "json" ? "auto" : responseType);
        lastError = new ApiError(messageOf(data, response.status), response.status, undefined, data);
        if (response.status >= 500 && attempt + 1 < attempts) {
          await delay(150 * (attempt + 1));
          continue;
        }
        break;
      }
      throw lastError instanceof ApiError ? lastError : new ApiError("Unknown transport error", 0, "UNKNOWN_ERROR", { cause: lastError });
    }
  };
}

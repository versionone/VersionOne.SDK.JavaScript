/**
 * A Transport built on axios, and the conformance suite run against it.
 * For an app that already talks HTTP through an axios instance (its
 * interceptors, its cancellation) and wants the SDK to use the same one.
 *
 * Two parts, each to copy: `createAxiosTransport`, the Transport; and
 * `adapterFor`, which lets the suite stand in for the network, so the
 * checks exercise axios itself rather than a mock of it. In a test file
 * the last lines become `for (const check of checks) it(check.name, check.run)`.
 *
 * Needs no instance and no credentials. axios is this repository's dev
 * dependency for this example only; the SDK itself depends on nothing.
 *
 *   node examples/11-axios-transport.ts
 */
import axios, { AxiosError, AxiosHeaders, CanceledError, type AxiosAdapter, type AxiosInstance, type InternalAxiosRequestConfig, type RawAxiosHeaders } from "axios";
import { ApiError, apiErrorFromResponse } from "@versionone/agility-sdk";
import type { RequestOptions, Transport } from "@versionone/agility-sdk";
import { CONFORMANCE_BASE_URL, transportConformance, type ConformanceServer } from "@versionone/agility-sdk/testing";

const aborted = (cause?: unknown) => new ApiError("Request aborted", 0, "ABORTED", { cause });
const isJson = (contentType: string) => /\bjson\b/i.test(contentType);

/** What to send for a body, and the content type it implies: the SDK's rule, not axios's own guess. */
function bodyOf(options: RequestOptions): { data: unknown; type?: string } {
  const { body, contentType } = options;
  if (body === undefined || body === null) return { data: undefined };
  if (typeof FormData !== "undefined" && body instanceof FormData) return { data: body };                 // the runtime writes the boundary
  if (typeof Blob !== "undefined" && body instanceof Blob) return { data: body, type: contentType ?? (body.type || "application/octet-stream") };
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return { data: body, type: contentType ?? "application/octet-stream" };
  if (typeof body === "string") return { data: body, type: contentType ?? "text/plain" };
  return { data: JSON.stringify(body), type: contentType ?? "application/json" };
}

/** A response body as the SDK reads a refusal's: parsed when it is JSON, else the text. */
function readable(data: unknown, contentType: string): unknown {
  const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data;
  if (typeof text !== "string" || !isJson(contentType)) return text;
  try { return JSON.parse(text); } catch { return text; }
}

/** The SDK's Transport over an axios instance whose `baseURL` is the Agility instance. */
export function createAxiosTransport(http: AxiosInstance): Transport {
  return {
    async request<T>(options: RequestOptions): Promise<T> {
      // Nothing is sent for a request that was cancelled before it began.
      if (options.signal?.aborted) throw aborted(options.signal.reason);
      const { data, type } = bodyOf(options);
      const bytes = options.responseType === "bytes";
      let response;
      try {
        response = await http.request({
          method: options.method,
          url: options.path.replace(/^\/+/, ""),          // relative, so it stays under baseURL's path
          params: Object.fromEntries(Object.entries(options.query ?? {}).filter(([, value]) => value !== undefined && value !== null)),
          headers: { ...options.headers, ...(type ? { "Content-Type": type } : {}) },
          data,
          signal: options.signal,
          responseType: bytes ? "arraybuffer" : "text",
          transformRequest: [(body) => body],             // already in the shape to send
          transformResponse: [(body) => body],            // read below, by the SDK's rules
          validateStatus: (status) => (status >= 200 && status < 300) || (status === 304 && options.acceptNotModified === true)
        });
      } catch (error) {
        if (axios.isCancel(error) || options.signal?.aborted) throw aborted(error);
        if (error instanceof AxiosError && error.response) {
          // A refusal: the same error, word for word, as the SDK's own transport throws.
          throw apiErrorFromResponse(error.response.status, readable(error.response.data, String(error.response.headers["content-type"] ?? "")));
        }
        // No answer at all. Timing is the client's business, not this transport's: the client's `timeoutMs` hands
        // over a `signal` that fires at the deadline, and honouring it (above) is all a transport owes.
        throw new ApiError(error instanceof Error ? error.message : String(error), 0, "NETWORK_ERROR", { cause: error });
      }
      const headers = AxiosHeaders.from(response.headers as RawAxiosHeaders);
      options.onResponse?.({ status: response.status, headers: { get: (name) => { const value = headers.get(name); return value == null ? null : String(value); } } });
      if (response.status === 304) return undefined as T;
      if (bytes) return new Uint8Array(response.data as ArrayBuffer) as T;
      const text = String(response.data ?? "");
      const wanted = options.responseType ?? "auto";
      if (wanted === "text" || (wanted === "auto" && !isJson(String(headers.get("content-type") ?? "")))) return text as T;
      if (text === "") return undefined as T;             // an empty body is no value, not a parse error
      try { return JSON.parse(text) as T; } catch { throw new ApiError("Response is not JSON", response.status, "BAD_JSON", { body: text.slice(0, 500) }); }
    }
  };
}

/** axios as it is in an app, except that its network is the suite's server. */
const adapterFor = (server: ConformanceServer): AxiosAdapter => async (config: InternalAxiosRequestConfig) => {
  const signal = config.signal as AbortSignal | undefined;
  if (signal?.aborted) throw new CanceledError(undefined, undefined, config);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(AxiosHeaders.from(config.headers).toJSON())) {
    if (value !== undefined && value !== null) headers[name.toLowerCase()] = String(value);
  }
  const answer = await server({
    method: (config.method ?? "get").toUpperCase(),
    url: axios.getUri(config),      // baseURL + url + params, as axios would send it
    headers,
    body: config.data,              // after transformRequest: what axios would put on the wire
    signal
  });
  if (signal?.aborted) throw new CanceledError(undefined, undefined, config);
  if (answer === "network-error") throw new AxiosError("Network Error", AxiosError.ERR_NETWORK, config);
  const body = answer.body ?? "";
  const data = config.responseType === "arraybuffer"
    ? (typeof body === "string" ? new TextEncoder().encode(body).buffer : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
    : (typeof body === "string" ? body : new TextDecoder().decode(body));
  const response = { data, status: answer.status, statusText: "", headers: AxiosHeaders.from(answer.headers ?? {}), config, request: {} };
  // A custom adapter settles the response itself. Without this, a 304 and a refusal would pass the suite for the wrong reason.
  if (!config.validateStatus || config.validateStatus(answer.status)) return response;
  throw new AxiosError(`Request failed with status code ${answer.status}`, AxiosError.ERR_BAD_RESPONSE, config, {}, response);
};

const checks = transportConformance((server) => createAxiosTransport(axios.create({ baseURL: CONFORMANCE_BASE_URL, adapter: adapterFor(server) })));
let broken = 0;
for (const check of checks) {
  try {
    await check.run();
  } catch (error) {
    broken += 1;
    console.log(`BROKEN: ${(error as Error).message}`);
  }
}
console.log(`${checks.length - broken} of ${checks.length} conformance checks pass for the axios transport`);
if (broken) process.exitCode = 1;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A JSON value, a text body (YAML for api/asset, say), bytes or a Blob (attachments), or a multipart form. */
export type RequestBody = unknown | string | Uint8Array | ArrayBuffer | Blob | FormData;

/**
 * How to read the response: "auto" parses JSON when the server says JSON and
 * returns text otherwise; "json" insists; "text" and "bytes" never parse.
 */
export type ResponseType = "auto" | "json" | "text" | "bytes";

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: RequestBody;
  /** The body's content type when it is not implied: text/yaml, image/png. */
  contentType?: string;
  responseType?: ResponseType;
  /**
   * May this request be sent again after a network failure or a 5xx? A GET
   * is, by default; anything else is not. A batch write to api/asset is
   * never idempotent unless the caller has made it so with a guard.
   */
  idempotent?: boolean;
  /**
   * The caller's cancellation: aborting it ends the request (and any retry
   * still to come) with an ApiError coded ABORTED. Never retried.
   */
  signal?: AbortSignal;
  /**
   * Called with a successful response's status and headers before its body
   * is read — for what the body alone does not say (an attachment's
   * Content-Type, say). A transport that cannot see headers may skip it.
   */
  onResponse?: (response: { status: number; headers: { get(name: string): string | null } }) => void;
}

export interface Transport {
  request<T>(options: RequestOptions): Promise<T>;
}

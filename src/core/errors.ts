/**
 * Every error the SDK throws is an ApiError, and every ApiError has a
 * `kind`: the one word a caller branches on. `status` and `code` say what
 * exactly happened; `kind` says what to do about it.
 *
 *   auth            401: re-authenticate (the transport's onUnauthorized hook ran first)
 *   forbidden       403: the credential is fine, the permission is not
 *   notFound        404, or a NOT_FOUND from a service
 *   invalid         the request was understood and refused: 400, a rejected query, too large
 *   transient       no answer, or a 5xx/408/429: the same request may succeed later
 *   aborted         the caller's signal ended it
 *   commandFailure  api/asset answered 200 with failed commands inside (CommandFailureError)
 *   protocol        the server answered something the SDK cannot read
 *   usage           a mistake caught before any request (UsageError): nothing was sent, so
 *                   do not blame the server — fix the call (status is 0 here)
 *   unknown         none of the above
 */
export type ErrorKind = "auth" | "forbidden" | "notFound" | "invalid" | "transient" | "aborted" | "commandFailure" | "protocol" | "usage" | "unknown";

/** The kind an HTTP status and an SDK code imply. A code wins over a status. */
export function kindOf(status: number, code?: string): ErrorKind {
  switch (code) {
    case "ABORTED": return "aborted";
    case "TIMEOUT":
    case "NETWORK_ERROR": return "transient";
    case "BAD_JSON":
    case "BAD_RESPONSE": return "protocol";
    case "USAGE": return "usage";
    case "CommandFailure": return "commandFailure";
    case "QUERY_REJECTED":
    case "TOO_LARGE": return "invalid";
    case "NOT_FOUND": return "notFound";
  }
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if (status >= 400) return "invalid";
  return "unknown";
}

const causeOf = (details: unknown): unknown => (details && typeof details === "object" && "cause" in details ? (details as { cause: unknown }).cause : undefined);

export class ApiError extends Error {
  /** The HTTP status; 0 when no answer came back (network, timeout, abort, usage). */
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  /**
   * What to do about it (see ErrorKind). "usage" means the SDK refused the
   * call before sending anything: no request reached the server, `status`
   * is 0, and the fix is in the calling code, so a formatter should not
   * word it as a server error.
   */
  readonly kind: ErrorKind;

  constructor(message: string, status: number, code?: string, details?: unknown, kind: ErrorKind = kindOf(status, code)) {
    const cause = causeOf(details);
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.kind = kind;
  }
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

/**
 * The ApiError for a response the server refused: what the fetch transport
 * throws for a status outside 2xx, for a custom Transport to throw too, so
 * its errors carry the same message, `kind` and `details` whichever
 * transport sent the request. `data` is the response body as read — the
 * parsed JSON when the server sent JSON, else the text. The message comes
 * from the shapes the endpoints send (rest-1's `exceptions`, api/asset's
 * `Exceptions`, a bare `message`, or the text itself), `HTTP <status>`
 * when the body says nothing; `details` is `data` unchanged.
 */
export function apiErrorFromResponse(status: number, data?: unknown): ApiError {
  return new ApiError(messageOf(data, status), status, undefined, data);
}

/**
 * A mistake in the call, caught before any request is sent: an unpaged
 * query, an empty batch, a string that is not an OID token. Nothing on the
 * server has happened; fix the call. (A TypeError would say the same, but
 * one `instanceof ApiError` then covers everything the SDK throws.)
 */
export class UsageError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(message, 0, "USAGE", details, "usage");
    this.name = "UsageError";
  }
}

/**
 * An error raised around another: a batch send that failed, an upload
 * that failed after the create. Its status and kind are the cause's when
 * the cause is an ApiError, so a caller still branches on `kind`.
 */
export class WrappedError extends ApiError {
  constructor(message: string, code: string, cause: unknown, details?: Record<string, unknown>) {
    const inner = cause instanceof ApiError ? cause : undefined;
    super(message, inner?.status ?? 0, code, { ...details, cause }, inner?.kind ?? "unknown");
    this.name = "WrappedError";
  }
}

import type { ApiError } from "./errors";
import type { FetchTransportConfig } from "./fetchTransport";
import type { RequestOptions } from "./transport";

export interface ClientConfig extends Pick<FetchTransportConfig, "credentials" | "onUnauthorized" | "unauthorizedStatuses"> {
  /**
   * The instance base URL: "https://agility.example.com/MyInstance". The
   * built-in fetch transport sends every request under it. With a custom
   * Transport (`new AgilityApiClient(config, { transport })`) the transport
   * alone decides where requests go, and `baseUrl` is used for one thing:
   * the links the client builds for a browser (`client.urls.*`,
   * `client.embeddedImages.normalize`). Give it the instance's public URL
   * even when the transport talks to a proxy.
   */
  baseUrl: string;
  /** A ready Authorization header value ("Basic …" for a dev instance). Wins over accessToken. */
  authorization?: string;
  /** An access token, sent as "Bearer <token>". */
  accessToken?: string;
  /**
   * How long one attempt may take, in milliseconds, whichever Transport
   * the client has. Default 60000. When it has passed, the request
   * rejects with an ApiError coded TIMEOUT (transient: an idempotent
   * request is then sent again, see `retries`). The client stops waiting
   * at the deadline whether or not a custom transport lets go of the
   * request: the transport is given a `signal` that fires then, and
   * whatever it answers afterwards is discarded. A timed-out write may
   * still have been applied. 0 means no timeout of the client's (a custom
   * transport's own timing then decides; one with a shorter timeout
   * always wins anyway).
   */
  timeoutMs?: number;
  /**
   * How many times an idempotent request (a GET, a query.v1 read, a
   * guarded batch with no creates) is sent again after a transient
   * failure: no answer, a timeout, a 5xx, a 429. Default 1; 0 turns it
   * off. It applies whichever Transport the client has: the built-in one
   * does it itself, and the client does it around a custom one. A plain
   * write is never resent, nor is a 401 or 403.
   */
  retries?: number;
  defaultHeaders?: Record<string, string>;
  /**
   * Told about every request that finally failed, after any resend: the
   * place for an app-wide error toast or a log line, with any Transport.
   * It observes; the error is still thrown to the caller, and what this
   * returns or throws changes nothing. (A failed command inside a batch
   * the server answered 200 is not a failed request: read the Outcome, or
   * pass `throwOnFailure` and catch.)
   */
  onError?: (error: ApiError, request: RequestOptions) => void;
}

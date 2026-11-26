import type { FetchTransportConfig } from "./fetchTransport";

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
  /** Per-attempt timeout of the built-in fetch transport. A custom Transport does its own timing. */
  timeoutMs?: number;
  /**
   * Resends of an idempotent request by the built-in fetch transport
   * (default 1). Retrying is the transport's job: with a custom Transport
   * this is not read, and nothing is resent unless that transport does it
   * (`RequestOptions.idempotent` tells it which requests may be).
   */
  retries?: number;
  defaultHeaders?: Record<string, string>;
}

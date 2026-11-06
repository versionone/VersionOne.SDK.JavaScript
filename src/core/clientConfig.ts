import type { FetchTransportConfig } from "./fetchTransport";

export interface ClientConfig extends Pick<FetchTransportConfig, "credentials" | "onUnauthorized" | "unauthorizedStatuses"> {
  /** The instance base URL: "https://www7.v1host.com/V1Production". */
  baseUrl: string;
  /** A ready Authorization header value ("Basic …" for a dev instance). Wins over accessToken. */
  authorization?: string;
  /** An access token, sent as "Bearer <token>". */
  accessToken?: string;
  timeoutMs?: number;
  retries?: number;
  defaultHeaders?: Record<string, string>;
}

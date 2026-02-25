export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  timeoutMs?: number;
  retries?: number;
  defaultHeaders?: Record<string, string>;
}
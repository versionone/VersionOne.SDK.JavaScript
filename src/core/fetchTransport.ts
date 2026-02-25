import { ApiError } from "./errors";
import type { RequestOptions, Transport } from "./transport";

export interface FetchTransportConfig {
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBase);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createFetchTransport(config: FetchTransportConfig): Transport {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const retries = config.retries ?? 0;

  return {
    async request<T>(options: RequestOptions): Promise<T> {
      const url = buildUrl(config.baseUrl, options.path, options.query);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...config.defaultHeaders,
        ...options.headers
      };

      if (config.apiKey) {
        headers["x-api-key"] = config.apiKey;
      }

      if (config.accessToken) {
        headers.authorization = `Bearer ${config.accessToken}`;
      }

      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetchImpl(url, {
            method: options.method,
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal
          });

          clearTimeout(timeoutId);
          const data = await parseResponseBody(response);

          if (!response.ok) {
            const details = typeof data === "object" ? data : { message: data };
            const message =
              typeof details === "object" && details && "message" in details
                ? String((details as { message?: unknown }).message ?? "API request failed")
                : "API request failed";

            throw new ApiError(message, response.status, undefined, details);
          }

          return data as T;
        } catch (error) {
          clearTimeout(timeoutId);
          lastError = error;
          if (attempt < retries) {
            await delay(150 * (attempt + 1));
            continue;
          }
        }
      }

      if (lastError instanceof ApiError) {
        throw lastError;
      }

      if (lastError instanceof Error) {
        throw new ApiError(lastError.message, 0, "NETWORK_ERROR", { cause: lastError });
      }

      throw new ApiError("Unknown transport error", 0, "UNKNOWN_ERROR", { cause: lastError });
    }
  };
}
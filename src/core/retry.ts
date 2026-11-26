import { ApiError } from "./errors";
import type { RequestOptions, Transport } from "./transport";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The resend rule, for any Transport: an idempotent request (a GET, or one
 * the caller marked — a query.v1 read, a guarded batch with no creates)
 * that fails with a transient error (no answer, a timeout, a 5xx, a 429)
 * is sent again, `retries` times at most, a little later each time.
 * Nothing else is: not a plain write, whatever happened to it; not a 401
 * or 403 (re-authentication is the unauthorized hook's business, and a
 * resend would prompt twice); not any other 4xx, which is an answer; not a
 * request its caller aborted.
 *
 * The client puts this around a custom Transport, so the rule is the
 * client's and not each transport's to re-implement. The built-in fetch
 * transport applies the same rule itself (it can also read Retry-After)
 * and is not wrapped again.
 */
export function withRetry(transport: Transport, retries: number): Transport {
  const extra = Math.max(0, retries);
  if (!extra) return transport;
  return {
    async request<T>(options: RequestOptions): Promise<T> {
      const idempotent = options.idempotent ?? options.method === "GET";
      const attempts = idempotent ? extra + 1 : 1;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await transport.request<T>(options);
        } catch (error) {
          const again = attempt + 1 < attempts && error instanceof ApiError && error.kind === "transient" && !options.signal?.aborted;
          if (!again) throw error;
          await delay(150 * (attempt + 1));
        }
      }
    }
  };
}

/**
 * A Transport that tells `onError` about every request that finally
 * failed (after any resend), and then fails as before. Observation only:
 * what the hook returns or throws changes nothing.
 */
export function withErrorHook(transport: Transport, onError: (error: ApiError, request: RequestOptions) => void): Transport {
  return {
    async request<T>(options: RequestOptions): Promise<T> {
      try {
        return await transport.request<T>(options);
      } catch (error) {
        if (error instanceof ApiError) { try { onError(error, options); } catch { /* an observer cannot break the request */ } }
        throw error;
      }
    }
  };
}

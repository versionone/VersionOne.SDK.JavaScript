import { ApiError } from "./errors";
import type { RequestOptions, Transport } from "./transport";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long one attempt may take when the client is not told otherwise. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const timedOut = (ms: number): ApiError => new ApiError(`Timed out after ${ms} ms`, 0, "TIMEOUT");
const abortedBy = (signal: AbortSignal): ApiError => new ApiError("Request aborted", 0, "ABORTED", { cause: signal.reason });

/**
 * One attempt's deadline: a signal that fires when the caller aborts or
 * when `timeoutMs` has passed, whichever is first, and which of the two
 * it was. `timeoutMs` of 0 (or less) is no deadline: the signal is then
 * the caller's own. Call `clear` when the attempt has settled.
 */
export function deadline(timeoutMs: number, caller?: AbortSignal): { signal: AbortSignal | undefined; expired: () => boolean; onExpire: (run: () => void) => void; clear: () => void } {
  if (!(timeoutMs > 0)) return { signal: caller, expired: () => false, onExpire: () => {}, clear: () => {} };
  const controller = new AbortController();
  let expired = false;
  let listener: (() => void) | undefined;
  const timer = setTimeout(() => { expired = true; listener?.(); controller.abort(timedOut(timeoutMs)); }, timeoutMs);
  const onAbort = () => controller.abort(caller!.reason);
  if (caller?.aborted) onAbort(); else caller?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    expired: () => expired,
    onExpire: (run) => { listener = run; },
    clear: () => { clearTimeout(timer); caller?.removeEventListener("abort", onAbort); }
  };
}

/**
 * The timeout rule, for any Transport: each attempt gets `timeoutMs`, and
 * when it has passed the request rejects with an ApiError coded TIMEOUT
 * (a transient failure, so the resend rule sends an idempotent request
 * again). `timeoutMs` of 0 means no timeout of the client's: the transport
 * alone decides.
 *
 * The transport is handed a `signal` that fires at the deadline (and when
 * the caller aborts), and honouring `signal` is all a transport owes. But
 * the caller is not left to depend on that: the request rejects AT the
 * deadline whether or not the transport lets go. A transport that ignores
 * the signal keeps its request open on its own; whatever it answers later
 * is discarded, and an error it throws later is swallowed. So TIMEOUT
 * means "the client stopped waiting", never "the server did not act": a
 * write that timed out may still have been applied, which is why a write
 * is not resent.
 *
 * A transport with a shorter timeout of its own rejects first, and its
 * error is the one the caller sees. A caller's abort is ABORTED, not
 * TIMEOUT, and is likewise not waited on.
 */
export function withTimeout(transport: Transport, timeoutMs: number): Transport {
  if (!(timeoutMs > 0)) return transport;
  return {
    request<T>(options: RequestOptions): Promise<T> {
      const caller = options.signal;
      if (caller?.aborted) return Promise.reject(abortedBy(caller));
      const limit = deadline(timeoutMs, caller);
      return new Promise<T>((resolve, reject) => {
        const onCallerAbort = () => reject(abortedBy(caller!));
        caller?.addEventListener("abort", onCallerAbort, { once: true });
        const settle = () => { limit.clear(); caller?.removeEventListener("abort", onCallerAbort); };
        // Rejected here, at the deadline, before the signal is even seen by the transport.
        limit.onExpire(() => { settle(); reject(timedOut(timeoutMs)); });
        // After a rejection above these are no-ops: a late answer is ignored and a late error does not surface.
        transport.request<T>({ ...options, signal: limit.signal }).then(
          (value) => { settle(); resolve(value); },
          (error: unknown) => { settle(); reject(error); }
        );
      });
    }
  };
}

/**
 * May a request that failed this way be sent again by the SDK? Only when
 * the failure says the server never took the request up, or took it up and
 * fell over: no connection (NETWORK_ERROR), a 429, a 5xx.
 *
 * Not after a timeout, of the client's (TIMEOUT) or of the server's or a
 * gateway's (408, 504, or the server's own SQL execution timeout, which
 * arrives as an error document and is coded SERVER_TIMEOUT). A timeout ends the wait; it does not stop the
 * work. The request may still be running on the server, and a request that
 * ran out of time is likely one that costs a lot: sending it again runs
 * the cost twice and keeps the caller waiting twice as long.
 */
export function resendable(error: unknown): boolean {
  return error instanceof ApiError && error.kind === "transient" && error.code !== "TIMEOUT" && error.code !== "SERVER_TIMEOUT" && error.status !== 408 && error.status !== 504;
}

/**
 * The resend rule, for any Transport: an idempotent request (a GET, or one
 * the caller marked: a query.v1 read; never a write, guarded or not)
 * that fails because it never reached the server or the server fell over
 * (no connection, a 5xx other than 504, a 429) is sent again, `retries`
 * times at most, a little later each time. Nothing else is: not a plain
 * write, whatever happened to it; not a request that timed out, here or on
 * the server (see `resendable`); not a 401 or 403 (re-authentication is
 * the unauthorized hook's business, and a resend would prompt twice); not
 * any other 4xx, which is an answer; not a request its caller aborted.
 *
 * The client puts this around a custom Transport (outside the timeout
 * rule, so each attempt has its own deadline), so the rule is the client's
 * and not each transport's to re-implement. The built-in fetch transport
 * applies the same rule itself (it can also read Retry-After) and is not
 * wrapped again.
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
          const again = attempt + 1 < attempts && resendable(error) && !options.signal?.aborted;
          if (!again) throw error;
          await delay(150 * (attempt + 1));
        }
      }
    }
  };
}

/**
 * A Transport whose errors say what was asked: every ApiError that comes
 * out carries `request` (method, path, whether it was safe to send twice).
 * It is what lets an explanation tell a read that failed from a write
 * whose fate is unknown.
 */
export function withRequestStamp(transport: Transport): Transport {
  return {
    async request<T>(options: RequestOptions): Promise<T> {
      try {
        return await transport.request<T>(options);
      } catch (error) {
        if (error instanceof ApiError && !error.request) error.request = { method: options.method, path: options.path.split("?")[0]!, idempotent: options.idempotent ?? options.method === "GET" };
        throw error;
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

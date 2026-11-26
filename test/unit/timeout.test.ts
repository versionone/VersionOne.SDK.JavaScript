import { describe, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError } from "../../src/core/errors";
import { createFetchTransport } from "../../src/core/fetchTransport";
import type { RequestOptions, Transport } from "../../src/core/transport";

/**
 * The timeout rule belongs to the client, so `timeoutMs` means the same
 * with a consumer's own Transport: each attempt has that long, the caller
 * gets TIMEOUT at the deadline whatever the transport does, and the resend
 * rule sees it as the transient failure it is. Real (short) timers: the
 * point is what happens at a deadline.
 */
const later = <T,>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const aborted = (signal: AbortSignal) => new ApiError("Request aborted", 0, "ABORTED", { cause: signal.reason });

/** A transport as a well-behaved one is: `attempt` decides how long each try takes, and its signal ends the wait. */
function honouring(attempt: (n: number, o: RequestOptions) => Promise<unknown>): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  return {
    calls,
    request: ((o: RequestOptions) => {
      calls.push(o);
      return new Promise((resolve, reject) => {
        o.signal?.addEventListener("abort", () => reject(aborted(o.signal!)), { once: true });
        attempt(calls.length, o).then(resolve as (value: unknown) => void, reject);
      });
    }) as Transport["request"]
  };
}
const never = new Promise<never>(() => {});
const clientOn = (transport: Transport, config: { timeoutMs?: number; retries?: number } = {}) => new AgilityApiClient({ baseUrl: "https://agility.example.com/I", ...config }, { transport }).transport;
const read: RequestOptions = { method: "GET", path: "/loc-2.v1" };
const write: RequestOptions = { method: "POST", path: "/api/asset", body: [{ from: "Story:1", update: { Name: "x" } }] };

describe("the timeout rule above a custom Transport", () => {
  it("an attempt that takes longer than timeoutMs is a TIMEOUT, and an idempotent request is then sent once more, with a deadline of its own", async () => {
    const t = honouring((n) => (n === 1 ? never : later(5, { ok: true })));
    expect(await clientOn(t, { timeoutMs: 30 }).request(read)).toEqual({ ok: true });
    expect(t.calls).toHaveLength(2);
    // The first attempt was told to stop; the second got a fresh signal.
    expect([t.calls[0]!.signal!.aborted, t.calls[1]!.signal!.aborted]).toEqual([true, false]);
    // Every attempt slow: the caller gets the TIMEOUT, a transient failure, after the one resend.
    const slow = honouring(() => never);
    await expect(clientOn(slow, { timeoutMs: 20 }).request(read)).rejects.toMatchObject({ code: "TIMEOUT", status: 0, kind: "transient", message: "Timed out after 20 ms" });
    expect(slow.calls).toHaveLength(2);
  });

  it("a plain write that times out is not sent again: the client stopped waiting, which says nothing about whether the server acted", async () => {
    const t = honouring(() => never);
    await expect(clientOn(t, { timeoutMs: 20, retries: 3 }).request(write)).rejects.toMatchObject({ code: "TIMEOUT", kind: "transient" });
    expect(t.calls).toHaveLength(1);
  });

  it("a transport that ignores the signal still yields TIMEOUT at the deadline; what it answers or throws afterwards is discarded", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Deaf to its signal: one answers late, one fails late.
      for (const afterwards of [() => later(60, { late: true }), () => later(60, null).then(() => { throw new ApiError("socket hang up", 0, "NETWORK_ERROR"); })]) {
        const calls: RequestOptions[] = [];
        const deaf: Transport = { request: ((o: RequestOptions) => { calls.push(o); return afterwards(); }) as Transport["request"] };
        const started = Date.now();
        const error = await clientOn(deaf, { timeoutMs: 20, retries: 0 }).request(write).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "TIMEOUT", status: 0 });
        expect(Date.now() - started).toBeLessThan(55); // at the deadline, not when the transport got round to it
        expect(calls).toHaveLength(1);
      }
      await later(90, null); // let the late answer and the late error arrive
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("timeoutMs: 0 is no timeout of the client's: the request waits, and the transport is handed the caller's own signal", async () => {
    const t = honouring(() => later(70, { ok: true }));
    expect(await clientOn(t, { timeoutMs: 0 }).request(read)).toEqual({ ok: true });
    expect(t.calls[0]!.signal).toBeUndefined();
    const controller = new AbortController();
    await clientOn(t, { timeoutMs: 0 }).request({ ...read, signal: controller.signal });
    expect(t.calls[1]!.signal).toBe(controller.signal);
    // The control: the same transport under a 20 ms deadline times out.
    await expect(clientOn(honouring(() => later(70, { ok: true })), { timeoutMs: 20, retries: 0 }).request(read)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("a transport's own shorter timeout wins: its error is the one the caller sees", async () => {
    const own = new ApiError("timeout of 10ms exceeded", 0, "TIMEOUT");
    const t = honouring(() => later(10, null).then(() => { throw own; }));
    expect(await clientOn(t, { timeoutMs: 200, retries: 0 }).request(write).catch((e: unknown) => e)).toBe(own);
  });

  it("the caller's abort is ABORTED, not TIMEOUT: before sending, in flight, and even when the transport ignores the signal; it is never resent", async () => {
    const before = new AbortController();
    before.abort();
    const t = honouring(() => never);
    await expect(clientOn(t, { timeoutMs: 50 }).request({ ...read, signal: before.signal })).rejects.toMatchObject({ code: "ABORTED", kind: "aborted" });
    expect(t.calls).toHaveLength(0);
    const during = new AbortController();
    setTimeout(() => during.abort(), 10);
    await expect(clientOn(t, { timeoutMs: 200 }).request({ ...read, signal: during.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(t.calls).toHaveLength(1);
    const deaf: Transport = { request: (() => never) as Transport["request"] };
    const ignored = new AbortController();
    setTimeout(() => ignored.abort(), 10);
    const started = Date.now();
    await expect(clientOn(deaf, { timeoutMs: 200 }).request({ ...read, signal: ignored.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(Date.now() - started).toBeLessThan(150);
  });
});

describe("the built-in transport under the same rule", () => {
  it("times out an attempt by the same deadline, covers the body as well as the headers, and timeoutMs: 0 waits", async () => {
    const hanging = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) as unknown) as typeof fetch;
    await expect(createFetchTransport({ baseUrl: "https://x", timeoutMs: 20, retries: 0, fetchImpl: hanging }).request(read)).rejects.toMatchObject({ code: "TIMEOUT", message: "Timed out after 20 ms" });
    // Headers at once, the body never: still a TIMEOUT, not a raw stream error.
    const stalled = (async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(createFetchTransport({ baseUrl: "https://x", timeoutMs: 20, retries: 0, fetchImpl: stalled }).request(read)).rejects.toMatchObject({ code: "TIMEOUT" });
    const slow = (async () => { await later(60, null); return new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    expect(await createFetchTransport({ baseUrl: "https://x", timeoutMs: 0, retries: 0, fetchImpl: slow }).request(read)).toEqual({ ok: true });
  });
});

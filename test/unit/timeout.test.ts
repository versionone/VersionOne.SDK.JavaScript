import { describe, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError, apiErrorFromResponse } from "../../src/core/errors";
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
  it("an attempt that takes longer than timeoutMs is a TIMEOUT, and it is not sent again, a read included: the first one may still be running", async () => {
    const slow = honouring((n) => (n === 1 ? never : later(5, { ok: true })));
    await expect(clientOn(slow, { timeoutMs: 20, retries: 3 }).request(read)).rejects.toMatchObject({ code: "TIMEOUT", status: 0, kind: "transient", message: "Timed out after 20 ms", request: { method: "GET", path: "/loc-2.v1", idempotent: true } });
    expect(slow.calls).toHaveLength(1);
    // The attempt was told to stop.
    expect(slow.calls[0]!.signal!.aborted).toBe(true);
    // A lost connection is another matter (the request never arrived): that read is sent once more, with a deadline of its own.
    const dropped = honouring((n) => (n === 1 ? Promise.reject(new ApiError("fetch failed", 0, "NETWORK_ERROR")) : later(5, { ok: true })));
    expect(await clientOn(dropped, { timeoutMs: 50 }).request(read)).toEqual({ ok: true });
    expect(dropped.calls).toHaveLength(2);
    expect(dropped.calls[1]!.signal!.aborted).toBe(false);
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

  it("a person's time is not on the clock: the re-authentication hook runs outside the deadline, however long the sign-in takes", async () => {
    const answers = [new Response("Unauthorized", { status: 401 }), new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } })];
    const fetchImpl = (async () => answers.shift()!) as unknown as typeof fetch;
    // The hook takes three times the timeout, as someone typing a password would.
    const transport = createFetchTransport({ baseUrl: "https://x", timeoutMs: 20, retries: 0, fetchImpl, onUnauthorized: async () => { await later(60, null); return "retry" as const; } });
    expect(await transport.request(read)).toEqual({ ok: true });
  });
});

describe("what to tell a person when a request got no answer", () => {
  it("a read the server itself gave up on (its SQL execution timeout) is not 'wait and try again': the same request costs the same, so ask for less; a write keeps the sentence about the change", async () => {
    const gaveUp = () => apiErrorFromResponse(500, { error: "Server Error", exceptions: [{ type: "SqlException", message: "Execution Timeout Expired.  The timeout period elapsed prior to completion of the operation or the server is not responding." }, { type: "Win32Exception", message: "The wait operation timed out" }] });
    for (const request of [read, guarded]) {
      expect(await say(gaveUp, request)).toMatchObject({ audience: "user", retrySafe: false, sentence: "Agility gave up on this request: it takes more work than the server allows. Sending it again will cost the same. Ask for less: a smaller page, fewer selected paths, a tighter filter." });
    }
    expect(await say(gaveUp, write)).toMatchObject({ retrySafe: false, sentence: "Agility did not confirm the change. It may or may not have been made: check before trying again." });
    // With no stamp (a /wire function on a bare transport): what is known, and no advice about a query it may not have been.
    const [bare] = await new AgilityApiClient({ baseUrl: "https://agility.example.com/I" }, { transport: failing(gaveUp()) }).explain(gaveUp());
    expect(bare).toMatchObject({ audience: "user", retrySafe: null, sentence: "Agility gave up on this request: it takes more work than the server allows." });
  });

  const failing = (failure: ApiError): Transport => ({ request: (() => Promise.reject(failure)) as Transport["request"] });
  const say = async (failure: () => ApiError, request: RequestOptions) => {
    const client = new AgilityApiClient({ baseUrl: "https://agility.example.com/I", retries: 0 }, { transport: failing(failure()) });
    const error = await client.transport.request(request).catch((e: unknown) => e);
    const [said] = await client.explain(error);
    return { stamp: (error as ApiError).request, sentence: said!.sentence, retrySafe: said!.retrySafe, audience: said!.audience };
  };
  const guarded: RequestOptions = { ...write, idempotent: true };
  const timeout = () => new ApiError("Timed out after 60000 ms", 0, "TIMEOUT");
  const dropped = () => new ApiError("fetch failed", 0, "NETWORK_ERROR");

  it("a write that got no answer, or a server failure for one, is never 'try again': the change may or may not have been made, and retrySafe is false", async () => {
    for (const failure of [timeout, dropped, () => new ApiError("Bad Gateway", 502), () => new ApiError("Internal Server Error", 500), () => new ApiError("Gateway Timeout", 504)]) {
      expect(await say(failure, write)).toEqual({ stamp: { method: "POST", path: "/api/asset", idempotent: false }, audience: "user", retrySafe: false, sentence: "Agility did not confirm the change. It may or may not have been made: check before trying again." });
    }
  });

  it("a read, or a guarded batch, that timed out is safe to repeat but may still be running; one that never got through may work in a moment", async () => {
    for (const request of [read, guarded]) {
      for (const failure of [timeout, () => new ApiError("Gateway Timeout", 504), () => new ApiError("Request Timeout", 408)]) {
        expect(await say(failure, request)).toMatchObject({ retrySafe: true, sentence: "Agility did not answer in time. The request may still be running: wait before trying again." });
      }
      for (const failure of [dropped, () => new ApiError("Service Unavailable", 503)]) {
        expect(await say(failure, request)).toMatchObject({ retrySafe: true, sentence: "Agility could not be reached, or is busy. The same request may work in a moment." });
      }
    }
  });

  it("a 429 was turned away before any work, so even a write is safe to send again; an error that does not say what was asked gets only what is known", async () => {
    expect(await say(() => new ApiError("Too Many Requests", 429), write)).toMatchObject({ retrySafe: true, sentence: "Agility is busy. The same request may work in a moment." });
    // An error from a function of /wire on a transport no client wrapped carries no stamp.
    const client = new AgilityApiClient({ baseUrl: "https://agility.example.com/I" }, { transport: failing(timeout()) });
    const [bare] = await client.explain(timeout());
    expect(bare).toMatchObject({ retrySafe: null, audience: "user", sentence: "Agility could not be reached, or is busy." });
    // The stamp never carries the body or the headers.
    const stamped = await client.transport.request({ ...write, headers: { authorization: "Bearer secret" } }).catch((e: unknown) => e) as ApiError;
    expect(Object.keys(stamped.request!).sort()).toEqual(["idempotent", "method", "path"]);
    // And the question does not arise for an answered refusal.
    expect((await client.explain([{ index: 0, message: "Violation'Required'Story.Scope", command: {} } as never]))[0]!.retrySafe).toBeNull();
  });
});

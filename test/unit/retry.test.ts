import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError } from "../../src/core/errors";
import { createFetchTransport } from "../../src/core/fetchTransport";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { FakeAgilityClient } from "../../src/testing";

/**
 * The resend rule belongs to the client, so it holds with a consumer's
 * own Transport: an idempotent request is sent once more after a
 * transient failure, and nothing else is ever resent.
 */
function custom(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (o: RequestOptions) => { calls.push(o); const a = answers.shift(); if (a instanceof Error) throw a; return a; });
  return { request: request as Transport["request"], calls };
}
const envelope = { requestId: "r", assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: ["Story:1"], count: 1 }, assetsOperatedOn: { oidTokens: [], count: 0 }, commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: 0 } };
const noTypes = (t: Transport): Transport => ({ request: (o) => (o.path.startsWith("/meta.v1/") ? Promise.reject(new ApiError("Not Found", 404)) : t.request(o)) });
const q = { from: "Story", select: ["Name"], page: { size: 1, start: 0 } };

describe("the resend rule above a custom Transport", () => {
  it("a read is sent once more after a 5xx, a lost connection or a timeout, by default", async () => {
    for (const failure of [new ApiError("Bad Gateway", 502), new ApiError("fetch failed", 0, "NETWORK_ERROR"), new ApiError("Timed out", 0, "TIMEOUT"), new ApiError("Too Many Requests", 429)]) {
      const t = custom(failure, [[{ _oid: "Story:1", Name: "n" }]]);
      const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: noTypes(t) });
      expect(await client.query(q)).toEqual([{ _oid: "Story:1", Name: "n" }]);
      expect(t.calls).toHaveLength(2);
    }
  });

  it("once, not forever; `retries` says how many times, and 0 turns it off", async () => {
    const down = () => new ApiError("Service Unavailable", 503);
    const once = custom(down(), down(), [[]]);
    await expect(new AgilityApiClient({ baseUrl: "https://x" }, { transport: noTypes(once) }).query(q)).rejects.toMatchObject({ status: 503 });
    expect(once.calls).toHaveLength(2);
    const twice = custom(down(), down(), [[]]);
    expect(await new AgilityApiClient({ baseUrl: "https://x", retries: 2 }, { transport: noTypes(twice) }).query(q)).toEqual([]);
    const off = custom(down(), [[]]);
    await expect(new AgilityApiClient({ baseUrl: "https://x", retries: 0 }, { transport: noTypes(off) }).query(q)).rejects.toMatchObject({ status: 503 });
    expect(off.calls).toHaveLength(1);
  });

  it("a plain write is never resent, whatever happened to it; a guarded one with no creates may be", async () => {
    const write = custom(new ApiError("Bad Gateway", 502), envelope);
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: write });
    await expect(client.send([{ from: "Story:1", update: { Name: "x" } }])).rejects.toMatchObject({ status: 502 });
    expect(write.calls).toHaveLength(1);
    // preview, the Moment read, then the guarded send: it fails once and is sent again, because a resend of it matches nothing if the first one landed.
    const guarded = custom([{ "@p": { oid: "Story:1", update: { Name: "x" } } }], { ...envelope, assetsModified: { oidTokens: [], count: 0 }, queryResult: { results: [[{ _oid: "Story:1", Moment: "7" }]], resultMetaData: [], count: 1 } }, new ApiError("Bad Gateway", 502), envelope);
    const result = await new AgilityApiClient({ baseUrl: "https://x" }, { transport: guarded }).sendGuarded([{ from: "Story:1", update: { Name: "x" } }]);
    expect(result).toMatchObject({ modified: ["Story:1"], conflicts: [] });
    expect(guarded.calls).toHaveLength(4);
  });

  it("a 401 or 403 is never resent (re-authentication is the unauthorized hook's business), nor any other 4xx, nor an aborted request", async () => {
    for (const refusal of [new ApiError("Unauthorized", 401), new ApiError("Forbidden", 403), new ApiError("Bad Request", 400), new ApiError("Request aborted", 0, "ABORTED")]) {
      const t = custom(refusal, [[]]);
      await expect(new AgilityApiClient({ baseUrl: "https://x" }, { transport: noTypes(t) }).query(q)).rejects.toBe(refusal);
      expect(t.calls).toHaveLength(1);
    }
  });

  it("withSignal does not stack a second resend on the first, and the fake resends nothing unless asked", async () => {
    const t = custom(new ApiError("down", 503), new ApiError("down", 503), [[]]);
    const scoped = new AgilityApiClient({ baseUrl: "https://x" }, { transport: noTypes(t) }).withSignal(new AbortController().signal);
    await expect(scoped.query(q)).rejects.toMatchObject({ status: 503 });
    expect(t.calls).toHaveLength(2);
    const fake = new FakeAgilityClient().onQuery("Story", new ApiError("down", 503));
    await expect(fake.query(q)).rejects.toMatchObject({ kind: "transient" });
    expect(fake.asked).toHaveLength(1);
  });
});

describe("onError and reauthorize", () => {
  it("onError is told once about a request that finally failed, with any transport, and the error is still thrown; a throwing observer changes nothing", async () => {
    const seen: [string, string][] = [];
    const t = custom(new ApiError("down", 503), new ApiError("still down", 503), [[{ _oid: "Story:1" }]]);
    const client = new AgilityApiClient({ baseUrl: "https://x", onError: (error, request) => { seen.push([error.message, request.path]); throw new Error("observer bug"); } }, { transport: noTypes(t) });
    await expect(client.query(q)).rejects.toMatchObject({ message: "still down" });
    expect(seen).toEqual([["Not Found", "/meta.v1/Story"], ["still down", "/query.v1"]]); // the failed type load is a failed request too; the resend that failed is reported once, with the final error
    expect(await client.query(q)).toEqual([{ _oid: "Story:1" }]);
    expect(seen).toHaveLength(2);
    // With the built-in transport as well.
    const fetched: string[] = [];
    const builtIn = new AgilityApiClient({ baseUrl: "https://x", retries: 0, onError: (e) => fetched.push(e.kind) });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
    try { await expect(builtIn.localize(["Story"])).rejects.toMatchObject({ kind: "forbidden" }); } finally { globalThis.fetch = original; }
    expect(fetched).toEqual(["forbidden"]);
  });

  it("a request sent with reauthorize: false is refused straight away, without calling the re-authentication hook it may have been sent from", async () => {
    const onUnauthorized = vi.fn(async () => "retry" as const);
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const transport = createFetchTransport({ baseUrl: "https://x", retries: 0, fetchImpl: fetchImpl as unknown as typeof fetch, onUnauthorized });
    await expect(transport.request({ method: "GET", path: "/session", reauthorize: false })).rejects.toMatchObject({ kind: "auth" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
    // The control: without it the hook runs and its "retry" sends the request once more.
    await expect(transport.request({ method: "GET", path: "/session" })).rejects.toMatchObject({ kind: "auth" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("a plain write refused as unauthorized is resent once only when the hook answers retry-write: not on retry, not for another status, never twice", async () => {
    const run = async (statuses: number[], decision: "retry" | "retry-write" | "fail", options: { unauthorizedStatuses?: number[]; reauthorize?: boolean } = {}) => {
      const answers = [...statuses];
      const fetchImpl = vi.fn(async () => { const status = answers.shift() ?? 200; return new Response(status === 200 ? JSON.stringify({ ok: true }) : "Forbidden", { status, headers: { "content-type": status === 200 ? "application/json" : "text/plain" } }); });
      const onUnauthorized = vi.fn(async () => decision);
      const transport = createFetchTransport({ baseUrl: "https://x", retries: 3, fetchImpl: fetchImpl as unknown as typeof fetch, onUnauthorized, unauthorizedStatuses: options.unauthorizedStatuses ?? [401, 403] });
      const result = await transport.request({ method: "POST", path: "/api/asset", body: [{ from: "Story:1", update: { Name: "x" } }], responseType: "json", reauthorize: options.reauthorize }).catch((e: unknown) => e);
      return { result, sends: fetchImpl.mock.calls.length, hooks: onUnauthorized.mock.calls.length, retryable: (onUnauthorized.mock.calls as unknown as [{ retryable: boolean }][])[0]?.[0].retryable };
    };
    // The session had expired: the hook re-authenticated and vouches that the refusal ran nothing.
    expect(await run([403], "retry-write")).toMatchObject({ result: { ok: true }, sends: 2, hooks: 1, retryable: false });
    // "retry" keeps its meaning: a plain write is not resent.
    expect(await run([403], "retry")).toMatchObject({ result: { kind: "forbidden" }, sends: 1, hooks: 1 });
    expect(await run([403], "fail")).toMatchObject({ result: { kind: "forbidden" }, sends: 1, hooks: 1 });
    // Only for a status the transport treats as "not signed in"; a 5xx on a write is never resent, whatever `retries` says.
    expect(await run([403], "retry-write", { unauthorizedStatuses: [401] })).toMatchObject({ result: { kind: "forbidden" }, sends: 1, hooks: 0 });
    expect(await run([502], "retry-write")).toMatchObject({ result: { kind: "transient" }, sends: 1, hooks: 0 });
    // Never twice: a second refusal is final, and the hook is not asked again.
    expect(await run([403, 403], "retry-write")).toMatchObject({ result: { kind: "forbidden" }, sends: 2, hooks: 1 });
    // And a request sent with reauthorize: false never reaches the hook.
    expect(await run([403], "retry-write", { reauthorize: false })).toMatchObject({ result: { kind: "forbidden" }, sends: 1, hooks: 0 });
  });
});

import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError } from "../../src/core/errors";
import { createFetchTransport } from "../../src/core/fetchTransport";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const unauthorized = () => json({ _type: "Error", error: "Unauthorized" }, 401);

// A1: what a browser app (rooms) and a re-authenticating bot need from the transport.
describe("transport for real callers", () => {
  it("passes fetch a credentials mode only when one is configured", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(json({})));
    await createFetchTransport({ baseUrl: "https://x", fetchImpl, credentials: "same-origin", defaultHeaders: { "X-Requested-With": "XMLHttpRequest" } }).request({ method: "GET", path: "/a" });
    await createFetchTransport({ baseUrl: "https://x", fetchImpl }).request({ method: "GET", path: "/a" });
    expect(fetchImpl.mock.calls[0]![1].credentials).toBe("same-origin");
    expect(fetchImpl.mock.calls[0]![1].headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect("credentials" in fetchImpl.mock.calls[1]![1]).toBe(false);
  });

  it("calls onUnauthorized on a 401 and resends a GET once when it says retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json({ ok: true }));
    const onUnauthorized = vi.fn().mockResolvedValue("retry");
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl, onUnauthorized });
    expect(await transport.request({ method: "GET", path: "/a" })).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const [context] = onUnauthorized.mock.calls[0]!;
    expect(context.error).toBeInstanceOf(ApiError);
    expect(context.error.status).toBe(401);
    expect(context.retryable).toBe(true);
    expect(context.request.path).toBe("/a");
  });

  it("re-authenticates once per request: a second 401 is final, and 'fail' throws the first", async () => {
    const twice = vi.fn().mockImplementation(() => Promise.resolve(unauthorized()));
    const retry = vi.fn().mockReturnValue("retry");
    await expect(createFetchTransport({ baseUrl: "https://x", fetchImpl: twice, onUnauthorized: retry }).request({ method: "GET", path: "/a" })).rejects.toMatchObject({ status: 401 });
    expect(twice).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledTimes(1);

    const once = vi.fn().mockImplementation(() => Promise.resolve(unauthorized()));
    await expect(createFetchTransport({ baseUrl: "https://x", fetchImpl: once, onUnauthorized: () => "fail" }).request({ method: "GET", path: "/a" })).rejects.toMatchObject({ status: 401 });
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("never resends a plain api/asset write after a 401, but still lets the hook repair the session", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(unauthorized()));
    const onUnauthorized = vi.fn().mockResolvedValue("retry");
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl, onUnauthorized });
    await expect(transport.request({ method: "POST", path: "/api/asset", body: [] })).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onUnauthorized.mock.calls[0]![0].retryable).toBe(false);
    // A guarded (idempotent) write may be resent.
    const guarded = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json({}));
    await createFetchTransport({ baseUrl: "https://x", fetchImpl: guarded, onUnauthorized }).request({ method: "POST", path: "/api/asset", body: [], idempotent: true });
    expect(guarded).toHaveBeenCalledTimes(2);
  });

  it("does not count a re-authenticated retry against `retries`, and honours unauthorizedStatuses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({ error: "boom" }, 503))
      .mockResolvedValueOnce(json({ ok: 1 }));
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl, retries: 1, onUnauthorized: () => "retry", unauthorizedStatuses: [401, 403] });
    expect(await transport.request({ method: "GET", path: "/a" })).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // 403 is an answer, not a login prompt, unless the caller says so.
    const hook = vi.fn();
    await expect(createFetchTransport({ baseUrl: "https://x", fetchImpl: vi.fn().mockResolvedValue(json({}, 403)), onUnauthorized: hook }).request({ method: "GET", path: "/a" })).rejects.toMatchObject({ status: 403 });
    expect(hook).not.toHaveBeenCalled();
  });

  it("ends a request the caller aborts with ABORTED and never retries it", async () => {
    const hang = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl: hang, retries: 3 });
    const controller = new AbortController();
    const pending = transport.request({ method: "GET", path: "/slow", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED", status: 0 });
    expect(hang).toHaveBeenCalledTimes(1);
    // Already aborted: nothing is sent.
    const idle = vi.fn();
    await expect(createFetchTransport({ baseUrl: "https://x", fetchImpl: idle }).request({ method: "GET", path: "/a", signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(idle).not.toHaveBeenCalled();
  });

  it("client.withSignal ties every request to the signal and shares the schema", async () => {
    const transport = { request: vi.fn().mockResolvedValue({ Story: "Story" }) };
    const base = new AgilityApiClient({ baseUrl: "https://x" }, { transport });
    const controller = new AbortController();
    const scoped = base.withSignal(controller.signal);
    expect(scoped.schema).toBe(base.schema);
    await scoped.localize(["Story"]);
    expect(transport.request.mock.calls[0]![0].signal).toBe(controller.signal);
    // The original client is untouched.
    await base.localize(["Story"]);
    expect(transport.request.mock.calls[1]![0].signal).toBeUndefined();
  });

  it("the client passes credentials and onUnauthorized through to its fetch transport", async () => {
    const original = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(json({ Story: "Story" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const onUnauthorized = vi.fn().mockResolvedValue("retry");
      const client = new AgilityApiClient({ baseUrl: "https://x", credentials: "include", onUnauthorized });
      await client.localize(["Story"]);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[1]![1].credentials).toBe("include");
    } finally {
      globalThis.fetch = original;
    }
  });
});

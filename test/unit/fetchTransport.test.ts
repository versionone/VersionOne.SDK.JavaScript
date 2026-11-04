import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/errors";
import { createFetchTransport } from "../../src/core/fetchTransport";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

describe("createFetchTransport", () => {
  it("sends a GET with no content type, an Accept for JSON, the authorization it was given, and parses JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ ok: true }));
    const transport = createFetchTransport({ baseUrl: "https://api.example.com/V1Production", authorization: "Basic YWRtaW46YWRtaW4=", fetchImpl });
    const result = await transport.request<{ ok: boolean }>({ method: "GET", path: "/rest-1.v1/Data/Story", query: { sel: "Name", page: "5,0", skip: undefined } });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/V1Production/rest-1.v1/Data/Story?sel=Name&page=5%2C0");
    expect(init.headers["content-type"]).toBeUndefined();
    expect(init.headers.accept).toBe("application/json");
    expect(init.headers.authorization).toBe("Basic YWRtaW46YWRtaW4=");
    expect(init.body).toBeUndefined();
  });

  it("formats an access token as Bearer, sends an object as JSON, a string with its content type, and bytes as octet-stream", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(json({}))); // a fresh Response per call: a body reads once
    const transport = createFetchTransport({ baseUrl: "https://api.example.com", accessToken: "t0k3n", fetchImpl });
    await transport.request({ method: "POST", path: "/api/asset", body: [{ "@s": { AssetType: "Story" } }] });
    await transport.request({ method: "POST", path: "/api/asset", body: "- AssetType: Story\n", contentType: "text/yaml" });
    await transport.request({ method: "POST", path: "/attachment.img/1", body: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    const inits = fetchImpl.mock.calls.map((c) => c[1]);
    expect(inits[0].headers.authorization).toBe("Bearer t0k3n");
    expect(inits[0].headers["content-type"]).toBe("application/json");
    expect(inits[0].body).toBe('[{"@s":{"AssetType":"Story"}}]');
    expect(inits[1].headers["content-type"]).toBe("text/yaml");
    expect(inits[1].body).toBe("- AssetType: Story\n");
    expect(inits[2].headers["content-type"]).toBe("image/png");
    expect(inits[2].body).toBeInstanceOf(Uint8Array);
  });

  it("reads bytes when asked, text when the server does not say JSON, and refuses non-JSON when JSON was insisted on", async () => {
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl: vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 8]), { status: 200, headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(new Response("plain", { status: 200, headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) });
    expect(await transport.request<Uint8Array>({ method: "GET", path: "/a", responseType: "bytes" })).toEqual(new Uint8Array([9, 8]));
    expect(await transport.request<string>({ method: "GET", path: "/b" })).toBe("plain");
    await expect(transport.request({ method: "GET", path: "/c", responseType: "json" })).rejects.toMatchObject({ code: "BAD_JSON" });
  });

  it("maps an error response to ApiError with the message the Agility endpoints actually send, and never retries a 4xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ _type: "Error", error: "Invalid SEL parameter", exceptions: [{ type: "MetaException", message: "Unknown token: Owners.Name" }] }, 400));
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl, retries: 3 });
    const err = (await transport.request({ method: "GET", path: "/rest-1.v1/Data/BaseAsset" }).catch((e: unknown) => e)) as ApiError & { details: { exceptions: { message: string }[] } };
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Invalid SEL parameter");
    expect(err.details.exceptions[0]!.message).toBe("Unknown token: Owners.Name");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // api/asset's shape for a body it could not parse (copied from a live 400, 2026-11-04).
    const bulk = vi.fn().mockResolvedValue(json({ Exceptions: ["The request body is not valid JSON. Unexpected end of content while loading JObject. Path 'from', line 1, position 16."] }, 400));
    const bulkErr = (await createFetchTransport({ baseUrl: "https://x", fetchImpl: bulk }).request({ method: "POST", path: "/api/asset", body: "{" }).catch((e: unknown) => e)) as ApiError;
    expect(bulkErr.status).toBe(400);
    expect(bulkErr.message).toMatch(/^The request body is not valid JSON\./);
  });

  it("retries a GET on a network failure or a 5xx, never a POST — a retried batch write is a double write", async () => {
    const flaky = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json({ _type: "Error", error: "boom" }, 503))
      .mockResolvedValueOnce(json({ ok: true }));
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl: flaky, retries: 2 });
    expect(await transport.request<{ ok: boolean }>({ method: "GET", path: "/a" })).toEqual({ ok: true });
    expect(flaky).toHaveBeenCalledTimes(3);
    const post = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const writer = createFetchTransport({ baseUrl: "https://x", fetchImpl: post, retries: 2 });
    await expect(writer.request({ method: "POST", path: "/api/asset", body: [] })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(post).toHaveBeenCalledTimes(1);
    // A caller that has made its write idempotent (a guard filter) may opt in.
    const guarded = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json({}));
    await createFetchTransport({ baseUrl: "https://x", fetchImpl: guarded, retries: 1 }).request({ method: "POST", path: "/api/asset", body: [], idempotent: true });
    expect(guarded).toHaveBeenCalledTimes(2);
  });

  it("times out an attempt and reports it as TIMEOUT", async () => {
    const hang = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl: hang, timeoutMs: 20 });
    await expect(transport.request({ method: "GET", path: "/slow" })).rejects.toMatchObject({ code: "TIMEOUT", status: 0 });
  });
});

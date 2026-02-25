import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/core/errors";
import { createFetchTransport } from "../src/core/fetchTransport";

describe("createFetchTransport", () => {
  it("sends request and returns parsed JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const transport = createFetchTransport({
      baseUrl: "https://api.example.com",
      apiKey: "key-123",
      fetchImpl
    });

    const result = await transport.request<{ ok: boolean }>({
      method: "GET",
      path: "/ping",
      query: { env: "test" }
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.example.com/ping?env=test");
  });

  it("maps non-2xx responses to ApiError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })
    );

    const transport = createFetchTransport({
      baseUrl: "https://api.example.com",
      fetchImpl
    });

    await expect(
      transport.request({
        method: "GET",
        path: "/missing"
      })
    ).rejects.toBeInstanceOf(ApiError);
  });
});
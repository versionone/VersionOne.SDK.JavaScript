import { describe, expect, it, vi } from "vitest";
import { WorkItemsClient } from "../src/apis/workItemsClient";
import type { RequestOptions, Transport } from "../src/core/transport";

describe("WorkItemsClient", () => {
  it("calls list endpoint with cursor query", async () => {
    const request = vi
      .fn<Transport["request"]>()
      .mockResolvedValue({ items: [], nextCursor: undefined });
    const client = new WorkItemsClient({ request });

    await client.list("abc123");

    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/workitems",
      query: { cursor: "abc123" }
    } satisfies RequestOptions);
  });

  it("encodes id for getById", async () => {
    const request = vi.fn<Transport["request"]>().mockResolvedValue({ id: "x", name: "n", status: "active" });
    const client = new WorkItemsClient({ request });

    await client.getById("A B/C");

    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/workitems/A%20B%2FC"
    } satisfies RequestOptions);
  });
});
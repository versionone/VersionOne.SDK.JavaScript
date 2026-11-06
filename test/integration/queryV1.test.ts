import { expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { describeInstance, instance } from "./instance";

/**
 * query.v1 against a real instance. Read-only, small pages. What the fakes
 * cannot prove: that query.v1 and api/asset really spell rows the same way
 * (so one translation serves both), that a miss is [] and not an error, and
 * that a refused query fails the whole request with the server's message.
 */
describeInstance("queryV1 (live)", () => {
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: instance!.transport });
  const q = { from: "Story", select: ["Name", "Number", "Estimate", "IsClosed", "Scope", "Owners", { from: "Status", select: ["Name"] }], sort: ["ID"], page: { size: 3, start: 0 } };

  it("the same query through query.v1 and api/asset translates to the same rows", async () => {
    const [viaQueryV1, viaAssets] = await Promise.all([client.queryV1.query(q), client.assets.query(q)]);
    expect(viaQueryV1.length).toBeGreaterThan(0);
    expect(viaQueryV1).toEqual(viaAssets);
  });

  it("a query that matches nothing is [] in its own slot — the expect-zero control — and a `with` variable carries an em dash", async () => {
    const [none, scopes] = await client.queryV1.queries([
      { from: "Story", select: ["Name"], filter: ["Name=$n"], with: { $n: "sdk-integration — no such story" }, page: { size: 1, start: 0 } },
      { from: "Scope", select: ["Name"], page: { size: 1, start: 0 } }
    ]);
    expect(none).toEqual([]);
    expect(scopes).toHaveLength(1);
  });

  it("an unknown attribute fails the request with the server's message", async () => {
    await expect(client.queryV1.queries([q, { from: "Story", select: ["NoSuchAttribute"], page: { size: 1, start: 0 } }])).rejects.toMatchObject({
      status: 400,
      code: "QUERY_REJECTED",
      message: expect.stringContaining("Story.NoSuchAttribute")
    });
  });
});

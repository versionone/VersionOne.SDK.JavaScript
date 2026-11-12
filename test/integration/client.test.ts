import { expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { Story } from "../../src/types/assets/Story";
import { describeInstance, instance } from "./instance";

/**
 * The client's reads, live: `get` by OID, `me`, `queryPage` with a total,
 * `pages` walking to the end, and the asset page URL answering.
 */
describeInstance("client reads (live)", () => {
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: instance!.transport });

  it("me is the member the credentials belong to, and get reads it back by OID (and null for an OID nobody has)", async () => {
    const me = await client.me();
    expect(me._oid).toMatch(/^Member:\d+$/);
    expect(typeof me.Username).toBe("string");
    const again = await client.get<{ _oid: string; Name: string }>(me._oid, ["Name"]);
    expect(again).toEqual({ _oid: me._oid, Name: me.Name });
    expect(await client.get("Member:999999999")).toBeNull();
  });

  it("queryPage reports the total and whether more pages follow; pages reads exactly that many rows", async () => {
    const q = { from: "Story", select: ["Number"], sort: ["ID"], page: { size: 2, start: 0 } };
    const first = await client.queryPage<Story>(q);
    expect(first.total).not.toBeNull();
    expect(first.more).toBe(first.total! > 2);
    const all = await client.all<Story>(q, { limit: 7 });
    expect(all).toHaveLength(Math.min(7, first.total!));
    expect(new Set(all.map((r) => r._oid)).size).toBe(all.length);
  });

  it("the asset page URL answers for a real asset (assetdetail.v1 redirects to the type's detail page)", async () => {
    const me = await client.me();
    const response = await fetch(client.urls.asset(me._oid), { headers: { authorization: `Bearer ${process.env.V1_ACCESS_TOKEN ?? ""}` }, redirect: "manual" });
    expect([200, 302]).toContain(response.status);
  });
});

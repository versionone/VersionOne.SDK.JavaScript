import { expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { Story } from "../../src/types/assets/Story";
import { describeInstance, fixtureName, instance } from "./instance";

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

/**
 * An instance's own list type (Custom_<Name>, Base List) is read like any
 * type: the schema loads it from meta.v1 by token, and its rows translate
 * (Order a number, Inactive a boolean). Found through the metamodel, since
 * which custom lists exist is the instance's business; skipped when it
 * has none.
 */
describeInstance("custom list types (live)", () => {
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: instance!.transport });

  it("reads a Custom_ list type's values with List's attributes translated", async () => {
    const metamodel = await client.meta.metamodel();
    const custom = Object.values(metamodel.AssetTypes).find((t) => t.Base === "List" && t.Token.startsWith("Custom_"));
    if (!custom) { console.warn(`no custom list type on ${instance!.url}; skipping`); return; }
    const page = await client.queryPage({ from: custom.Token, select: ["Name", "Order", "Inactive", "AssetType"], page: { size: 3, start: 0 } });
    expect(page.total).not.toBeNull();
    for (const row of page.rows) {
      expect(typeof row.Name).toBe("string");
      expect(row.Order === null || typeof row.Order === "number").toBe(true);
      expect(row.Inactive === null || typeof row.Inactive === "boolean").toBe(true);
      expect(row.AssetType).toBe(custom.Token);
    }
    expect(client.schema.assetType(custom.Token)?.Base).toBe("List");
  }, 60_000);
});

/**
 * The two things rest-1 answers that api/asset cannot: an operation's
 * result (the copy's OID) and a new asset's template; and the fields a
 * form needs for a type in a scope. Fixtures named sdk-integration …,
 * deleted by exact OID (a copy is Active, so Delete alone suffices).
 */
describeInstance("rest-1 operate, template and fields (live)", () => {
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: instance!.transport });

  it("copy answers the new story's OID, which api/asset's execute does not; the copy is then deleted", async () => {
    const created = await client.assets.send([{ AssetType: "Story", Name: fixtureName("copy source"), Scope: "Scope:0" }], { throwOnFailure: true });
    const source = created.created[0]!;
    const made: string[] = [source];
    try {
      const copy = await client.copy(source);
      made.push(copy);
      expect(copy).toMatch(/^Story:\d+$/);
      expect(copy).not.toBe(source);
      const row = await client.get(copy, ["Name"]);
      expect(row?.Name).toMatch(/^Copy Of sdk-integration/);
      const viaBulk = await client.assets.send([{ from: source, execute: "Copy" }], { throwOnFailure: true });
      expect(viaBulk.created).toEqual([]); // the control: api/asset reports only the operated source
      expect(viaBulk.operated).toEqual([source]);
      const strays = await client.query({ from: "Story", select: ["Name"], filter: ["Name=$n"], with: { $n: `Copy Of ${created.created.length ? (await client.get(source, ["Name"]))!.Name : ""}` }, page: { size: 5, start: 0 } });
      made.push(...strays.map((s) => s._oid).filter((o) => !made.includes(o)));
    } finally {
      await client.assets.send(made.map((oid) => ({ from: oid, execute: "Delete" })));
    }
  }, 60_000);

  it("template for a Timebox in a scope carries the initializer's suggestions; for a Story, the scope", async () => {
    const timebox = await client.data.template("Timebox", { ctx: "Scope:0" });
    expect(typeof timebox.Name).toBe("string");
    expect(timebox.Schedule).toMatchObject({ _oid: expect.stringMatching(/^Schedule:\d+$/) });
    expect(timebox.Owner).toMatchObject({ _oid: (await client.me())._oid });
    const story = await client.data.template("Story", { ctx: "Scope:0" });
    expect(story).toEqual({ Scope: { _oid: "Scope:0" } });
    await expect(client.data.operate("Story:999999999", "NoSuchOp")).rejects.toMatchObject({ status: 400, kind: "invalid" });
  }, 60_000);

  it("fields.describe answers required, visible and important attributes for a Story in Scope:0", async () => {
    const f = await client.fields.describe("Story", "Scope:0");
    expect(f.required).toEqual(["Name", "Scope"]);
    expect(f.visible).toEqual(expect.arrayContaining(["Name", "Number", "Scope", "Status"]));
    expect(f.visible).toEqual([...f.visible].sort());
    expect(Array.isArray(f.important)).toBe(true);
    const both = await client.fields.visible(["Story", "Defect"], ["Scope:0"]);
    expect(Object.keys(both).sort()).toEqual(["Defect", "Story"]);
  }, 60_000);
});

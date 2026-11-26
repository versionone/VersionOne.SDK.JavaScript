import { expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { Story } from "../../src/types/assets/Story";
import { normalizeQuery } from "../../src/wire/rest1";
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

  it("a query written with rest-1's spellings, normalised, reads the same rows as the QueryBody it stands for (and a where that matches nothing reads none)", async () => {
    const me = await client.me();
    const loose = normalizeQuery({ from: "Member", sel: "Name,Username", where: `ID='${me._oid}';IsSelf='true'`, sort: "Name", page: "5,0" });
    expect(loose).toEqual({ from: "Member", select: ["Name", "Username"], filter: [`ID='${me._oid}';IsSelf='true'`], sort: ["Name"], page: { size: 5, start: 0 } });
    expect(await client.query(loose)).toEqual([{ _oid: me._oid, Name: me.Name, Username: me.Username }]);
    expect(await client.query(normalizeQuery({ from: "Member", sel: "Name", where: `ID='${me._oid}';IsSelf='false'`, page: "5,0" }))).toEqual([]);
  });

  it("the rows rule holds on every read path: a selected relation is a Ref, a path selected by name is at row[path], and no other key arrives", async () => {
    const me = await client.me();
    const made = await client.send([{ AssetType: "Story", Name: fixtureName("rows rule"), Scope: { _oid: "Scope:0" }, Owners: [{ _oid: me._oid }] }], { throwOnFailure: true });
    const story = made.created[0]!;
    try {
      const select = ["Name", "Owners", "Owners.Name", "Scope.Name"];
      const keys = ["Name", "Owners", "Owners.Name", "Scope.Name", "_oid"];
      const viaQuery = (await client.query({ from: "Story", select, filter: ["ID=$id"], with: { $id: story }, page: { size: 1, start: 0 } }))[0]! as Record<string, unknown>;
      const viaPage = (await client.queryPage({ from: "Story", select, filter: ["ID=$id"], with: { $id: story }, page: { size: 1, start: 0 } })).rows[0]! as Record<string, unknown>;
      const viaRest = (await client.data.list("Story", { select, filter: [`ID='${story}'`], page: { size: 1, start: 0 } })).rows[0]! as unknown as Record<string, unknown>;
      for (const row of [viaQuery, viaPage, viaRest]) {
        expect(Object.keys(row).sort()).toEqual(keys);
        expect(row["Owners.Name"]).toEqual([me.Name]); // a parallel array beside the Refs
        expect(typeof row["Scope.Name"]).toBe("string"); // its relation was not selected: the path is still there
        expect((row.Owners as { _oid: string }[]).map((o) => o._oid)).toEqual([me._oid]);
      }
      // query.v1 and api/asset Refs are bare; rest-1 puts the display attributes it sends on the Ref as well.
      expect(viaQuery.Owners).toEqual([{ _oid: me._oid }]);
      expect(viaPage.Owners).toEqual([{ _oid: me._oid }]);
      expect((viaRest.Owners as { Name: string }[])[0]!.Name).toBe(me.Name);
      // rest-1 without the dotted path selected: its uninvited columns are on the Ref, not on the row.
      const bare = (await client.data.list("Story", { select: ["Name", "Owners"], filter: [`ID='${story}'`], page: { size: 1, start: 0 } })).rows[0]! as unknown as Record<string, unknown>;
      expect(Object.keys(bare).sort()).toEqual(["Name", "Owners", "_oid"]);
      // And a refused rest-1 read is a QUERY_REJECTED with sentences, like query.v1's.
      await expect(client.data.list("Story", { filter: ["Nope=1"], page: { size: 1, start: 0 } })).rejects.toMatchObject({ kind: "invalid", code: "QUERY_REJECTED", message: expect.stringMatching(/^Invalid WHERE parameter; /) });
      await expect(client.query({ from: "Story", filter: ["Nope=1"], page: { size: 1, start: 0 } })).rejects.toMatchObject({ kind: "invalid", code: "QUERY_REJECTED" });
    } finally {
      await client.send([{ from: story, execute: "Delete" }]);
    }
  });

  it("a command addressed to one asset that is gone did nothing and is in `unmatched` (the server calls it a success); one that applied, a no-op and a refused one are not", async () => {
    const me = await client.me();
    const made = await client.send([
      { "@c": { AssetType: "Conversation" } },
      { AssetType: "Expression", Author: me._oid, AuthoredAt: new Date().toISOString(), Content: fixtureName("unmatched"), BelongsTo: "@c" },
      { AssetType: "Story", Name: fixtureName("unmatched"), Scope: "Scope:0" }
    ], { throwOnFailure: true });
    const [conversation, expression, story] = made.created as [string, string, string];
    expect(made.unmatched).toEqual([]);
    try {
      // The control: an update and an operation that do apply are not flagged, a no-op update included.
      const applied = await client.send([{ from: story, update: { Name: fixtureName("unmatched renamed") } }, { from: story, update: { Estimate: null } }, { from: story, execute: "QuickClose" }]);
      expect(applied).toMatchObject({ unmatched: [], failures: [] });
      // An operation the type does not have is a failure, which is an answer: not also flagged.
      const refused = await client.send([{ from: conversation, execute: "Delete" }]);
      expect(refused).toMatchObject({ operated: [], unmatched: [], failures: [{ index: 0, message: "Unknown Operation 'Conversation.Delete'" }] });
    } finally {
      await client.send([{ from: story, execute: "Reactivate" }]);
      await client.send([{ from: story, execute: "Delete" }, { from: expression, execute: "Delete" }]);
    }
    // Both are gone now (the Conversation went with its last Expression): an update by OID matches nothing, and says so.
    expect(await client.send([{ from: story, update: { Name: "x" } }, { from: conversation, execute: "Join" }])).toMatchObject({ modified: [], operated: [], failures: [], unmatched: [0, 1] });
    expect(await client.get(conversation)).toBeNull();
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
    const created = await client.send([{ AssetType: "Story", Name: fixtureName("copy source"), Scope: "Scope:0" }], { throwOnFailure: true });
    const source = created.created[0]!;
    const made: string[] = [source];
    try {
      const copy = await client.copy(source);
      made.push(copy);
      expect(copy).toMatch(/^Story:\d+$/);
      expect(copy).not.toBe(source);
      const row = await client.get(copy, ["Name"]);
      expect(row?.Name).toMatch(/^Copy Of sdk-integration/);
      const viaBulk = await client.send([{ from: source, execute: "Copy" }], { throwOnFailure: true });
      expect(viaBulk.created).toEqual([]); // the control: api/asset reports only the operated source
      expect(viaBulk.operated).toEqual([source]);
      const strays = await client.query({ from: "Story", select: ["Name"], filter: ["Name=$n"], with: { $n: `Copy Of ${created.created.length ? (await client.get(source, ["Name"]))!.Name : ""}` }, page: { size: 5, start: 0 } });
      made.push(...strays.map((s) => s._oid).filter((o) => !made.includes(o)));
    } finally {
      await client.send(made.map((oid) => ({ from: oid, execute: "Delete" })));
    }
  }, 60_000);

  it("template for a Timebox in a scope carries the initializer's suggestions; for a Story, the scope", async () => {
    const timebox = await client.template("Timebox", { ctx: "Scope:0" });
    expect(typeof timebox.Name).toBe("string");
    expect(timebox.Schedule).toMatchObject({ _oid: expect.stringMatching(/^Schedule:\d+$/) });
    expect(timebox.Owner).toMatchObject({ _oid: (await client.me())._oid });
    const story = await client.template("Story", { ctx: "Scope:0" });
    expect(story).toEqual({ Scope: { _oid: "Scope:0" } });
    await expect(client.operate("Story:999999999", "NoSuchOp")).rejects.toMatchObject({ status: 400, kind: "invalid" });
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

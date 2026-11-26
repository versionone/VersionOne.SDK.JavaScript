import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import { search } from "../../src/services/search";
import { FakeAgilityClient } from "../../src/testing";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";

/**
 * The search service: what it asks rest-1 for, and what it makes of the
 * answer. The response below is written in the shape live responses have
 * (test/integration/search.test.ts pins that shape against a server):
 * rest-1 keys a type-qualified select by the attribute's plain name,
 * leaves it out where the type has no such attribute, and adds display
 * columns nobody asked for.
 */
const schema = () => Schema.fromMetamodel(toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument));
const attribute = (name: string, value: unknown) => ({ _type: "Attribute", name, value });
const relation = (name: string, value: unknown) => ({ _type: "Relation", name, value });
const ref = (idref: string) => ({ _type: "Asset", href: `/I/rest-1.v1/Data/${idref.replace(":", "/")}`, idref });
const live = {
  _type: "Assets", total: 2, pageSize: 10, pageStart: 0,
  Assets: [
    { _type: "Asset", href: "/I/rest-1.v1/Data/Issue/3", id: "Issue:3", Attributes: {
      Name: attribute("Name", "Printer blocker"), AssetType: attribute("AssetType", "Issue"), Number: attribute("Number", "I-01043"),
      Scope: relation("Scope", ref("Scope:0")), "Scope.Name": attribute("Scope.Name", "System (All Projects)"),
      Owner: relation("Owner", null), "Owner.Name": attribute("Owner.Name", null), "Owner.Nickname": attribute("Owner.Nickname", null) } },
    { _type: "Asset", href: "/I/rest-1.v1/Data/Story/1", id: "Story:1", Attributes: {
      Name: attribute("Name", "Printer setup"), AssetType: attribute("AssetType", "Story"), Number: attribute("Number", "S-01001"), Estimate: attribute("Estimate", 2),
      Scope: relation("Scope", ref("Scope:0")), "Scope.Name": attribute("Scope.Name", "System (All Projects)"),
      Owners: relation("Owners", [ref("Member:20"), ref("Member:21")]), "Owners.Name": attribute("Owners.Name", ["Ann", "Bo"]), "Owners.Nickname": attribute("Owners.Nickname", ["a", "b"]) } }
  ]
};
function recording(answer: unknown = live): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  return { calls, request: (async (o: RequestOptions) => { calls.push(o); return answer; }) as Transport["request"] };
}
const page = { size: 10, start: 0 };

describe("search", () => {
  it("asks rest-1 once for a mixed page: the root type, each plain name spelled for every type that defines it, the types as a filter, a total", async () => {
    const t = recording();
    await search(t, schema(), "printer", { types: ["Story", "Issue", "Story"], select: ["Name", "Number", "Estimate", "Owners", "Owner", "Scope.Name"], filter: ["AssetState!='Closed'"], where: { "Scope.Name": "O'Hare" }, sort: ["-ChangeDateUTC"], page });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/rest-1.v1/Data/BaseAsset" });
    expect(t.calls[0]!.query).toEqual({
      find: "printer",
      findin: "Name,Story.Number,Issue.Number",
      // Name is the root's own; Number is both types'; Estimate and Owners are a Story's, Owner an Issue's; a path is spelled from its first step.
      sel: "Name,Story.Number,Issue.Number,Story.Estimate,Story.Owners,Issue.Owner,Story.Scope.Name,Issue.Scope.Name",
      where: "AssetType='Story','Issue';AssetState!='Closed';Scope.Name=$where0",
      with: "$where0=O'Hare",
      sort: "-ChangeDateUTC",
      page: "10,0",
      needTotal: "true",
      deleted: undefined,
      asof: undefined
    });
  });

  it("each row has exactly the selected keys under their plain names: null where its type has no such attribute, relations as bare Refs, a path where it was asked for", async () => {
    const result = await search(recording(), schema(), "printer", { types: ["Story", "Issue"], select: ["Name", "Number", "Estimate", "Owners", "Owners.Name", "Owner", "Scope", "Scope.Name"], page });
    expect(result).toEqual({
      total: 2,
      more: false,
      rows: [
        { _oid: "Issue:3", Name: "Printer blocker", Number: "I-01043", Estimate: null, Owners: null, "Owners.Name": null, Owner: null, Scope: { _oid: "Scope:0" }, "Scope.Name": "System (All Projects)" },
        { _oid: "Story:1", Name: "Printer setup", Number: "S-01001", Estimate: 2, Owners: [{ _oid: "Member:20" }, { _oid: "Member:21" }], "Owners.Name": ["Ann", "Bo"], Owner: null, Scope: { _oid: "Scope:0" }, "Scope.Name": "System (All Projects)" }
      ]
    });
  });

  it("the defaults select Name, Number, AssetType and AssetState and search Name and Number; one type is read as itself, with plain names", async () => {
    const mixed = recording();
    await search(mixed, schema(), "printer", { types: ["Story", "Request"], page });
    expect(mixed.calls[0]!.query).toMatchObject({ sel: "Name,Story.Number,Request.Number,AssetType,AssetState", findin: "Name,Story.Number,Request.Number" });
    const one = recording();
    await search(one, schema(), "printer", { types: ["Request"], select: ["Name", "Number", "Owner"], page });
    expect(one.calls[0]).toMatchObject({ path: "/rest-1.v1/Data/Request", query: { sel: "Name,Number,Owner", findin: "Name,Number", where: undefined } });
  });

  it("a mistake in the call is a usage error and nothing is sent: no text, no page, no types, an abstract or unknown type, a name no searched type defines (naming the types checked)", async () => {
    const t = recording();
    const s = schema();
    const refused = async (run: () => Promise<unknown>, message: RegExp) => {
      const error = await run().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toMatch(message);
    };
    await refused(() => search(t, s, "  ", { types: ["Story"], page }), /needs text/);
    await refused(() => search(t, s, "x", { types: ["Story"] } as never), /without a page/);
    await refused(() => search(t, s, "x", { types: [], page }), /needs `types`/);
    await refused(() => search(t, s, "x", { types: ["Workitem"], page }), /"Workitem" is an abstract type/);
    await refused(() => search(t, s, "x", { types: ["Sotry"], page }), /no asset type "Sotry"/);
    await refused(() => search(t, s, "x", { types: ["Story", "Issue"], select: ["Nmae"], page }), /select "Nmae" is not an attribute of any type searched \(Story, Issue\)/);
    await refused(() => search(t, s, "x", { types: ["Story", "Issue"], findin: ["Nmae"], page }), /findin "Nmae"/);
    await refused(() => search(t, s, "x", { types: ["Issue"], select: ["Estimate"], page }), /"Estimate" is not an attribute of Issue/);
    expect(t.calls).toEqual([]);
  });
});

describe("FakeAgilityClient: search", () => {
  it("onSearch answers client.search with scripted rows, paged, with the total, each cut to the selected keys; what was searched is recorded and nothing is requested", async () => {
    const fake = new FakeAgilityClient().onSearch([
      { _oid: "Story:1", Name: "Printer setup", Number: "S-1", AssetType: "Story", AssetState: "Active", Estimate: 2 },
      { _oid: "Request:2", Name: "Printer request", Number: "R-2", AssetType: "Request", AssetState: "Active" },
      { _oid: "Issue:3", Name: "Printer blocker", Number: "I-3", AssetType: "Issue", AssetState: "Active" }
    ]);
    const first = await fake.search("printer", { types: ["Story", "Request", "Issue"], select: ["Name", "Number", "Estimate"], page: { size: 2, start: 0 } });
    expect(first).toEqual({ total: 3, more: true, rows: [{ _oid: "Story:1", Name: "Printer setup", Number: "S-1", Estimate: 2 }, { _oid: "Request:2", Name: "Printer request", Number: "R-2", Estimate: null }] });
    const rest = await fake.search("printer", { types: ["Story", "Request", "Issue"], page: { size: 2, start: 2 } });
    expect(rest).toEqual({ total: 3, more: false, rows: [{ _oid: "Issue:3", Name: "Printer blocker", Number: "I-3", AssetType: "Issue", AssetState: "Active" }] });
    expect(fake.searched.map((s) => [s.text, s.options.page.start])).toEqual([["printer", 0], ["printer", 2]]);
    expect(fake.requests).toEqual([]);
  });

  it("an unscripted search throws, and so do the mistakes the client refuses; a function answers a page, an Error is thrown", async () => {
    const fake = new FakeAgilityClient();
    await expect(fake.search("printer", { types: ["Story"], page })).rejects.toThrow(/no answer scripted for search\("printer"\)/);
    await expect(fake.search(" ", { types: ["Story"], page })).rejects.toMatchObject({ kind: "usage" });
    await expect(fake.search("x", { types: [], page })).rejects.toMatchObject({ kind: "usage" });
    fake.onSearch((text, options) => ({ rows: [{ _oid: "Story:9", Name: `${text} in ${options.types.join("+")}` }], total: 41 }));
    expect(await fake.search("x", { types: ["Story", "Goal"], select: ["Name"], page: { size: 1, start: 0 } })).toEqual({ rows: [{ _oid: "Story:9", Name: "x in Story+Goal" }], total: 41, more: true });
    fake.onSearch(new Error("down"));
    await expect(fake.search("x", { types: ["Story"], page })).rejects.toThrow("down");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import { search } from "../../src/services/search";
import { AgilityApiClient } from "../../src/client";
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

  it("a family named by its abstract type stands for its concrete subtypes, beside any other type, each once", async () => {
    const t = recording();
    await search(t, schema(), "printer", { types: ["Workitem", "Story", "Request"], select: ["Name"], page });
    expect(t.calls[0]!.query).toMatchObject({ where: "AssetType='Defect','Epic','Story','Task','Test','TestSet','Theme','Request'" });
    await search(t, schema(), "printer", { types: ["PrimaryWorkitem"], select: ["Number"], findin: ["Name"], page });
    expect(t.calls[1]).toMatchObject({ path: "/rest-1.v1/Data/BaseAsset", query: { where: "AssetType='Defect','Story','TestSet'", sel: "Defect.Number,Story.Number,TestSet.Number" } });
  });

  it("a mistake in the call is a usage error and nothing is sent: no text, no page, no types, an unknown type or a root that is no family, a name no searched type defines (naming the types checked)", async () => {
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
    await refused(() => search(t, s, "x", { types: ["BaseAsset"], page }), /"BaseAsset" is an abstract type whose concrete subtypes the SDK does not know/);
    await refused(() => search(t, s, "x", { types: ["Sotry"], page }), /no asset type "Sotry"/);
    await refused(() => search(t, s, "x", { types: ["Story", "Issue"], select: ["Nmae"], page }), /select "Nmae" is not an attribute of any asset type \(searched: Story, Issue\)/);
    await refused(() => search(t, s, "x", { types: ["Story"], findin: ["Nmae"], page }), /findin "Nmae" is not an attribute of any asset type/);
    await refused(() => search(t, s, "x", { types: ["Goal", "Topic"], findin: ["Estimate", "Owners"], page }), /none of the types searched \(Goal, Topic\) has any of the attributes in `findin` \(Estimate, Owners\): there is nothing to search in/);
    expect(t.calls).toEqual([]);
  });

  it("a name none of the searched types has is not a mistake: it is left out of the request and every row has null there, so one list of columns serves any choice of types", async () => {
    const columns = ["Name", "Number", "Status.Name", "Owners.Name", "Owner.Name", "Estimate", "Custom_Risk"];
    // One type, which has no Owner and no custom field of that name.
    const story = recording({ ...live, Assets: [live.Assets[1]] });
    const one = await search(story, schema(), "printer", { types: ["Story"], select: columns, page });
    expect(story.calls[0]).toMatchObject({ path: "/rest-1.v1/Data/Story", query: { sel: "Name,Number,Status.Name,Owners.Name,Estimate" } });
    expect(one.rows).toEqual([{ _oid: "Story:1", Name: "Printer setup", Number: "S-01001", "Status.Name": null, "Owners.Name": ["Ann", "Bo"], "Owner.Name": null, Estimate: 2, Custom_Risk: null }]);
    // Two types with neither a Status nor an owner nor an Estimate: only what they have is asked for; a findin none has is dropped.
    const few = recording({ ...live, Assets: [] });
    await search(few, schema(), "printer", { types: ["Goal", "Topic"], select: columns, findin: ["Name", "Estimate"], page });
    expect(few.calls[0]!.query).toMatchObject({ sel: "Name,Goal.Number,Topic.Number", findin: "Name" });
    // Nothing selected applies at all: the search still asks for something of its own, and the rows have the keys.
    const none = recording({ ...live, Assets: [{ _type: "Asset", href: "", id: "Goal:4", Attributes: { Name: attribute("Name", "Printing goal") } }] });
    expect((await search(none, schema(), "printer", { types: ["Goal", "Topic"], select: ["Estimate", "Owners"], findin: ["Name"], page })).rows).toEqual([{ _oid: "Goal:4", Estimate: null, Owners: null }]);
    expect(none.calls[0]!.query).toMatchObject({ sel: "Name" });
  });

  it("a date is in the model's one spelling, by the row's own type; text that looks like a date is left alone", async () => {
    const dated = recording({ ...live, Assets: [{ _type: "Asset", href: "", id: "Story:1", Attributes: { Name: attribute("Name", "2011-09-20"), ChangeDateUTC: attribute("ChangeDateUTC", "2026-07-13T22:06:14.600Z"), CreateDate: attribute("CreateDate", "2011-09-20") } }] });
    expect((await search(dated, schema(), "printer", { types: ["Story", "Issue"], select: ["Name", "ChangeDateUTC", "CreateDate"], page })).rows).toEqual([{ _oid: "Story:1", Name: "2011-09-20", ChangeDateUTC: "2026-07-13T22:06:14.6000000Z", CreateDate: "2011-09-20T00:00:00.0000000" }]);
  });
});

describe("FakeAgilityClient: search", () => {
  const scripted = [
    { _oid: "Story:1", Name: "Printer setup", Number: "S-1", AssetType: "Story", AssetState: "Active", Estimate: 2, Scope: { _oid: "Scope:0", Name: "System" } },
    { _oid: "Request:2", Name: "Printer request", Number: "R-2", AssetType: "Request", AssetState: "Active" },
    { _oid: "Issue:3", Name: "Printer blocker", Number: "I-3", AssetType: "Issue", AssetState: "Active" }
  ];

  it("onSearch answers client.search with scripted rows, paged, with the total, each with exactly the selected keys; what was searched is recorded", async () => {
    const fake = new FakeAgilityClient().onSearch(scripted);
    const first = await fake.search("printer", { types: ["Story", "Request", "Issue"], select: ["Name", "Number", "Estimate", "Scope", "Scope.Name"], page: { size: 2, start: 0 } });
    expect(first).toEqual({ total: 3, more: true, rows: [
      { _oid: "Story:1", Name: "Printer setup", Number: "S-1", Estimate: 2, Scope: { _oid: "Scope:0" }, "Scope.Name": "System" },
      { _oid: "Request:2", Name: "Printer request", Number: "R-2", Estimate: null, Scope: null, "Scope.Name": null }
    ] });
    const rest = await fake.search("printer", { types: ["Story", "Request", "Issue"], page: { size: 2, start: 2 } });
    expect(rest).toEqual({ total: 3, more: false, rows: [{ _oid: "Issue:3", Name: "Printer blocker", Number: "I-3", AssetType: "Issue", AssetState: "Active" }] });
    expect(fake.searched.map((s) => [s.text, s.options.types, s.options.page.start])).toEqual([["printer", ["Story", "Request", "Issue"], 0], ["printer", ["Story", "Request", "Issue"], 2]]);
  });

  it("a client the code under test builds on fake.transport gets the same answer: the search is the client's own, and the fake's instance has the types it names (a chat-bot consumer's pattern)", async () => {
    const fake = new FakeAgilityClient().onSearch(scripted);
    const own = new AgilityApiClient({ baseUrl: "https://agility.example.com/Fake", retries: 0 }, { transport: fake.transport });
    const found = await own.search("printer queue", { types: ["Story", "Request", "Issue", "Test"], findin: ["Name", "Description"], filter: ["AssetState!='Closed'"], sort: ["-ChangeDateUTC"], page: { size: 2, start: 0 } });
    expect(found).toEqual({ total: 3, more: true, rows: [
      { _oid: "Story:1", Name: "Printer setup", Number: "S-1", AssetType: "Story", AssetState: "Active" },
      { _oid: "Request:2", Name: "Printer request", Number: "R-2", AssetType: "Request", AssetState: "Active" }
    ] });
    expect(fake.searched).toEqual([{ text: "printer queue", options: { types: ["Story", "Request", "Issue", "Test"], page: { size: 2, start: 0 } } }]);
    // What the code under test typed travels as the search text and nowhere else.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.query).toMatchObject({ find: "printer queue", where: "AssetType='Story','Request','Issue','Test';AssetState!='Closed'" });
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

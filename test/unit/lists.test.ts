import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError, apiErrorFromResponse } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import { FakeAgilityClient } from "../../src/testing";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";
import { forAsset, forNew } from "../../src/wire/validValues";

const schema = () => Schema.fromMetamodel(toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument));
function fake(answer: (o: RequestOptions) => unknown): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  return { request: vi.fn(async (o: RequestOptions) => { calls.push(o); return answer(o); }) as Transport["request"], calls };
}
// As api/ValidValues answered on the API-testing instance (2026-11-26), identities replaced. Every value is a string; pageSize is the server's "no page".
const entry = (id: number, Name: string, Order: string, RollupState = "Active") => ({ _type: "Asset", href: `~/rest-1.v1/Data/StoryStatus/${id}`, id: `StoryStatus:${id}`, Attributes: { Name: { _type: "Attribute", name: "Name", value: Name }, Order: { _type: "Attribute", name: "Order", value: Order }, RollupState: { _type: "Attribute", name: "RollupState", value: RollupState } } });
const all = { _type: "Assets", total: 3, pageSize: 2147483647, pageStart: 0, Assets: [entry(133, "Future", "115"), entry(134, "In Progress", "116"), entry(135, "Done", "117", "Closed")] };
type Doc = typeof all;
/** The document with the attributes the request selected, as the endpoint sends it. */
const answering = (doc: Doc) => (o: RequestOptions): Doc => {
  const sel = /[?&]sel=([^&]*)/.exec(o.path)?.[1]?.split(",");
  return { ...doc, Assets: doc.Assets.map((a) => ({ ...a, Attributes: Object.fromEntries(Object.entries(a.Attributes).filter(([name]) => !sel || sel.includes(name))) as typeof a.Attributes })) };
};
const statuses = answering(all);
const client = (t: Transport) => new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });

describe("validValues wire", () => {
  it("forNew asks the relation form: a trailing slash, one context joined by a comma, the values as they are", async () => {
    const t = fake(statuses);
    const rows = await forNew(t, "Story", "Status", "Scope:5:99", { select: ["Name", "Order"], sort: ["Order"], team: "Team:9" });
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/api/ValidValues/Story.Status/?context=Scope=Scope:5,Team=Team:9&sel=Name,Order&sort=Order" });
    // The keys selected and no others; a value is the string the endpoint sent.
    expect(rows).toEqual([{ _oid: "StoryStatus:133", Name: "Future", Order: "115" }, { _oid: "StoryStatus:134", Name: "In Progress", Order: "116" }, { _oid: "StoryStatus:135", Name: "Done", Order: "117" }]);
    await forNew(t, "Story", "Status", "Scope:5");
    expect(t.calls[1]!.path).toBe("/api/ValidValues/Story.Status/?context=Scope=Scope:5");
  });

  it("forAsset asks the asset form, the team as teamoid; a refusal is an error and an answer that is no list is a protocol error", async () => {
    const t = fake(statuses);
    await forAsset(t, "Story:1077:3", "Status", { select: ["Name"], team: "Team:9" });
    expect(t.calls[0]!.path).toBe("/api/ValidValues/Story/1077/Status?teamoid=Team:9&sel=Name");
    await forAsset(t, "Story:1077", "Status");
    expect(t.calls[1]!.path).toBe("/api/ValidValues/Story/1077/Status");
    // As the endpoint refuses an attribute the type does not have (2026-11-26).
    const refusing = fake(() => { throw apiErrorFromResponse(400, { Exceptions: ["Bad Request", "Reference: 00000000-0000-0000-0000-000000000000"] }); });
    await expect(forNew(refusing, "Story", "Nmae", "Scope:5")).rejects.toMatchObject({ status: 400, kind: "invalid" });
    await expect(forNew(fake(() => ({ nope: 1 })), "Story", "Status", "Scope:5")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    // An instance without the endpoint: its 404, never an empty list.
    await expect(forNew(fake(() => { throw new ApiError("Not Found", 404); }), "Story", "Status", "Scope:5")).rejects.toMatchObject({ status: 404 });
  });
});

describe("client.lists", () => {
  it("values answers a map from attribute to rows in the list's order, one request per attribute, Name always selected and sorted by Order", async () => {
    const t = fake(statuses);
    const answer = await client(t).lists.values({ asset: "Story:1077", attributes: ["Status", "Priority"], select: ["Order"] });
    expect(t.calls.map((c) => c.path)).toEqual(["/api/ValidValues/Story/1077/Status?sel=Name,Order&sort=Order", "/api/ValidValues/Story/1077/Priority?sel=Name,Order&sort=Order"]);
    expect(answer.Status).toEqual([{ _oid: "StoryStatus:133", Name: "Future", Order: "115" }, { _oid: "StoryStatus:134", Name: "In Progress", Order: "116" }, { _oid: "StoryStatus:135", Name: "Done", Order: "117" }]);
    // What is selected must be an attribute of every list asked for: a status has a RollupState, a priority has not.
    await expect(client(t).lists.values({ asset: "Story:1077", attributes: ["Status", "Priority"], select: ["RollupState"] })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("WorkitemPriority has no attribute RollupState") });
    expect(t.calls).toHaveLength(2);
    expect(Object.keys(answer)).toEqual(["Status", "Priority"]);
    // For an asset not created yet: the type, the scope and the team it will be on. A base type is a type.
    const forNewOne = fake(() => ({ ...all, total: 0, Assets: [] }));
    expect(await client(forNewOne).lists.values({ type: "PrimaryWorkitem", scope: "Scope:5", team: "Team:9", attributes: ["Status"] })).toEqual({ Status: [] });
    expect(forNewOne.calls[0]!.path).toBe("/api/ValidValues/PrimaryWorkitem.Status/?context=Scope=Scope:5,Team=Team:9&sel=Name&sort=Order");
  });

  it("only a relation to a list type is asked for, because the endpoint cannot be bounded; everything else is refused before anything is sent, with the read to use instead", async () => {
    const t = fake(statuses);
    const lists = client(t).lists;
    await expect(lists.values({ asset: "Story:1", attributes: ["Owners"] })).rejects.toMatchObject({ kind: "usage", message: expect.stringMatching(/Story\.Owners points to Member, which is not a list type.*client\.query\(\{ from: "Member", filter, page \}\)/) });
    await expect(lists.values({ type: "Story", scope: "Scope:5", attributes: ["Team"] })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining('client.query({ from: "Team"') });
    await expect(lists.values({ asset: "Story:1", attributes: ["Timebox"] })).rejects.toMatchObject({ kind: "usage" });
    await expect(lists.values({ asset: "Story:1", attributes: ["Name"] })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("Story.Name is not a relation") });
    await expect(lists.values({ asset: "Story:1", attributes: ["Nmae"] })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("Story has no attribute Nmae") });
    await expect(lists.values({ asset: "Story:1", attributes: [] })).rejects.toMatchObject({ kind: "usage" });
    await expect(lists.values({ asset: "S-01077" as never, attributes: ["Status"] })).rejects.toMatchObject({ kind: "usage" });
    // One bad attribute among good ones: nothing is sent for any.
    await expect(lists.values({ asset: "Story:1", attributes: ["Status", "Owners"] })).rejects.toMatchObject({ kind: "usage" });
    // select: attributes of the value itself, and never a date (the endpoint writes dates in the server's culture format).
    await expect(lists.values({ asset: "Story:1", attributes: ["Status"], select: ["ChangeDate"] })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("is a date") });
    await expect(lists.values({ asset: "Story:1", attributes: ["Status"], select: ["Team.Name"] })).rejects.toMatchObject({ kind: "usage" });
    await expect(lists.values({ asset: "Story:1", attributes: ["Status"], select: ["Nmae"] })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("StoryStatus has no attribute Nmae") });
    expect(t.calls).toHaveLength(0);
  });

  it("value answers the one value a name means there: the whole name, ignoring case and surrounding space; an OID is checked to be among the valid values", async () => {
    const t = fake(statuses);
    const lists = client(t).lists;
    expect(await lists.value({ asset: "Story:1077", attribute: "Status", name: "  done " })).toEqual({ _oid: "StoryStatus:135", Name: "Done" });
    expect(await lists.value({ asset: "Story:1077", attribute: "Status", name: "IN PROGRESS", select: ["RollupState"] })).toEqual({ _oid: "StoryStatus:134", Name: "In Progress", RollupState: "Active" });
    expect(await lists.value({ type: "Story", scope: "Scope:5", attribute: "Status", name: "StoryStatus:133:7" })).toMatchObject({ _oid: "StoryStatus:133", Name: "Future" });
    await expect(lists.value({ asset: "Story:1077", attribute: "Status", name: " " })).rejects.toMatchObject({ kind: "usage" });
  });

  it("no such value is NO_SUCH_VALUE with every valid value as a row; more than one is AMBIGUOUS_VALUE with the ones that matched; a part of a name matches only when asked", async () => {
    const twice = { ...all, Assets: [...all.Assets, entry(136, "Done", "118"), entry(137, "In Review", "119"), entry(138, "Progressing", "120")] };
    const lists = client(fake(answering(twice))).lists;
    const missing = await lists.value({ asset: "Story:1077", attribute: "Status", name: "Dne" }).catch((e: unknown) => e as ApiError);
    expect(missing).toMatchObject({ code: "NO_SUCH_VALUE", kind: "invalid", message: 'Story.Status has no value "Dne" here. It can be: Future, In Progress, Done, Done, In Review, Progressing.' });
    expect((missing.details as { values: unknown[] }).values).toEqual(twice.Assets.map((a) => ({ _oid: a.id, Name: a.Attributes.Name.value })));
    // A valid OID of the list type that is not valid here is no such value either.
    await expect(lists.value({ asset: "Story:1077", attribute: "Status", name: "StoryStatus:999" })).rejects.toMatchObject({ code: "NO_SUCH_VALUE" });
    const both = await lists.value({ asset: "Story:1077", attribute: "Status", name: "done" }).catch((e: unknown) => e as ApiError);
    expect(both).toMatchObject({ code: "AMBIGUOUS_VALUE", kind: "invalid", details: { attribute: "Status", name: "done", values: [{ _oid: "StoryStatus:135", Name: "Done" }, { _oid: "StoryStatus:136", Name: "Done" }] } });
    // By default a part of a name finds nothing: a wrong status is never picked silently.
    await expect(lists.value({ asset: "Story:1077", attribute: "Status", name: "fut" })).rejects.toMatchObject({ code: "NO_SUCH_VALUE" });
    // match "prefix": the text begins the name or a word of it; an exact name still wins; several is ambiguous.
    expect(await lists.value({ asset: "Story:1077", attribute: "Status", name: "fut", match: "prefix" })).toMatchObject({ _oid: "StoryStatus:133" });
    expect(await lists.value({ asset: "Story:1077", attribute: "Status", name: "rev", match: "prefix" })).toMatchObject({ _oid: "StoryStatus:137" });
    expect(await lists.value({ asset: "Story:1077", attribute: "Status", name: "future", match: "prefix" })).toMatchObject({ _oid: "StoryStatus:133" });
    await expect(lists.value({ asset: "Story:1077", attribute: "Status", name: "prog", match: "prefix" })).rejects.toMatchObject({ code: "AMBIGUOUS_VALUE", details: { values: [{ _oid: "StoryStatus:134" }, { _oid: "StoryStatus:138" }] } });
    await expect(lists.value({ asset: "Story:1077", attribute: "Status", name: "in", match: "prefix" })).rejects.toMatchObject({ code: "AMBIGUOUS_VALUE" });
    await expect(lists.value({ asset: "Story:1077", attribute: "Status", name: "ogress", match: "prefix" })).rejects.toMatchObject({ code: "NO_SUCH_VALUE" });
    // No value valid there at all: said, not listed.
    await expect(client(fake(() => ({ ...all, total: 0, Assets: [] }))).lists.value({ asset: "Story:1", attribute: "Status", name: "Done" })).rejects.toMatchObject({ code: "NO_SUCH_VALUE", message: 'Story.Status has no value "Done" here. No value is valid here.' });
  });

  it("a failure is never an empty list: the endpoint's error is thrown, also when it is absent from the instance", async () => {
    const gone = fake(() => { throw new ApiError("Not Found", 404); });
    await expect(client(gone).lists.values({ asset: "Story:1", attributes: ["Status"] })).rejects.toMatchObject({ status: 404 });
    await expect(client(gone).lists.value({ asset: "Story:1", attribute: "Status", name: "Done" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("FakeAgilityClient.onValues", () => {
  it("scripts the valid values by attribute; the lookup is the client's own, and what was asked is recorded", async () => {
    const agility = new FakeAgilityClient();
    agility.onValues({ Status: [{ _oid: "StoryStatus:133", Name: "Future" }, { _oid: "StoryStatus:135", Name: "Done", RollupState: "Closed" }] });
    agility.onValues({ Priority: (asked) => (asked.team ? [{ _oid: "WorkitemPriority:140", Name: "High" }] : []) });
    expect(await agility.lists.values({ asset: "Story:1077", attributes: ["Status"], select: ["RollupState"] })).toEqual({ Status: [{ _oid: "StoryStatus:133", Name: "Future", RollupState: null }, { _oid: "StoryStatus:135", Name: "Done", RollupState: "Closed" }] });
    expect(await agility.lists.value({ asset: "Story:1077", attribute: "Status", name: "done" })).toEqual({ _oid: "StoryStatus:135", Name: "Done" });
    await expect(agility.lists.value({ asset: "Story:1077", attribute: "Status", name: "Dne" })).rejects.toMatchObject({ code: "NO_SUCH_VALUE", details: { values: [{ _oid: "StoryStatus:133", Name: "Future" }, { _oid: "StoryStatus:135", Name: "Done" }] } });
    expect(await agility.lists.values({ type: "Defect", scope: "Scope:5", team: "Team:9", attributes: ["Priority"] })).toEqual({ Priority: [{ _oid: "WorkitemPriority:140", Name: "High" }] });
    expect(agility.valuesAsked).toEqual([
      { type: "Story", attribute: "Status", asset: "Story:1077" },
      { type: "Story", attribute: "Status", asset: "Story:1077" },
      { type: "Story", attribute: "Status", asset: "Story:1077" },
      { type: "Defect", attribute: "Priority", scope: "Scope:5", team: "Team:9" }
    ]);
    // An attribute nothing was scripted for says so; an Error scripted is thrown.
    await expect(agility.lists.values({ asset: "Story:1", attributes: ["Source"] })).rejects.toMatchObject({ kind: "usage" });
    agility.onValues({ Status: new ApiError("Not Found", 404) });
    await expect(agility.lists.values({ asset: "Story:1", attributes: ["Status"] })).rejects.toMatchObject({ status: 404 });
  });
});

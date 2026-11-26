import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError, UsageError, apiErrorFromResponse } from "../../src/core/errors";
import { FakeAgilityClient } from "../../src/testing";
import { ConflictError } from "../../src/services/guard";
import { CommandFailureError } from "../../src/wire/assetApi";
import type { MetamodelDocument } from "../../src/wire/meta";
import * as rest1 from "../../src/wire/rest1";

/**
 * The consumer-facing fake: a real client over a transport that answers
 * what a test scripted, in the model's shape.
 */
const stories = [
  { _oid: "Story:1", Name: "Logon", Estimate: 2, IsClosed: false, Status: { _oid: "StoryStatus:5", Name: "Done" }, Owners: [{ _oid: "Member:20" }] },
  { _oid: "Story:2", Name: "Logoff", Estimate: null, IsClosed: true, Status: null, Owners: [] },
  { _oid: "Story:3", Name: "Reset", Estimate: 0.5, IsClosed: false, Status: null, Owners: [] }
];

describe("FakeAgilityClient", () => {
  it("is an AgilityApiClient, so code under test takes it unchanged, and the client's own checks still run", async () => {
    const fake = new FakeAgilityClient();
    expect(fake).toBeInstanceOf(AgilityApiClient);
    expectTypeOf(fake).toMatchTypeOf<AgilityApiClient>();
    await expect(fake.query({ from: "Story" } as never)).rejects.toThrow(/without a page/);
    expect(fake.requests).toEqual([]);
    expect(fake.urls.asset("Story:1")).toBe("https://agility.example.com/Fake/assetdetail.v1?oid=Story:1");
  });

  it("answers a query with the scripted rows exactly as scripted, and records what was asked", async () => {
    const fake = new FakeAgilityClient().onQuery("Story", stories);
    const rows = await fake.query({ from: "Story", select: ["Name", "Estimate", "IsClosed", "Status", "Owners"], filter: ["Scope=$s"], with: { $s: "Scope:0" }, page: { size: 10, start: 0 } });
    expect(rows).toEqual(stories);
    expect(fake.asked).toEqual([{ from: "Story", select: ["Name", "Estimate", "IsClosed", "Status", "Owners"], filter: ["Scope=$s"], with: { $s: "Scope:0" }, page: { size: 10, start: 0 } }]);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /query.v1"]);
  });

  it("pages a scripted list: pages and all end, queryPage reports the list's length as the total, get answers the row of that OID or null", async () => {
    const fake = new FakeAgilityClient().onQuery("Story", stories);
    expect((await fake.all({ from: "Story", page: { size: 2, start: 0 } })).map((r) => r._oid)).toEqual(["Story:1", "Story:2", "Story:3"]);
    expect(await fake.queryPage({ from: "Story", page: { size: 2, start: 0 } })).toMatchObject({ total: 3, more: true, rows: [{ _oid: "Story:1" }, { _oid: "Story:2" }] });
    expect(await fake.queryPage({ from: "Story", page: { size: 2, start: 2 } })).toMatchObject({ total: 3, more: false });
    expect(await fake.get("Story:2:99", ["Name"])).toMatchObject({ _oid: "Story:2", Name: "Logoff" });
    expect(await fake.get("Story:404", ["Name"])).toBeNull();
  });

  it("a function answers one page itself; the answer scripted last wins; several queries in one request each get theirs", async () => {
    const fake = new FakeAgilityClient()
      .onQuery("Story", stories)
      .onQuery((q) => q.from === "Story" && !!q.find, (q) => ({ rows: stories.filter((s) => s.Name.includes(q.find!)), total: 40 }))
      .onQuery("Member", [{ _oid: "Member:20", Name: "Dana" }]);
    expect(await fake.queryPage({ from: "Story", find: "Logo", page: { size: 2, start: 0 } })).toMatchObject({ total: 40, more: true, rows: [{ Name: "Logon" }, { Name: "Logoff" }] });
    const [s, m] = await fake.queries([{ from: "Story", page: { size: 1, start: 0 } }, { from: "Member", page: { size: 1, start: 0 } }]);
    expect([s!.length, m![0]]).toEqual([1, { _oid: "Member:20", Name: "Dana" }]);
    expect(await fake.me()).toEqual({ _oid: "Member:20", Name: "Dana" });
  });

  it("a query nothing was scripted for throws a UsageError naming it: an unscripted read never looks like an empty result", async () => {
    const error = await new FakeAgilityClient().query({ from: "Epic", page: { size: 1, start: 0 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(/no answer scripted for a query of Epic.*onQuery\("Epic"/);
  });

  it("a write needs no script: a create answers a new OID, an update or operation by OID answers that OID, and the batch is recorded as sent", async () => {
    const fake = new FakeAgilityClient();
    const outcome = await fake.send([
      { AssetType: "Story", Name: "new", Scope: { _oid: "Scope:0" } },
      { from: "Story:7", update: { Name: "renamed" } },
      { from: "Story:8:123", execute: "QuickClose" }
    ]);
    expect(outcome).toMatchObject({ created: ["Story:1000"], modified: ["Story:7"], operated: ["Story:8"], failures: [] });
    expect((await fake.send([{ AssetType: "Task", Name: "t" }])).created).toEqual(["Task:1001"]);
    // As sent: the Ref is written as its OID token.
    expect(fake.sent[0]![0]).toEqual({ AssetType: "Story", Name: "new", Scope: "Scope:0" });
    expect(fake.sent).toHaveLength(2);
  });

  it("onSend scripts an outcome, failures included: returned by default, thrown with throwOnFailure, parsed like the server's", async () => {
    const fake = new FakeAgilityClient().onSend({ failures: [{ index: 0, message: "Violation'Required'AttributeDefinition'Scope'Story" }] });
    const outcome = await fake.send([{ AssetType: "Story", Name: "x" }]);
    expect(outcome.failures[0]).toMatchObject({ index: 0, violation: { rule: "Required", attribute: "Story.Scope" } });
    await expect(fake.send([{ AssetType: "Story", Name: "x" }], { throwOnFailure: true })).rejects.toBeInstanceOf(CommandFailureError);
    fake.onSend((commands) => ({ created: commands.map((_, i) => `Story:${50 + i}`) }));
    expect((await fake.send([{ AssetType: "Story", Name: "a" }, { AssetType: "Story", Name: "b" }])).created).toEqual(["Story:50", "Story:51"]);
  });

  it("an Error as an answer is thrown, as the client would throw it", async () => {
    const fake = new FakeAgilityClient().onQuery("Story", apiErrorFromResponse(401, { error: "Unauthorized" })).onSend(new ApiError("down", 503));
    await expect(fake.query({ from: "Story", page: { size: 1, start: 0 } })).rejects.toMatchObject({ kind: "auth", status: 401, message: "Unauthorized" });
    await expect(fake.send([{ AssetType: "Story", Name: "x" }])).rejects.toMatchObject({ kind: "transient" });
  });

  it("onRequest answers any other endpoint by path, in the endpoint's shape, and an unscripted one is a UsageError", async () => {
    const fake = new FakeAgilityClient()
      .onRequest("/loc-2.v1", { "Plural'Story": "Backlog Items" })
      .onRequest(/^\/attachment\.img\/5$/, () => new Uint8Array([1, 2]));
    expect(await fake.localize(["Plural'Story"])).toEqual({ "Plural'Story": "Backlog Items" });
    fake.onQuery("Attachment", [{ _oid: "Attachment:5", Name: "n", Filename: "f.txt", ContentType: "text/plain" }]);
    expect((await fake.attachments.get(5)).bytes).toEqual(new Uint8Array([1, 2]));
    await expect(rest1.list(fake.transport, "Story", { page: { size: 1, start: 0 } })).rejects.toThrow(/no answer scripted for GET \/rest-1\.v1\/Data\/Story/);
  });

  it("a batch that creates and reads back through an alias answers the scripted row of that type under the created OID", async () => {
    const fake = new FakeAgilityClient().onQuery("Story", [{ _oid: "Story:1", Number: "S-01001", Name: "template" }]);
    const outcome = await fake.send([{ "@story": { AssetType: "Story", Name: "new", Scope: "Scope:0" } }, { from: "@story", select: ["Number"], page: { size: 1, start: 0 } }]);
    expect(outcome.created).toEqual(["Story:1000"]);
    // The scripted row stands in for what the server adds (the Number); what the create sent wins (the Name); a relation is not copied.
    expect(outcome.queryResults).toEqual([[{ _oid: "Story:1000", Number: "S-01001", Name: "new" }]]);
    await expect(new FakeAgilityClient().send([{ "@e": { AssetType: "Epic", Name: "x" } }, { from: "@e", page: { size: 1, start: 0 } }])).rejects.toThrow(/query of @e \(the Epic the batch creates\).*onQuery\("Epic"/);
  });

  it("resolve finds a number among every scripted row, whatever its type, and reports the rest missing; the test names no number root", async () => {
    const fake = new FakeAgilityClient()
      .onQuery("Story", [{ _oid: "Story:1", Number: "S-01001", Name: "Logon", AssetState: "Active" }])
      .onQuery("Defect", { rows: [{ _oid: "Defect:9", Number: "D-00009", Name: "Crash", AssetState: "Closed" }] });
    expect(await fake.resolve.numbers(["d-00009", "S-01001", "S-99999"])).toEqual({
      found: [{ _oid: "Defect:9", AssetType: "Defect", Number: "D-00009", Name: "Crash", AssetState: "Closed" }, { _oid: "Story:1", AssetType: "Story", Number: "S-01001", Name: "Logon", AssetState: "Active" }],
      missing: ["S-99999"]
    });
    expect(await fake.resolve.ref("S-01001")).toMatchObject({ _oid: "Story:1" });
    // A number of a type that is itself a number root (a Request), scripted like any other: found, and no other root needs a script (a CLI consumer's test).
    fake.onQuery("Request", [{ _oid: "Request:3", Number: "R-3", Name: "Faster export", AssetState: "Active" }]);
    expect(await fake.resolve.numbers(["R-3", "S-01001"])).toMatchObject({ found: [{ _oid: "Request:3", AssetType: "Request", Number: "R-3" }, { _oid: "Story:1" }], missing: [] });
    expect(await new FakeAgilityClient().resolve.ref("S-1")).toBeNull();
  });

  it("localize answers scripted labels and echoes any other tag, as loc-2 does, over GET and POST alike", async () => {
    const fake = new FakeAgilityClient().onLocalize({ Story: "Backlog Item" });
    expect(await fake.localize(["Story", "Plural'Epic"])).toEqual({ Story: "Backlog Item", "Plural'Epic": "Plural'Epic" });
    expect(await fake.localize(["Story", "Defect"], { maxGetLength: 0 })).toEqual({ Story: "Backlog Item", Defect: "Defect" });
  });

  it("fake.transport serves a client the code under test builds itself: it reads rows as scripted, with no asset type to script", async () => {
    const fake = new FakeAgilityClient().onQuery("Member", [{ _oid: "Member:20", Name: "Dana", IsSelf: true }]);
    const calls: string[] = [];
    const wrapped = new AgilityApiClient({ baseUrl: "https://x" }, { transport: { request: (o) => { calls.push(o.path); return fake.transport.request(o); } } });
    expect(await wrapped.query({ from: "Member", select: ["Name", "IsSelf"], page: { size: 1, start: 0 } })).toEqual([{ _oid: "Member:20", Name: "Dana", IsSelf: true }]);
    expect(calls).toEqual(["/meta.v1/Member", "/query.v1"]);
    expect(fake.asked).toHaveLength(1);
    expect(fake.requests.map((r) => r.path)).toEqual(["/query.v1"]); // the type load is the client's plumbing, not the test's subject
  });

  it("onList answers rest-1's list read (client.deleted, rest1.list) from rows in the model's shape: Refs, dotted paths, paging, the total and `more`, and the rows rule", async () => {
    const found = [
      { _oid: "Story:1", Name: "Logon", Number: "S-01001", AssetState: "Active", Owners: [{ _oid: "Member:20" }], "Owners.Name": ["Dana"], Status: null },
      { _oid: "Defect:9", Name: "Crash on logon", Number: "D-00009", AssetState: "Closed", Owners: [], Status: { _oid: "StoryStatus:5" } },
      { _oid: "Story:3", Name: "Logon help", Number: "S-01003", AssetState: "Active", Owners: [], Status: null }
    ];
    const fake = new FakeAgilityClient().onList("BaseAsset", found);
    const page = await rest1.list(fake.transport, "BaseAsset", { find: "logon", findin: ["Name"], select: ["Name", "Number", "AssetState", "Owners", "Owners.Name", "Status"], page: { size: 2, start: 0 }, needTotal: true });
    // As scripted, read back through the client's own rest-1 translation: a selected path is at row[path], and a Ref is bare.
    expect(page.rows).toEqual([found[0], found[1]]);
    expect(page).toMatchObject({ total: 3, more: true });
    expect((await rest1.list(fake.transport, "BaseAsset", { page: { size: 2, start: 2 }, needTotal: true })).rows).toEqual([found[2]]);
    // What a scripted Ref carries beyond its OID goes out as rest-1's display columns do, and is read back as live: at the path when it was selected, nowhere when it was not.
    fake.onList("Story", [{ _oid: "Story:1", Status: { _oid: "StoryStatus:1", Name: "Dev" }, Owners: [{ _oid: "Member:1", Name: "a", Nickname: "A" }, { _oid: "Member:2", Name: "b", Nickname: "B" }] }]);
    expect((await rest1.list(fake.transport, "Story", { select: ["Status", "Owners", "Owners.Name"], page: { size: 1, start: 0 } })).rows).toEqual([{ _oid: "Story:1", Status: { _oid: "StoryStatus:1" }, Owners: [{ _oid: "Member:1" }, { _oid: "Member:2" }], "Owners.Name": ["a", "b"] }]);
    expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/rest-1.v1/Data/BaseAsset", query: { find: "logon", findin: "Name", page: "2,0" } });
    // A function sees the type and rest-1's own query string, and answers one page.
    fake.onList((type, q) => type === "Story" && q.deleted === "true", () => ({ rows: [{ _oid: "Story:7", Name: "gone" }], total: 12 }));
    expect(await rest1.list(fake.transport, "Story", { deleted: true, page: { size: 1, start: 0 }, needTotal: true })).toMatchObject({ rows: [{ _oid: "Story:7", Name: "gone" }], total: 12, more: true });
    await expect(rest1.list(fake.transport, "Epic", { page: { size: 1, start: 0 } })).rejects.toThrow(/no answer scripted for GET \/rest-1\.v1\/Data\/Epic/);
  });

  it("with a metamodel the fake's instance has those types: a response captured from a server reads translated, for the fake and for a client built on its transport", async () => {
    const metamodel = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;
    // As query.v1 sent it (every scalar a string, a sub-selected single relation a one-element list).
    const captured = [[{ _oid: "Story:1055:900", Name: "Sample: Logon", Estimate: "2", IsClosed: "True", Status: [{ _oid: "StoryStatus:137", Name: "Accepted" }], Super: { _oid: "NULL" } }]];
    const fake = new FakeAgilityClient({ metamodel }).onRequest("/query.v1", captured);
    const q = { from: "Story", select: ["Name", "Estimate", "IsClosed", { from: "Status", select: ["Name"] }, "Super"], page: { size: 1, start: 0 } };
    const expected = [{ _oid: "Story:1055", Name: "Sample: Logon", Estimate: 2, IsClosed: true, Status: { _oid: "StoryStatus:137", Name: "Accepted" }, Super: null }];
    expect(await fake.query(q)).toEqual(expected);
    const wrapped = new AgilityApiClient({ baseUrl: "https://x" }, { transport: fake.transport });
    expect(await wrapped.query(q)).toEqual(expected);
    // Rows scripted in the model's shape still read as scripted, and the type loads are not in `requests`.
    const scripted = new FakeAgilityClient({ metamodel }).onQuery("Story", [{ _oid: "Story:1", Name: "n", Estimate: 3, IsClosed: false, Status: null }]);
    expect(await scripted.query({ from: "Story", select: ["Name", "Estimate", "IsClosed", "Status"], page: { size: 1, start: 0 } })).toEqual([{ _oid: "Story:1", Name: "n", Estimate: 3, IsClosed: false, Status: null }]);
    expect(scripted.requests.map((r) => r.path)).toEqual(["/query.v1"]);
    expect((await scripted.meta.assetType("Story")).Token).toBe("Story");
    // A subset is enough: only the types the code under test touches, with no Version. A type left out does not exist there.
    const { Story, StoryStatus } = metamodel.AssetTypes;
    const subset = new FakeAgilityClient({ metamodel: { AssetTypes: { Story: Story!, StoryStatus: StoryStatus! } } }).onRequest("/query.v1", captured);
    expect(await subset.query(q)).toEqual(expected);
    await expect(scripted.meta.assetType("NoSuchType")).rejects.toMatchObject({ kind: "notFound" });
  });

  it("sendGuarded on the fake: applies at the asset's moment, conflicts after someone else touched it or when it is gone, and honours a moment the caller holds", async () => {
    const fake = new FakeAgilityClient().onQuery("Story", [{ _oid: "Story:1", Name: "One", Estimate: 3 }, { _oid: "Story:2", Name: "Two", Estimate: 5 }]);
    const first = await fake.sendGuarded([{ from: "Story:1", update: { Estimate: 8 } }, { from: "Story:2", execute: "QuickClose" }]);
    expect(first).toMatchObject({ modified: ["Story:1"], operated: ["Story:2"], conflicts: [], touched: ["Story:1", "Story:2"], details: { stamps: { "Story:1": "1", "Story:2": "1" } } });
    // What the person saw, then someone else's change, then their click.
    const seen = (await fake.get<{ _oid: string; Moment: string }>("Story:1", ["Moment"]))!.Moment;
    fake.touch("Story:1");
    expect(await fake.sendGuarded([{ from: "Story:1", update: { Estimate: 9 } }], { moments: { "Story:1": seen } })).toMatchObject({ modified: [], conflicts: ["Story:1"] });
    await expect(fake.sendGuarded([{ from: "Story:1", update: { Estimate: 9 } }], { moments: { "Story:1": seen }, throwOnFailure: true })).rejects.toBeInstanceOf(ConflictError);
    // Read now, it applies; an asset that is gone, or that nothing was scripted for, is a conflict.
    expect(await fake.sendGuarded([{ from: "Story:1", update: { Estimate: 9 } }])).toMatchObject({ modified: ["Story:1"], conflicts: [] });
    fake.remove("Story:2");
    expect(await fake.sendGuarded([{ from: "Story:2", execute: "Reactivate" }, { from: "Story:404", update: { Name: "x" } }])).toMatchObject({ operated: [], modified: [], conflicts: ["Story:2", "Story:404"] });
    // A write scoped by a query cannot be previewed by a fake that evaluates no filter, and says so.
    await expect(fake.sendGuarded([{ from: "Story", filter: ["Estimate>'3'"], update: { Estimate: 1 } }])).rejects.toThrow(/cannot preview command 0.*scoped by a query/);
  });

  it("batch.run on the fake: a receipt with the scripted before values, Moment stamps and a reverse; reversible finds an asset drifted after someone touched it", async () => {
    const fake = new FakeAgilityClient().onQuery("Story", [{ _oid: "Story:1", Name: "One", Number: "S-1", Estimate: 3 }, { _oid: "Story:2", Name: "Two", Number: "S-2", Estimate: 5 }]);
    const receipt = await fake.batch.run([{ from: "Story:1", update: { Estimate: 8 } }, { from: "Story:2", update: { Estimate: 8 } }, { "@t": { AssetType: "Task", Name: "new", Parent: "Story:1" } }], { guard: true });
    expect(receipt).toMatchObject({ receipt: 2, sent: true, guarded: true, stopped: null, conflicts: [], failed: [], stamps: { "Story:1": "1", "Story:2": "1" }, after: { "Story:1": "2", "Story:2": "2", "Task:1000": "1" } });
    expect(receipt.before["Story:1"]).toMatchObject({ Estimate: 3, Moment: "1" });
    // The projection is in the server's form: a scalar as { add, remove }, which is what a listing of the preview shows live.
    expect(receipt.described.updates[0]).toEqual({ oid: "Story:1", attributes: { Estimate: { add: ["8"], remove: [] } } });
    expect(await fake.preview([{ from: "Story:1", execute: "QuickClose" }])).toEqual([{ "@fake-0": { oid: "Story:1", execute: { op: "QuickClose", args: {} } } }]);
    expect(receipt.created).toMatchObject([{ alias: "@t", AssetType: "Task", _oid: "Task:1000" }]);
    expect(receipt.reverse.commands).toEqual([{ from: "Story:1", update: { Estimate: 3 } }, { from: "Story:2", update: { Estimate: 3 + 2 } }, { from: "Task:1000", execute: "Delete" }]);
    expect((await fake.batch.reversible(receipt)).drifted).toEqual([]);
    fake.touch("Story:2");
    const undo = await fake.batch.reversible(receipt);
    expect(undo.drifted).toMatchObject([{ oid: "Story:2", was: "2", now: "3" }]);
    expect(undo.commands).toEqual([{ from: "Story:1", update: { Estimate: 3 } }, { from: "Task:1000", execute: "Delete" }]);
    // A conflict at send time is on the receipt, and a dry run sends nothing.
    fake.onQuery("Epic", [{ _oid: "Epic:9", Name: "Nine" }]);
    const racing = await fake.batch.run([{ from: "Epic:9", update: { Name: "x" } }], { guard: true, confirm: () => { fake.touch("Epic:9"); return true; } });
    expect(racing).toMatchObject({ sent: true, conflicts: ["Epic:9"], touched: [] });
    // Sent unguarded to an asset that is gone: the receipt's outcome says the command matched nothing.
    fake.remove("Epic:9");
    expect((await fake.batch.run([{ from: "Epic:9", update: { Name: "x" } }], { guard: false })).outcome).toMatchObject({ modified: [], unmatched: [0] });
    expect(await fake.batch.run([{ from: "Epic:9", update: { Name: "x" } }], { guard: true, dryRun: true })).toMatchObject({ sent: false, stopped: "dryRun" });
  });

  it("an aborted signal ends a read as ABORTED, like the fetch transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeAgilityClient().onQuery("Story", stories);
    await expect(fake.withSignal(controller.signal).query({ from: "Story", page: { size: 1, start: 0 } })).rejects.toMatchObject({ kind: "aborted" });
  });
});

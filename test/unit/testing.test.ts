import { describe, expect, expectTypeOf, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError, UsageError, apiErrorFromResponse } from "../../src/core/errors";
import { FakeAgilityClient } from "../../src/testing";
import { CommandFailureError } from "../../src/wire/assetApi";

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
    await expect(fake.query({ from: "Story" })).rejects.toThrow(/without a page/);
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
    const outcome = await fake.assets.send([
      { AssetType: "Story", Name: "new", Scope: { _oid: "Scope:0" } },
      { from: "Story:7", update: { Name: "renamed" } },
      { from: "Story:8:123", execute: "QuickClose" }
    ]);
    expect(outcome).toMatchObject({ created: ["Story:1000"], modified: ["Story:7"], operated: ["Story:8"], failures: [] });
    expect((await fake.assets.send([{ AssetType: "Task", Name: "t" }])).created).toEqual(["Task:1001"]);
    // As sent: the Ref is written as its OID token.
    expect(fake.sent[0]![0]).toEqual({ AssetType: "Story", Name: "new", Scope: "Scope:0" });
    expect(fake.sent).toHaveLength(2);
  });

  it("onSend scripts an outcome, failures included: returned by default, thrown with throwOnFailure, parsed like the server's", async () => {
    const fake = new FakeAgilityClient().onSend({ failures: [{ index: 0, message: "Violation'Required'AttributeDefinition'Scope'Story" }] });
    const outcome = await fake.assets.send([{ AssetType: "Story", Name: "x" }]);
    expect(outcome.failures[0]).toMatchObject({ index: 0, violation: { rule: "Required", attribute: "Story.Scope" } });
    await expect(fake.assets.send([{ AssetType: "Story", Name: "x" }], { throwOnFailure: true })).rejects.toBeInstanceOf(CommandFailureError);
    fake.onSend((commands) => ({ created: commands.map((_, i) => `Story:${50 + i}`) }));
    expect((await fake.assets.send([{ AssetType: "Story", Name: "a" }, { AssetType: "Story", Name: "b" }])).created).toEqual(["Story:50", "Story:51"]);
  });

  it("an Error as an answer is thrown, as the client would throw it", async () => {
    const fake = new FakeAgilityClient().onQuery("Story", apiErrorFromResponse(401, { error: "Unauthorized" })).onSend(new ApiError("down", 503));
    await expect(fake.query({ from: "Story", page: { size: 1, start: 0 } })).rejects.toMatchObject({ kind: "auth", status: 401, message: "Unauthorized" });
    await expect(fake.assets.send([{ AssetType: "Story", Name: "x" }])).rejects.toMatchObject({ kind: "transient" });
  });

  it("onRequest answers any other endpoint by path, in the endpoint's shape, and an unscripted one is a UsageError", async () => {
    const fake = new FakeAgilityClient()
      .onRequest("/loc-2.v1", { "Plural'Story": "Backlog Items" })
      .onRequest(/^\/attachment\.img\/5$/, () => new Uint8Array([1, 2]));
    expect(await fake.localize(["Plural'Story"])).toEqual({ "Plural'Story": "Backlog Items" });
    fake.onQuery("Attachment", [{ _oid: "Attachment:5", Name: "n", Filename: "f.txt", ContentType: "text/plain" }]);
    expect((await fake.attachments.get(5)).bytes).toEqual(new Uint8Array([1, 2]));
    await expect(fake.data.get("Story:1")).rejects.toThrow(/no answer scripted for GET \/rest-1\.v1\/Data\/Story\/1/);
  });

  it("an aborted signal ends a read as ABORTED, like the fetch transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeAgilityClient().onQuery("Story", stories);
    await expect(fake.withSignal(controller.signal).query({ from: "Story", page: { size: 1, start: 0 } })).rejects.toMatchObject({ kind: "aborted" });
  });
});

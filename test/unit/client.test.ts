import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError, UsageError } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import type { Story } from "../../src/types/assets/Story";
import { createFetchTransport } from "../../src/core/fetchTransport";
import { assetStateKind } from "../../src/types/asset";
import { CommandFailureError, unmatchedOf, type AssetApiResponse } from "../../src/wire/assetApi";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";

/**
 * The client's own composition: which endpoint each read goes to, that the
 * schema is loaded before a row is translated, and that a write answers in
 * the model's terms. Rows and envelopes are copied from live responses.
 */
const document = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;
const schema = () => Schema.fromMetamodel(toMetamodel(document));

function fake(answer: (o: RequestOptions) => unknown): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (o: RequestOptions) => { calls.push(o); return answer(o); });
  return { request: request as Transport["request"], calls };
}
const wireStory = { _oid: "Story:1055", Name: "Sample: Logon", Estimate: "2", IsClosed: "True", Status: [] };
const envelope = (over: Partial<AssetApiResponse> = {}): AssetApiResponse => ({
  requestId: "r", createdDate: "", completedDate: "", duration: "", durationSeconds: 0.1, complete: true, processing: false,
  assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
  commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: 0 }, ...over
});

describe("unmatched, asset state kinds and the fetch a transport calls", () => {
  it("unmatchedOf flags an update or operation by OID that is in neither list and has no failure; a query-scoped command, a failed one, and a failure nobody can place are not flagged", () => {
    const commands = [
      { from: "Story:1", update: { Name: "a" } },          // applied
      { from: "Story:2:77", update: { Name: "b" } },       // nothing: gone
      { from: "Conversation:3", execute: "Delete" },       // nothing: no such operation
      { from: "Story:4", execute: "QuickClose" },          // failed
      { from: "Story", filter: ["Number='S-0'"], update: { Name: "c" } }, // matching nothing is an answer
      { "@u": { from: "Story:5", update: { Name: "d" } } },  // aliased, by OID: counts like a bare one
      { from: "Story:6", select: ["Name"], page: { size: 1, start: 0 } },
      { AssetType: "Story", Name: "new" }
    ] as never[];
    const failure = (index: number | null) => ({ index, message: "x", violation: null, echoed: {} });
    expect(unmatchedOf(commands, { modified: ["Story:1:900"], operated: [], failures: [failure(3)] })).toEqual([1, 2, 5]);
    expect(unmatchedOf(commands, { modified: ["Story:1", "Story:5"], operated: [], failures: [failure(3)] })).toEqual([1, 2]);
    // An aliased write from another alias names no asset the request can show.
    expect(unmatchedOf([{ "@u": { from: "@s", update: { Name: "d" } } }] as never[], { modified: [], operated: [], failures: [] })).toEqual([]);
    expect(unmatchedOf(commands, { modified: ["Story:1"], operated: [], failures: [failure(null)] })).toEqual([]);
    // An update does not count as an operation, nor the reverse.
    expect(unmatchedOf([{ from: "Story:1", execute: "QuickClose" }], { modified: ["Story:1"], operated: [], failures: [] })).toEqual([0]);
  });

  it("assetStateKind names the five states whose meaning is established against a server, by name or code, and calls everything else other", () => {
    expect(["Active", 64, "64"].map(assetStateKind)).toEqual(["open", "open", "open"]);
    expect(["Closed", 128].map(assetStateKind)).toEqual(["closed", "closed"]);
    expect(["200", 200, "Template"].map(assetStateKind)).toEqual(["template", "template", "template"]); // the server sends "200"; Template is this SDK's name for it
    expect(["Deleted", 255].map(assetStateKind)).toEqual(["deleted", "deleted"]);
    expect(["Future", 0].map(assetStateKind)).toEqual(["future", "future"]); // not begun: not "open", which is Active alone
    // Not claimed: Dead (a range, not a state rows carry), a split story (dead, not deleted), Deprecated, the unknown.
    expect(["Dead", 192, "OldBrokenDownStory", 208, "Deprecated", "Whatever"].map(assetStateKind)).toEqual(Array(6).fill("other"));
    expect([null, undefined].map(assetStateKind)).toEqual([null, null]);
  });

  it("the fetch transport calls whatever the global fetch is when the request is made, so a stub installed after the client was built is used", async () => {
    const transport = createFetchTransport({ baseUrl: "https://x", retries: 0 });
    const original = globalThis.fetch;
    const stub = vi.fn(async () => new Response("[[]]", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      expect(await transport.request({ method: "POST", path: "/query.v1", body: [], responseType: "json" })).toEqual([[]]);
    } finally { globalThis.fetch = original; }
    expect(stub).toHaveBeenCalledOnce();
  });
});

describe("client: reads", () => {
  it("query goes to query.v1, idempotent, after loading the types it touches from meta.v1, and translates the rows", async () => {
    const t = fake((o) => (o.path.startsWith("/meta.v1/") ? document.AssetTypes[o.path.slice("/meta.v1/".length)] : [[wireStory]]));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t });
    const [row] = await client.query<Story>({ from: "Story", select: ["Name", "Estimate", "IsClosed", { from: "Status", select: ["Name"] }], page: { size: 1, start: 0 } });
    expect(row).toMatchObject({ _oid: "Story:1055", Estimate: 2, IsClosed: true, Status: null });
    const paths = t.calls.map((c) => c.path);
    expect(paths.filter((p) => p.startsWith("/meta.v1/"))).toEqual(expect.arrayContaining(["/meta.v1/Story", "/meta.v1/StoryStatus"]));
    expect(paths[paths.length - 1]).toBe("/query.v1");
    expect(t.calls[t.calls.length - 1]).toMatchObject({ method: "POST", idempotent: true });
  });

  it("get reads one asset by OID through query.v1 (the OID is the `from`), null when nothing has it; the OID loses its moment", async () => {
    const t = fake(() => [[wireStory]]);
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });
    const row = await client.get<Story>("Story:1055:777", ["Name"]);
    expect(row).toMatchObject({ _oid: "Story:1055", Name: "Sample: Logon" });
    expect(t.calls[0]!.body).toEqual([{ from: "Story:1055", select: ["Name"], page: { size: 1, start: 0 } }]);
    expect(await new AgilityApiClient({ baseUrl: "https://x" }, { transport: fake(() => [[]]), types: schema().cache }).get("Story:9")).toBeNull();
  });

  it("queryPage goes to api/asset with needTotal and answers rows, total and more", async () => {
    const t = fake(() => envelope({ queryResult: { results: [[wireStory, wireStory]], resultMetaData: [{ total: 5 }], count: 1 } }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });
    const page = await client.queryPage<Story>({ from: "Story", select: ["Estimate"], page: { size: 2, start: 2 } });
    expect(t.calls[0]).toMatchObject({ path: "/api/asset", method: "POST" });
    expect((t.calls[0]!.body as unknown[])[0]).toMatchObject({ needTotal: true });
    expect(page.rows.map((r) => r.Estimate)).toEqual([2, 2]);
    expect(page).toMatchObject({ total: 5, more: true });
  });

  it("pages walks query.v1 page by page, stops at a short page, and never reads past the limit; all collects the rows", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ _oid: `Story:${i}`, Name: `s${i}` }));
    const t = fake((o) => { const q = (o.body as { page: { size: number; start: number } }[])[0]!; return [rows.slice(q.page.start, q.page.start + q.page.size)]; });
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });
    const seen: number[] = [];
    for await (const page of client.pages({ from: "Story", select: ["Name"], page: { size: 3, start: 0 } })) seen.push(page.length);
    expect(seen).toEqual([3, 3, 1]);
    expect(t.calls.map((c) => (c.body as { page: unknown }[])[0]!.page)).toEqual([{ size: 3, start: 0 }, { size: 3, start: 3 }, { size: 3, start: 6 }]);
    const capped = await client.all({ from: "Story", select: ["Name"], page: { size: 3, start: 0 } }, { limit: 4 });
    expect(capped.map((r) => r._oid)).toEqual(["Story:0", "Story:1", "Story:2", "Story:3"]);
    expect(t.calls.slice(3).map((c) => (c.body as { page: unknown }[])[0]!.page)).toEqual([{ size: 3, start: 0 }, { size: 1, start: 3 }]);
    await expect(client.all({ from: "Story", select: ["Name"] } as never)).rejects.toBeInstanceOf(UsageError);
  });

  it("a search for nothing is a usage error on every read, before any request: the server would answer it with no rows", async () => {
    const t = fake(() => { throw new Error("nothing may be sent"); });
    const client = new AgilityApiClient({ baseUrl: "https://agility.example.com/I" }, { transport: t });
    const page = { size: 5, start: 0 };
    const empty = { from: "Story", select: ["Name"], find: "  ", findin: ["Name"], page };
    for (const read of [() => client.query(empty), () => client.queries([{ from: "Story", page }, empty]), () => client.queryPage(empty), () => client.all(empty), () => client.deleted("Story", { find: "", page })]) {
      await expect(read()).rejects.toMatchObject({ kind: "usage", status: 0, message: expect.stringContaining("empty `find`") });
    }
    expect(t.calls).toEqual([]);
  });

  it("me asks for the member whose IsSelf is true", async () => {
    const t = fake(() => [[{ _oid: "Member:1000", Name: "SDK Test Account", Username: "sdk-test-account", Nickname: "SDK", Email: "" }]]);
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });
    const me = await client.me();
    expect(me).toMatchObject({ _oid: "Member:1000", Username: "sdk-test-account" });
    expect((t.calls[0]!.body as unknown[])[0]).toMatchObject({ from: "Member", filter: ["IsSelf='true'"], page: { size: 1, start: 0 } });
    await expect(new AgilityApiClient({ baseUrl: "https://x" }, { transport: fake(() => [[]]), types: schema().cache }).me()).rejects.toMatchObject({ kind: "notFound" });
  });

  it("deleted takes a query's spelling (select, filter), sends rest-1's (sel, where), and asks for deleted assets only, with the total", async () => {
    // rest-1 writes a date its own way (three decimals; a midnight as the date alone): the client answers the model's spelling.
    const gone = { _type: "Asset", href: "", id: "Story:7", Attributes: { Name: { _type: "Attribute", name: "Name", value: "2011-09-20" }, ChangeDate: { _type: "Attribute", name: "ChangeDate", value: "2026-07-13T18:06:14.600" }, CreateDate: { _type: "Attribute", name: "CreateDate", value: "2011-09-20" } } };
    const t = fake(() => ({ _type: "Assets", pageSize: 2, pageStart: 0, Assets: [gone] }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });
    expect(await client.deleted("Story", { select: ["Name", "ChangeDate", "CreateDate"], filter: ["Scope='Scope:0'"], page: { size: 2, start: 0 } })).toEqual({
      // The Name is text that happens to look like a date: it is left alone, because the schema says what is a date.
      rows: [{ _oid: "Story:7", Name: "2011-09-20", ChangeDate: "2026-07-13T18:06:14.600", CreateDate: "2011-09-20T00:00:00.000" }], total: null, more: false
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/rest-1.v1/Data/Story", query: expect.objectContaining({ sel: "Name,ChangeDate,CreateDate", where: "Scope='Scope:0';IsDeleted='true'", page: "2,0", deleted: "true", needTotal: "true" }) });
    expect((client as unknown as { data?: unknown }).data).toBeUndefined();
  });
});

describe("client: writes", () => {
  it("assets.send answers an Outcome — created, modified, failures with their violations, query rows — never the envelope", async () => {
    const t = fake(() => envelope({
      assetsCreated: { oidTokens: ["Story:5:10"], count: 1 },
      commandFailures: { commands: [{ "@0f3c": { AssetType: "Story" }, error: { message: "Violation'Required'AttributeDefinition'Scope'Story", sourceCommandIndex: 1 } }], count: 1 },
      queryResult: { results: [[wireStory]], resultMetaData: [], count: 1 }
    }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });
    const outcome = await client.send<Story>([{ AssetType: "Story", Name: "a", Scope: "Scope:0" }, { AssetType: "Story" }, { from: "Story", select: ["Estimate"], page: { size: 1, start: 0 } }]);
    expect(outcome.created).toEqual(["Story:5"]);
    expect(outcome.requestId).toBe("r");
    expect(outcome.failures).toEqual([expect.objectContaining({ index: 1, violation: { rule: "Required", attribute: "Story.Scope", tag: "AttributeDefinition'Scope'Story" } })]);
    expect(outcome.queryResults).toEqual([[expect.objectContaining({ Estimate: 2 })]]);
    expect(outcome).not.toHaveProperty("assetsCreated");
    const failing = new AgilityApiClient({ baseUrl: "https://x" }, { transport: fake(() => envelope({ assetsCreated: { oidTokens: ["Story:5:10"], count: 1 }, commandFailures: { commands: [{ error: { message: "Violation'Required'AttributeDefinition'Scope'Story", sourceCommandIndex: 1 } }], count: 1 } })), types: schema().cache });
    const err = (await failing.send([{ AssetType: "Story", Name: "a", Scope: "Scope:0" }, { AssetType: "Story" }], { throwOnFailure: true }).catch((e: unknown) => e)) as CommandFailureError;
    expect(err).toBeInstanceOf(CommandFailureError);
    expect(err.kind).toBe("commandFailure");
    expect(err.outcome.created).toEqual(["Story:5"]);
  });
});

describe("client: urls", () => {
  const client = new AgilityApiClient({ baseUrl: "https://agility.example.com/MyInstance/" }, { transport: fake(() => { throw new ApiError("no", 0); }) });
  it("builds the asset page, attachment and embedded image URLs from the base URL; the asset page takes an OID or a Number", () => {
    expect(client.urls.asset("Story:1055:777")).toBe("https://agility.example.com/MyInstance/assetdetail.v1?oid=Story:1055");
    expect(client.urls.asset("S-01001")).toBe("https://agility.example.com/MyInstance/assetdetail.v1?Number=S-01001");
    expect(() => client.urls.asset("hello")).toThrow(UsageError);
    expect(client.urls.attachment("Attachment:9")).toBe("https://agility.example.com/MyInstance/attachment.img/9");
    expect(client.urls.embeddedImage(12)).toBe("https://agility.example.com/MyInstance/embedded.img/12");
  });
});

describe("client: data.operate, copy, data.template", () => {
  it("copy answers the copy's OID through rest-1; template reads New/<Type>", async () => {
    const t = fake((o) => (o.path.startsWith("/rest-1.v1/New/") ? { _type: "Asset", href: "", id: "", Attributes: { Scope: { _type: "Relation", name: "Scope", act: "set", value: { _type: "Asset", href: "", idref: "Scope:0" } } } } : { _type: "Asset", href: "", id: "Story:9:1" }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, types: schema().cache });
    expect(await client.copy("Story:1")).toBe("Story:9");
    expect(await client.operate("Story:1", "Inactivate")).toEqual({ oid: "Story:9", moment: "1" });
    const tpl = await client.template("Story", { ctx: "Scope:0" });
    expect(tpl.Scope).toEqual({ _oid: "Scope:0" });
  });
});

describe("outcomeOf: a partial envelope is a contract", () => {
  it("every field has a default, so a fake that sends only queryResult yields a complete Outcome", async () => {
    const { outcomeOf } = await import("../../src/wire/assetApi");
    const o = outcomeOf({ queryResult: { results: [[]], resultMetaData: [], count: 1 } } as never);
    expect(o).toEqual({ requestId: null, created: [], modified: [], operated: [], failures: [], queryResults: [[]], unmatched: [], durationSeconds: null });
  });
});


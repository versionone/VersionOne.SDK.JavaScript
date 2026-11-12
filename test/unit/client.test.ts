import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError, UsageError } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import type { Story } from "../../src/types/assets/Story";
import { CommandFailureError, type AssetApiResponse } from "../../src/wire/assetApi";
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
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema: schema() });
    const row = await client.get<Story>("Story:1055:777", ["Name"]);
    expect(row).toMatchObject({ _oid: "Story:1055", Name: "Sample: Logon" });
    expect(t.calls[0]!.body).toEqual([{ from: "Story:1055", select: ["Name"], page: { size: 1, start: 0 } }]);
    expect(await new AgilityApiClient({ baseUrl: "https://x" }, { transport: fake(() => [[]]), schema: schema() }).get("Story:9")).toBeNull();
  });

  it("queryPage goes to api/asset with needTotal and answers rows, total and more", async () => {
    const t = fake(() => envelope({ queryResult: { results: [[wireStory, wireStory]], resultMetaData: [{ total: 5 }], count: 1 } }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema: schema() });
    const page = await client.queryPage<Story>({ from: "Story", select: ["Estimate"], page: { size: 2, start: 2 } });
    expect(t.calls[0]).toMatchObject({ path: "/api/asset", method: "POST" });
    expect((t.calls[0]!.body as unknown[])[0]).toMatchObject({ needTotal: true });
    expect(page.rows.map((r) => r.Estimate)).toEqual([2, 2]);
    expect(page).toMatchObject({ total: 5, more: true });
  });

  it("pages walks query.v1 page by page, stops at a short page, and never reads past the limit; all collects the rows", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ _oid: `Story:${i}`, Name: `s${i}` }));
    const t = fake((o) => { const q = (o.body as { page: { size: number; start: number } }[])[0]!; return [rows.slice(q.page.start, q.page.start + q.page.size)]; });
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema: schema() });
    const seen: number[] = [];
    for await (const page of client.pages({ from: "Story", select: ["Name"], page: { size: 3, start: 0 } })) seen.push(page.length);
    expect(seen).toEqual([3, 3, 1]);
    expect(t.calls.map((c) => (c.body as { page: unknown }[])[0]!.page)).toEqual([{ size: 3, start: 0 }, { size: 3, start: 3 }, { size: 3, start: 6 }]);
    const capped = await client.all({ from: "Story", select: ["Name"], page: { size: 3, start: 0 } }, { limit: 4 });
    expect(capped.map((r) => r._oid)).toEqual(["Story:0", "Story:1", "Story:2", "Story:3"]);
    expect(t.calls.slice(3).map((c) => (c.body as { page: unknown }[])[0]!.page)).toEqual([{ size: 3, start: 0 }, { size: 1, start: 3 }]);
    await expect(client.all({ from: "Story", select: ["Name"] })).rejects.toBeInstanceOf(UsageError);
  });

  it("me asks for the member whose IsSelf is true", async () => {
    const t = fake(() => [[{ _oid: "Member:145820", Name: "API Docs Verification - Jim", Username: "api-docs-verifier-jim", Nickname: "Jim", Email: "" }]]);
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema: schema() });
    const me = await client.me();
    expect(me).toMatchObject({ _oid: "Member:145820", Username: "api-docs-verifier-jim" });
    expect((t.calls[0]!.body as unknown[])[0]).toMatchObject({ from: "Member", filter: ["IsSelf='true'"], page: { size: 1, start: 0 } });
    await expect(new AgilityApiClient({ baseUrl: "https://x" }, { transport: fake(() => [[]]), schema: schema() }).me()).rejects.toMatchObject({ kind: "notFound" });
  });

  it("data.list takes a query's spelling (select, filter) and sends rest-1's (sel, where); the old names still work", async () => {
    const t = fake(() => ({ _type: "Assets", pageSize: 2, pageStart: 0, Assets: [] }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t });
    await client.data.list("Story", { select: ["Name"], filter: ["AssetState='Closed'"], deleted: true, page: { size: 2, start: 0 } });
    await client.data.list("Story", { sel: ["Name"], where: ["AssetState='Closed'"], page: { size: 2, start: 0 } });
    for (const call of t.calls) expect(call).toMatchObject({ method: "GET", path: "/rest-1.v1/Data/Story", query: expect.objectContaining({ sel: "Name", where: "AssetState='Closed'", page: "2,0" }) });
    expect(t.calls[0]!.query).toMatchObject({ deleted: "true" });
  });
});

describe("client: writes", () => {
  it("assets.send answers an Outcome — created, modified, failures with their violations, query rows — never the envelope", async () => {
    const t = fake(() => envelope({
      assetsCreated: { oidTokens: ["Story:5:10"], count: 1 },
      commandFailures: { commands: [{ "@0f3c": { AssetType: "Story" }, error: { message: "Violation'Required'AttributeDefinition'Scope'Story", sourceCommandIndex: 1 } }], count: 1 },
      queryResult: { results: [[wireStory]], resultMetaData: [], count: 1 }
    }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema: schema() });
    const outcome = await client.assets.send<Story>([{ AssetType: "Story", Name: "a", Scope: "Scope:0" }, { AssetType: "Story" }, { from: "Story", select: ["Estimate"], page: { size: 1, start: 0 } }]);
    expect(outcome.created).toEqual(["Story:5"]);
    expect(outcome.failures).toEqual([expect.objectContaining({ index: 1, violation: { rule: "Required", attribute: "Story.Scope", tag: "AttributeDefinition'Scope'Story" } })]);
    expect(outcome.queryResults).toEqual([[expect.objectContaining({ Estimate: 2 })]]);
    expect(outcome).not.toHaveProperty("assetsCreated");
    const failing = new AgilityApiClient({ baseUrl: "https://x" }, { transport: fake(() => envelope({ assetsCreated: { oidTokens: ["Story:5:10"], count: 1 }, commandFailures: { commands: [{ error: { message: "Violation'Required'AttributeDefinition'Scope'Story", sourceCommandIndex: 1 } }], count: 1 } })), schema: schema() });
    const err = (await failing.assets.send([{ AssetType: "Story", Name: "a", Scope: "Scope:0" }, { AssetType: "Story" }], { throwOnFailure: true }).catch((e: unknown) => e)) as CommandFailureError;
    expect(err).toBeInstanceOf(CommandFailureError);
    expect(err.kind).toBe("commandFailure");
    expect(err.outcome.created).toEqual(["Story:5"]);
  });
});

describe("client: urls", () => {
  const client = new AgilityApiClient({ baseUrl: "https://www14.v1host.com/v1sdktesting/" }, { transport: fake(() => { throw new ApiError("no", 0); }) });
  it("builds the asset page, attachment and embedded image URLs from the base URL", () => {
    expect(client.urls.asset("Story:1055:777")).toBe("https://www14.v1host.com/v1sdktesting/assetdetail.v1?oid=Story:1055");
    expect(client.urls.attachment("Attachment:9")).toBe("https://www14.v1host.com/v1sdktesting/attachment.img/9");
    expect(client.urls.embeddedImage(12)).toBe("https://www14.v1host.com/v1sdktesting/embedded.img/12");
    expect(client.attachments.url(9)).toBe(client.urls.attachment(9));
  });
});

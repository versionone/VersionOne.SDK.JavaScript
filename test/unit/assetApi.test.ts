import { describe, expect, it, vi } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import type { Asset } from "../../src/types/asset";
import { ApiError } from "../../src/core/errors";
import type { Story } from "../../src/types/assets/Story";
import { CommandFailureError, failuresOf, type Command, fromWireRow, momentless, preview, queries, query, send, sendYaml, toWire, type AssetApiResponse } from "../../src/wire/assetApi";

// Rows in a canned envelope are whatever the fake server says; the model type is applied by the caller under test.
type AnyRow = Asset & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const envelope = (over: Partial<AssetApiResponse<AnyRow>> = {}): AssetApiResponse<AnyRow> => ({
  requestId: "r", createdDate: "t", completedDate: "t", duration: "0", durationSeconds: 0, complete: true, processing: false,
  assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
  commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: -1 }, ...over
});

/** A transport that records what it was asked and answers from a queue. */
function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => { calls.push(options); return answers.shift(); });
  return { request: request as Transport["request"], calls };
}

describe("assetApi: translation", () => {
  it("writes a Ref as its momentless OID token, a list of Refs as tokens, and leaves strings, aliases and scalars alone — recursively", () => {
    const wire = toWire([
      { "@story": { AssetType: "Story", Name: "New", Scope: { _oid: "Scope:0:12" }, Owners: [{ _oid: "Member:20", Name: "Jim" }, "Member:21"], Super: "@epic", Estimate: 3, Custom_Flag: true } },
      { from: "Story", filter: ["ID=$oids"], with: { $oids: [{ _oid: "Story:1" }, "Story:2"] }, update: { Owners: { add: [{ _oid: "Member:7" }], remove: ["Member:8"] } } }
    ]);
    expect(wire).toEqual([
      { "@story": { AssetType: "Story", Name: "New", Scope: "Scope:0", Owners: ["Member:20", "Member:21"], Super: "@epic", Estimate: 3, Custom_Flag: true } },
      { from: "Story", filter: ["ID=$oids"], with: { $oids: ["Story:1", "Story:2"] }, update: { Owners: { add: ["Member:7"], remove: ["Member:8"] } } }
    ]);
  });

  it("reads a query row without a schema as the endpoint spells it: relations stay Refs, OIDs lose their moment, scalars untouched (strings — see translate.test.ts for the schema-driven shape)", () => {
    const row = fromWireRow<Story>({ _oid: "Story:1:99", Name: "One", Estimate: "3", Owners: [{ _oid: "Member:20:5", Name: "Jim" }], Super: { _oid: "Epic:2" }, Status: null, "Status.Name": "Done" });
    expect(row).toEqual({ _oid: "Story:1", Name: "One", Estimate: "3", Owners: [{ _oid: "Member:20", Name: "Jim" }], Super: { _oid: "Epic:2" }, Status: null, "Status.Name": "Done" });
    expect(momentless("Story:1:99")).toBe("Story:1");
  });

  it("normalises failures to index and message whether the error is an object or a string", () => {
    const failures = failuresOf(envelope({ commandFailures: { count: 2, commands: [
      { "@a1b2": { from: "Story" }, error: { message: "Violation'Invalid'Link.Asset", sourceCommandIndex: 2, stackTrace: "   at …" } },
      { "@c3d4": {}, error: "nope" }
    ] } }));
    expect(failures).toEqual([
      { index: 2, message: "Violation'Invalid'Link.Asset", echoed: { "@a1b2": { from: "Story" } } },
      { index: null, message: "nope", echoed: { "@c3d4": {} } }
    ]);
  });
});

describe("assetApi: calls", () => {
  it("send posts the translated batch to /api/asset as JSON, previewOnly on the query string when asked, and translates query rows in the envelope", async () => {
    const t = fakeTransport(envelope({ assetsCreated: { oidTokens: ["Story:5"], count: 1 }, queryResult: { results: [[{ _oid: "Story:5:1", Number: "S-5", Super: { _oid: "Epic:2:3" } }]], resultMetaData: [], count: 1 } }));
    const res = await send<Story>(t, [{ "@s": { AssetType: "Story", Name: "x", Super: { _oid: "Epic:2" } } }, { from: "@s", select: ["Number", "Super"] }]);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/api/asset", responseType: "json", body: [{ "@s": { AssetType: "Story", Name: "x", Super: "Epic:2" } }, { from: "@s", select: ["Number", "Super"] }] });
    expect(t.calls[0]!.query).toBeUndefined();
    expect(res.assetsCreated.oidTokens).toEqual(["Story:5"]);
    expect(res.queryResult.results[0]![0]).toEqual({ _oid: "Story:5", Number: "S-5", Super: { _oid: "Epic:2" } });
    const p = fakeTransport([{ "@s": { AssetType: "Story" } }]);
    await preview(p, [{ "@s": { AssetType: "Story" } }]);
    expect(p.calls[0]!.query).toEqual({ previewOnly: "true" });
  });

  it("queries sends several queries in one request and returns one array per query in order, [] where nothing matched; a query without a page is refused before any request", async () => {
    const t = fakeTransport(envelope({ queryResult: { results: [[{ _oid: "Link:1", URL: "u" }], []], resultMetaData: [], count: -1 } }));
    const [links, comments] = await queries(t, [
      { from: "Link", select: ["URL"], page: { size: 5, start: 0 } },
      { from: "Expression", select: ["Content"], page: { size: 5, start: 0 } }
    ]);
    expect(links).toEqual([{ _oid: "Link:1", URL: "u" }]);
    expect(comments).toEqual([]);
    expect(t.calls).toHaveLength(1);
    const rows = await query(fakeTransport(envelope({ queryResult: { results: [[{ _oid: "Story:1" }]], resultMetaData: [], count: 1 } })), { from: "Story", select: ["Name"], page: { size: 1, start: 0 } });
    expect(rows).toEqual([{ _oid: "Story:1" }]);
    const unpaged = fakeTransport();
    await expect(query(unpaged, { from: "Story", select: ["Name"] })).rejects.toThrow(/without a page: every api\/asset read must be bounded/);
    expect(unpaged.calls).toHaveLength(0);
  });

  it("sendYaml posts the text as text/yaml; with previewOnly the server's parse comes back as commands", async () => {
    const t = fakeTransport([{ "@epic": { AssetType: "Epic", Name: "Y" } }]);
    const parsed = await sendYaml(t, '"@epic":\n  AssetType: Epic\n  Name: Y\n', { previewOnly: true });
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/api/asset", contentType: "text/yaml", query: { previewOnly: "true" }, body: '"@epic":\n  AssetType: Epic\n  Name: Y\n' });
    expect(parsed).toEqual([{ "@epic": { AssetType: "Epic", Name: "Y" } }]);
  });
});

describe("assetApi: command failures", () => {
  // A batch commits per command and answers 200 either way: the second
  // command failed, the first created Story:5. Shapes as the server sends
  // them (error object with sourceCommandIndex; echoed alias regenerated).
  const partial = () => envelope({
    assetsCreated: { oidTokens: ["Story:5:10"], count: 1 },
    commandFailures: { count: 1, commands: [{ "@0f3c": { AssetType: "Story" }, error: { message: "Violation'Required'Scope", sourceCommandIndex: 1, stackTrace: "   at …" } }] }
  });
  const batch: Command[] = [{ "@ok": { AssetType: "Story", Name: "x", Scope: "Scope:0" } }, { "@bad": { AssetType: "Story", Name: "y" } }];

  it("send returns failures inside the envelope by default — nothing thrown, successes readable", async () => {
    const res = await send(fakeTransport(partial()), batch);
    expect(res.assetsCreated.oidTokens).toEqual(["Story:5:10"]);
    expect(failuresOf(res)).toEqual([{ index: 1, message: "Violation'Required'Scope", echoed: { "@0f3c": { AssetType: "Story" } } }]);
  });

  it("with throwOnFailure, send throws a CommandFailureError carrying each failure by its index in the batch and the whole response, so what did commit is still known", async () => {
    const err = await send(fakeTransport(partial()), batch, { throwOnFailure: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandFailureError);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as CommandFailureError;
    expect(e.message).toBe("Violation'Required'Scope");
    expect(e.status).toBe(200);
    expect(e.code).toBe("CommandFailure");
    expect(e.failures).toEqual([{ index: 1, message: "Violation'Required'Scope", echoed: { "@0f3c": { AssetType: "Story" } } }]);
    expect(e.failures[0]).not.toHaveProperty("stackTrace");
    expect(e.response.assetsCreated.oidTokens).toEqual(["Story:5:10"]);
  });

  it("with throwOnFailure and no failures, send returns the envelope as usual", async () => {
    const res = await send(fakeTransport(envelope({ assetsCreated: { oidTokens: ["Story:6"], count: 1 } })), batch, { throwOnFailure: true });
    expect(res.assetsCreated.oidTokens).toEqual(["Story:6"]);
  });

  it("joins several failures' messages, string errors included, and keeps a null index where the server gave none", async () => {
    const t = fakeTransport(envelope({ commandFailures: { count: 2, commands: [
      { "@a": {}, error: { message: "first", sourceCommandIndex: 0 } },
      { "@b": {}, error: "second" }
    ] } }));
    const e = (await send(t, batch, { throwOnFailure: true }).catch((x: unknown) => x)) as CommandFailureError;
    expect(e.message).toBe("first; second");
    expect(e.failures.map((f) => f.index)).toEqual([0, null]);
  });

  it("a cascade — one failed create failing its descendants — keeps every failure under the one source index, root cause first (docs: asset-bulk/errors)", async () => {
    const t = fakeTransport(envelope({ commandFailures: { count: 3, commands: [
      { "@epic": { AssetType: "Epic", Scope: "Scope:9999", Name: "E" }, error: { message: "Violation'Invalid'Epic.Scope", sourceCommandIndex: 0 } },
      { "@story": { AssetType: "Story", Name: "S", "#ContextOid": "@epic" }, error: { message: "Invalid OID token: @epic", sourceCommandIndex: 0 } },
      { "@task": { AssetType: "Task", Name: "T", "#ContextOid": "@story" }, error: { message: "Invalid OID token: @story", sourceCommandIndex: 0 } }
    ] } }));
    const e = (await send(t, [{ AssetType: "Epic", Scope: "Scope:9999", Name: "E" }], { throwOnFailure: true }).catch((x: unknown) => x)) as CommandFailureError;
    expect(e.failures.map((f) => f.index)).toEqual([0, 0, 0]);
    expect(e.message).toBe("Violation'Invalid'Epic.Scope; Invalid OID token: @epic; Invalid OID token: @story");
    // The resubmittable list is the response's own, verbatim.
    expect(e.response.commandFailures.commands).toHaveLength(3);
  });

  it("a query the server rejects throws from query/queries instead of reading as no rows — a failure must never look like an empty result", async () => {
    // The control: a query that matched nothing really is [].
    const empty = await query(fakeTransport(envelope({ queryResult: { results: [[]], resultMetaData: [], count: 0 } })), { from: "Story", select: ["Name"], page: { size: 1, start: 0 } });
    expect(empty).toEqual([]);
    const rejected = fakeTransport(envelope({
      commandFailures: { count: 1, commands: [{ "@9a1e": { from: "Story" }, error: { message: "Invalid token 'Nmae'", sourceCommandIndex: 1 } }] },
      queryResult: { results: [[{ _oid: "Link:1" }], []], resultMetaData: [], count: -1 }
    }));
    const err = (await queries(rejected, [
      { from: "Link", select: ["URL"], page: { size: 5, start: 0 } },
      { from: "Story", select: ["Nmae"], page: { size: 5, start: 0 } }
    ]).catch((e: unknown) => e)) as CommandFailureError;
    expect(err).toBeInstanceOf(CommandFailureError);
    expect(err.failures[0]!.index).toBe(1);
    expect(err.response.queryResult.results[0]).toEqual([{ _oid: "Link:1" }]);
  });
});

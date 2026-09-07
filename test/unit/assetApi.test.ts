import { describe, expect, it, vi } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import type { Asset } from "../../src/types/asset";
import type { Story } from "../../src/types/assets/Story";
import { failuresOf, fromWireRow, momentless, preview, queries, query, send, sendYaml, toWire, type AssetApiResponse } from "../../src/wire/assetApi";

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

  it("reads a query row as the model shape: relations stay Refs, OIDs lose their moment, scalars untouched", () => {
    const row = fromWireRow<Story>({ _oid: "Story:1:99", Name: "One", Estimate: 3, Owners: [{ _oid: "Member:20:5", Name: "Jim" }], Super: { _oid: "Epic:2" }, Status: null, "Status.Name": "Done" });
    expect(row).toEqual({ _oid: "Story:1", Name: "One", Estimate: 3, Owners: [{ _oid: "Member:20", Name: "Jim" }], Super: { _oid: "Epic:2" }, Status: null, "Status.Name": "Done" });
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

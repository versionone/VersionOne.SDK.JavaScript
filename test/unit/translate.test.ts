import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgilityApiClient } from "../../src/client";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import type { Story } from "../../src/types/assets/Story";
import { fromWireRow, send, type AssetApiResponse } from "../../src/wire/assetApi";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";

/**
 * Translation into the model, against rows copied verbatim from a dev
 * instance (2026-09-07): every scalar a string, a sub-selected single
 * relation a one-element list. The fake sends what the server sends.
 */
const metamodel = toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument);
const schema = Schema.fromMetamodel(metamodel);

const select = ["Name", "Estimate", "IsReadOnly", "IsDeleted", "IsClosed", "AssetState", "CreateDate", "CreateDateUTC", "Order", { from: "Status", select: ["Name", "Order"] }, { from: "Super", select: ["Name"] }, "Scope", "Status.Name", "Owners.@Count", "Children:Task.@Count", { from: "Owners", select: ["Name", "IsInactive"] }, "Owners.Name"];

// Story:1226 as api/asset rendered it (Status.Order and Owners.IsInactive added in the same spelling).
const liveRow = {
  _oid: "Story:1226:4021",
  Name: "Ship Order",
  Estimate: "5",
  IsReadOnly: "False",
  IsDeleted: "False",
  IsClosed: "True",
  AssetState: "Closed",
  CreateDate: "2026-06-27T12:28:29.137",
  CreateDateUTC: "2026-06-27T16:28:29.137Z",
  Order: "-1989738965",
  Status: [{ _oid: "StoryStatus:2191", Name: "Accepted", Order: "3" }],
  Super: [{ _oid: "Epic:1185", Name: "Order Entry" }],
  Scope: { _oid: "Scope:1308" },
  "Status.Name": "Accepted",
  "Owners.@Count": "1",
  "Children:Task.@Count": "3",
  Owners: [{ _oid: "Member:1039:77", Name: "Danny Developer", IsInactive: "False" }],
  "Owners.Name": ["Danny Developer"]
};
// Story:2356: nothing set.
const emptyRow = { _oid: "Story:2356", Name: "Assign help tickets to Tags", Estimate: null, IsReadOnly: "False", Status: [], Super: [], Scope: { _oid: "Scope:0" }, Owners: [], "Owners.Name": [], "Owners.@Count": "0", Custom_Flag: "True", Unknown: "x" };

describe("translate: a row into the model, by schema", () => {
  it("an unset single relation, which the endpoint sends as { _oid: \"NULL\" }, is null — with a schema and without (seen live on TeamRoom.Team, 2026-11-06)", () => {
    const wire = { _oid: "TeamRoom:17033", Name: "Team Room1", Team: { _oid: "NULL" } };
    expect(fromWireRow(wire, { lookup: schema, type: "TeamRoom" })).toEqual({ _oid: "TeamRoom:17033", Name: "Team Room1", Team: null });
    expect(fromWireRow(wire)).toEqual({ _oid: "TeamRoom:17033", Name: "Team Room1", Team: null });
    // A set one is still a Ref; a multi-value relation never carries a NULL entry.
    expect((fromWireRow({ _oid: "TeamRoom:57394", Team: { _oid: "Team:4094" } }, { lookup: schema, type: "TeamRoom" }) as unknown as Record<string, unknown>).Team).toEqual({ _oid: "Team:4094" });
    expect((fromWireRow({ _oid: "Story:1", Owners: [{ _oid: "NULL" }, { _oid: "Member:20" }] }, { lookup: schema, type: "Story" }) as unknown as Record<string, unknown>).Owners).toEqual([{ _oid: "Member:20" }]);
  });

  it("numbers become numbers, booleans booleans, a sub-selected single relation one Ref, a bare one stays a Ref, aggregates numbers, dates and states as sent", () => {
    const row = fromWireRow<Story>(liveRow, { lookup: schema, type: "Story" });
    expect(row._oid).toBe("Story:1226");
    expect(row.Name).toBe("Ship Order");
    expect(row.Estimate).toBe(5);
    expect(row.IsReadOnly).toBe(false);
    expect(row.IsDeleted).toBe(false);
    expect(row.IsClosed).toBe(true);
    expect(row.AssetState).toBe("Closed");
    expect(row.CreateDate).toBe("2026-06-27T12:28:29.137");
    expect(row.Order).toBe(-1989738965); // Rank: a 32-bit integer sent as a string, a number in the model
    expect(row.Status).toEqual({ _oid: "StoryStatus:2191", Name: "Accepted", Order: 3 }); // [x] -> x; the nested row is translated by StoryStatus (Order is Rank there too)
    expect(row.Super).toEqual({ _oid: "Epic:1185", Name: "Order Entry" });
    expect(row.Scope).toEqual({ _oid: "Scope:1308" });
    expect(row.Owners).toEqual([{ _oid: "Member:1039", Name: "Danny Developer", IsInactive: false }]); // nested rows translated by Member
    const r = row as unknown as Record<string, unknown>;
    expect(r["Status.Name"]).toBe("Accepted");
    expect(r["Owners.@Count"]).toBe(1);
    expect(r["Children:Task.@Count"]).toBe(3);
    expect(r["Owners.Name"]).toEqual(["Danny Developer"]);
  });

  it("an unset single relation becomes null, an unset scalar stays null, an empty list stays [], and a key the schema cannot resolve is left as sent", () => {
    const row = fromWireRow<Story>(emptyRow, { lookup: schema, type: "Story" });
    expect(row.Status).toBeNull();
    expect(row.Super).toBeNull();
    expect(row.Estimate).toBeNull();
    expect(row.IsReadOnly).toBe(false);
    expect(row.Owners).toEqual([]);
    const r = row as unknown as Record<string, unknown>;
    expect(r["Owners.@Count"]).toBe(0);
    expect(r.Custom_Flag).toBe("True"); // not in the canned metamodel: as sent, no guess
    expect(r.Unknown).toBe("x");
  });

  it("without a schema the row keeps the endpoint's spelling, OIDs normalised — the pass-through is explicit, never a guess", () => {
    const row = fromWireRow(liveRow) as unknown as Record<string, unknown>;
    expect(row._oid).toBe("Story:1226");
    expect(row.Estimate).toBe("5");
    expect(row.IsClosed).toBe("True");
    expect(row.Status).toEqual([{ _oid: "StoryStatus:2191", Name: "Accepted", Order: "3" }]);
    expect(row.Owners).toEqual([{ _oid: "Member:1039", Name: "Danny Developer", IsInactive: "False" }]);
  });

  it("a value that does not parse as its type is left as sent rather than turned into NaN", () => {
    const row = fromWireRow({ _oid: "Story:1", Estimate: "five", IsClosed: "maybe", "Owners.@Count": "" }, { lookup: schema, type: "Story" }) as unknown as Record<string, unknown>;
    expect(row.Estimate).toBe("five");
    expect(row.IsClosed).toBe("maybe");
    expect(row["Owners.@Count"]).toBe("");
  });
});

function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => { calls.push(options); return answers.shift(); });
  return { request: request as Transport["request"], calls };
}
const envelope = (results: unknown[][]): AssetApiResponse => ({
  requestId: "r", createdDate: "t", completedDate: "t", duration: "0", durationSeconds: 0, complete: true, processing: false,
  assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
  commandFailures: { commands: [], count: 0 }, queryResult: { results: results as never, resultMetaData: [], count: results.length }
});

describe("translate: through send and the client", () => {
  it("send translates each query's rows by that query's own type — results are positional over the query commands, writes between them do not shift the index", async () => {
    const t = fakeTransport(envelope([[{ _oid: "Story:1", Estimate: "5" }], [{ _oid: "Member:2", IsInactive: "True" }]]));
    const res = await send(t, [
      { from: "Story", select: ["Estimate"], page: { size: 1, start: 0 } },
      { from: "Story:9", update: { Name: "x" } },
      { "@m": { from: "Member", select: ["IsInactive"], page: { size: 1, start: 0 } } }
    ], { lookup: schema });
    expect(res.queryResult.results[0]).toEqual([{ _oid: "Story:1", Estimate: 5 }]);
    expect(res.queryResult.results[1]).toEqual([{ _oid: "Member:2", IsInactive: true }]);
  });

  it("the client loads the types a query touches from meta.v1 before sending it, then translates: one meta request per type, then the query", async () => {
    const metaDoc = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;
    const t = fakeTransport(metaDoc.AssetTypes.Story, metaDoc.AssetTypes.StoryStatus, envelope([[liveRow]]));
    const client = new AgilityApiClient({ baseUrl: "http://x" }, { transport: t });
    const [row] = await client.assets.query<Story>({ from: "Story", select: ["Estimate", { from: "Status", select: ["Name"] }], page: { size: 1, start: 0 } });
    expect(t.calls.map((c) => c.path)).toEqual(["/meta.v1/Story", "/meta.v1/StoryStatus", "/api/asset"]);
    expect(row!.Estimate).toBe(5);
    expect(row!.Status).toEqual({ _oid: "StoryStatus:2191", Name: "Accepted", Order: 3 });
    // A seeded client fetches no meta at all.
    const seeded = new AgilityApiClient({ baseUrl: "http://x" }, { transport: fakeTransport(envelope([[liveRow]])), metamodel });
    const [again] = await seeded.assets.query<Story>({ from: "Story", select: ["Estimate"], page: { size: 1, start: 0 } });
    expect(again!.IsClosed).toBe(true);
  });
});

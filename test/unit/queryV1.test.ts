import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";
import { queries, query } from "../../src/wire/queryV1";

const schema = Schema.fromMetamodel(toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument));

function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => {
    calls.push(options);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { request: request as Transport["request"], calls };
}

// A row as query.v1 sent it from the API-testing instance (2026-11-06).
const wireStory = { _oid: "Story:1055", Name: "Sample: Logon", Number: "S-01001", Estimate: "2", IsClosed: "True", Scope: { _oid: "Scope:1121" }, Owners: [{ _oid: "Member:1008" }, { _oid: "Member:11576" }], Status: [] };
const storyQuery = { from: "Story", select: ["Name", "Number", "Estimate", "IsClosed", "Scope", "Owners", { from: "Status", select: ["Name"] }], page: { size: 2, start: 0 } };

describe("queryV1", () => {
  it("POSTs the queries to query.v1 as a list, marked idempotent (the endpoint cannot write), and returns one array per query", async () => {
    const t = fakeTransport([[wireStory], []]);
    const [stories, scopes] = await queries(t, [storyQuery, { from: "Scope", select: ["Name"], filter: ["Name=$n"], with: { $n: "a—b" }, page: { size: 1, start: 0 } }]);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/query.v1", idempotent: true, responseType: "json" });
    expect(Array.isArray(t.calls[0]!.body)).toBe(true);
    expect(stories).toHaveLength(1);
    expect(scopes).toEqual([]);
  });

  it("without a schema, rows keep the endpoint's spelling; with one, they arrive in the model's shape", async () => {
    const [raw] = await query(fakeTransport([[wireStory]]), storyQuery);
    expect(raw).toMatchObject({ Estimate: "2", IsClosed: "True", Status: [] });
    const [row] = await query(fakeTransport([[wireStory]]), storyQuery, { lookup: schema });
    expect(row).toMatchObject({ _oid: "Story:1055", Estimate: 2, IsClosed: true, Scope: { _oid: "Scope:1121" }, Owners: [{ _oid: "Member:1008" }, { _oid: "Member:11576" }], Status: null });
  });

  it("refuses an unpaged query before sending anything", async () => {
    const t = fakeTransport();
    await expect(queries(t, [{ from: "Story", select: ["Name"] }])).rejects.toThrow(/without a page/);
    expect(t.calls).toHaveLength(0);
  });

  it("a refused query throws with the server's messages, not 'Bad Request' — never an empty result", async () => {
    // As sent for select: ["Nope"] (2026-11-06): the whole request fails, no rows for the good queries.
    const t = fakeTransport(new ApiError("Bad Request", 400, undefined, { error: "Bad Request", exceptions: [{ type: "MetaException", message: "Unknown AttributeDefinition: Story.Nope" }] }));
    const err = (await queries(t, [storyQuery, { from: "Story", select: ["Nope"], page: { size: 1, start: 0 } }]).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "QUERY_REJECTED", kind: "invalid", message: "Unknown AttributeDefinition: Story.Nope" });
    expect(err.details).toEqual([{ type: "MetaException", message: "Unknown AttributeDefinition: Story.Nope" }]);
  });

  it("a response that does not hold one array per query is an error, not a guess", async () => {
    await expect(queries(fakeTransport([[wireStory]]), [storyQuery, storyQuery])).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    await expect(queries(fakeTransport({ oops: true }), [storyQuery])).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("client.query loads the types its queries touch and translates through the client's schema", async () => {
    const t = fakeTransport([[wireStory]]);
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema });
    const [row] = await client.query(storyQuery);
    expect(row).toMatchObject({ Estimate: 2, IsClosed: true });
    expect(t.calls.map((c) => c.path)).toEqual(["/query.v1"]);
  });
});

describe("queryV1: group queries", () => {
  // Shape copied from a live response (a chat-bot consumer's board query on the API-testing instance, 2026-11-07).
  const grouped = [[
    { _oid: "NULL", _children: [{ _oid: "Story:10471:900", Name: "No status", Status: { _oid: "NULL" }, "Team.HasProcess": "False", Estimate: "3" }] },
    { _oid: "StoryStatus:134", _children: [{ _oid: "Story:10472", Name: "Done", Status: { _oid: "StoryStatus:134" }, "Team.HasProcess": "True", Estimate: "5" }] }
  ]];
  const q = { from: "PrimaryWorkitem", select: ["Name", "Status", "Team.HasProcess", "Estimate"], group: [{ from: "Status" }], page: { size: 100, start: 0 } };

  it("translates each group's _children by the query's type, and the no-status group's key reads as null", async () => {
    const [groups] = await queries(fakeTransport(grouped), [q], { lookup: schema });
    expect(groups).toEqual([
      { _oid: null, _children: [{ _oid: "Story:10471", Name: "No status", Status: null, "Team.HasProcess": false, Estimate: 3 }] },
      { _oid: "StoryStatus:134", _children: [{ _oid: "Story:10472", Name: "Done", Status: { _oid: "StoryStatus:134" }, "Team.HasProcess": true, Estimate: 5 }] }
    ]);
  });

  it("nested groups translate all the way down", async () => {
    const nested = [[{ _oid: "Team:1", _children: [{ _oid: "NULL", _children: [{ _oid: "Story:1", "Team.HasProcess": "True" }] }] }]];
    const [groups] = await queries(fakeTransport(nested), [{ ...q, group: [{ from: "Team" }, { from: "Status" }] }], { lookup: schema });
    expect(groups).toEqual([{ _oid: "Team:1", _children: [{ _oid: null, _children: [{ _oid: "Story:1", "Team.HasProcess": true }] }] }]);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { CHUNK, NUMBER_ROOTS, isAssetNumber, resolveNumbers, resolveRef } from "../../src/services/resolve";
import { TypeCache } from "../../src/services/schema";
import type { MetamodelDocument } from "../../src/wire/meta";

const envelope = (results: unknown[][], failures: unknown[] = []) => ({
  requestId: "r", createdDate: "t", completedDate: "t", duration: "0", durationSeconds: 0, complete: true, processing: false,
  assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
  commandFailures: { commands: failures, count: failures.length }, queryResult: { results, resultMetaData: [], count: -1 }
});
/** One result array per root, all empty except the ones given by root name. */
const ROOTS = Object.keys(NUMBER_ROOTS);
const answer = (rows: Partial<Record<string, unknown[]>>, roots: readonly string[] = ROOTS) => envelope(roots.map((r) => rows[r] ?? []));
function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => { calls.push(options); return answers.shift(); });
  return { request: request as Transport["request"], calls };
}
type Sent = { from: string; filter: string[]; with: Record<string, string[]>; page: { size: number } }[];

describe("resolve", () => {
  it("the number roots are exactly the metamodel's types whose Number is their own definition, each selecting only what it has — recomputed, so neither can drift", () => {
    const m = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;
    const expected = Object.fromEntries(Object.entries(m.AssetTypes)
      .filter(([t, d]) => { const a = d.Attributes[`${t}.Number`]; return a && !a.Base; })
      .map(([t, d]) => [t, ["Number", ...["Name", "AssetState"].filter((x) => `${t}.${x}` in d.Attributes)]]));
    expect(NUMBER_ROOTS).toEqual(expected);
  });

  it("asks every root for every number in one request, the numbers as a `with` list (data, not filter grammar), bounded by a page", async () => {
    // Rows as the server spells them (live, 2026-11-04): AssetState by name, OIDs with moments.
    const t = fakeTransport(answer({ Workitem: [{ _oid: "Story:145845:9", Name: "One", Number: "S-21622", AssetState: "Active" }], Issue: [{ _oid: "Issue:7", Name: "Two", Number: "I-01001", AssetState: "Closed" }] }));
    const res = await resolveNumbers(t, ["s-21622", "I-01001", "S-99999999", "S-21622"]);
    expect(t.calls).toHaveLength(1);
    const sent = t.calls[0]!.body as Sent;
    expect(sent.map((q) => q.from)).toEqual(ROOTS);
    for (const q of sent) {
      expect(q.filter).toEqual(["Number=$numbers"]);
      expect(q.with.$numbers).toEqual(["s-21622", "I-01001", "S-99999999"]);
      expect(q.page.size).toBe(3);
    }
    expect(res.found).toEqual([
      { number: "S-21622", oid: "Story:145845", type: "Story", name: "One", assetState: "Active" },
      { number: "I-01001", oid: "Issue:7", type: "Issue", name: "Two", assetState: "Closed" }
    ]);
    expect(res.missing).toEqual(["S-99999999"]);
  });

  it("sends nothing for no numbers, refuses text that is not a number, and chunks a long list", async () => {
    const none = fakeTransport();
    expect(await resolveNumbers(none, [])).toEqual({ found: [], missing: [] });
    expect(none.calls).toHaveLength(0);
    await expect(resolveNumbers(none, ["S-1", "Story:1", "hello"])).rejects.toThrow(/not asset numbers .*Story:1, hello/);
    const many = Array.from({ length: CHUNK + 1 }, (_, i) => `S-${i + 1}`);
    const t = fakeTransport(answer({}), answer({}));
    expect((await resolveNumbers(t, many)).missing).toHaveLength(CHUNK + 1);
    expect(t.calls.map((c) => (c.body as Sent)[0]!.with.$numbers!.length)).toEqual([CHUNK, 1]);
  });

  it("an instance without one of the roots: the query for it fails alone, the server drops its slot; the root is remembered as absent and the request asked again, once", async () => {
    const roots = ROOTS.filter((r) => r !== "Okr");
    const missingOkr = envelope(roots.map(() => []), [{ "@x$auto-aliased": { from: "Okr" }, error: { message: "Unknown AssetType: Okr", sourceCommandIndex: ROOTS.indexOf("Okr") } }]);
    const t = fakeTransport(missingOkr, answer({ Workitem: [{ _oid: "Story:1", Name: "A", Number: "S-1", AssetState: "Active" }] }, roots), answer({}, roots));
    expect((await resolveNumbers(t, ["S-1"])).found.map((f) => f.oid)).toEqual(["Story:1"]);
    expect((t.calls[1]!.body as Sent).map((q) => q.from)).toEqual(roots);
    // Remembered for this transport: the next call does not ask Okr at all.
    await resolveNumbers(t, ["S-2"]);
    expect((t.calls[2]!.body as Sent).map((q) => q.from)).toEqual(roots);
  });

  it("with a TypeCache, an absent root is the cache's record (null), so a new client and transport sharing the cache never asks it again", async () => {
    const roots = ROOTS.filter((r) => r !== "Okr");
    const missingOkr = envelope(roots.map(() => []), [{ "@x$auto-aliased": { from: "Okr" }, error: { message: "Unknown AssetType: Okr", sourceCommandIndex: ROOTS.indexOf("Okr") } }]);
    const types = new TypeCache();
    const alice = fakeTransport(missingOkr, answer({}, roots));
    await resolveNumbers(alice, ["S-1"], { types });
    expect(types.types.get("Okr")).toBeNull();
    // Bob: another user, another transport, the same instance.
    const bob = fakeTransport(answer({ Workitem: [{ _oid: "Task:1096", Name: "Template task", Number: "TK-01001", AssetState: "200" }] }, roots));
    const found = await resolveNumbers(bob, ["TK-01001"], { types });
    expect(bob.calls).toHaveLength(1);
    expect((bob.calls[0]!.body as Sent).map((q) => q.from)).toEqual(roots);
    // A template's state comes back as its code; it reads by name.
    expect(found.found[0]!.assetState).toBe("Template");
  });

  it("any other failure is the caller's to see", async () => {
    const t = fakeTransport(envelope(ROOTS.slice(1).map(() => []), [{ "@x": {}, error: { message: "Invalid QueryFilter2 token Number", sourceCommandIndex: 0 } }]));
    await expect(resolveNumbers(t, ["S-1"])).rejects.toThrow(/Invalid QueryFilter2/);
    expect(t.calls).toHaveLength(1);
  });

  it("resolveRef takes an OID token as is, without a request; a number by resolving it; null when nothing has that number; anything else is a TypeError", async () => {
    const none = fakeTransport();
    expect(await resolveRef(none, " Story:1234:55 ")).toEqual({ number: null, oid: "Story:1234", type: "Story", name: null, assetState: null });
    expect(none.calls).toHaveLength(0);
    expect(await resolveRef(fakeTransport(answer({ Workitem: [{ _oid: "Defect:9", Name: "D", Number: "D-9", AssetState: "Active" }] })), "d-9")).toMatchObject({ oid: "Defect:9", type: "Defect", number: "D-9" });
    expect(await resolveRef(fakeTransport(answer({})), "D-404")).toBeNull();
    await expect(resolveRef(none, "fix the thing")).rejects.toThrow(TypeError);
    expect(isAssetNumber("TK-12")).toBe(true);
    expect(isAssetNumber("S1234")).toBe(false);
    expect(isAssetNumber(" UTF-8 ")).toBe(true); // shaped like a number: resolves to missing, harmlessly
  });
});

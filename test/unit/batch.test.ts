import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe as group, expect, it, vi } from "vitest";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { BatchRecordError, BatchSendError, describe, reverseOf, reversible, runBatch, type Receipt } from "../../src/services/batch";
import { UnguardableError } from "../../src/services/guard";
import { Schema } from "../../src/services/schema";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";
import type { Command } from "../../src/wire/assetApi";

const schema = Schema.fromMetamodel(toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument));
const envelope = (over: Record<string, unknown> = {}) => ({
  requestId: "r", createdDate: "t", completedDate: "t", duration: "0", durationSeconds: 0.1, complete: true, processing: false,
  assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
  commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: -1 }, ...over
});
const rows = (r: unknown[]) => envelope({ queryResult: { results: [r], resultMetaData: [], count: r.length } });
type Q = { from?: string; select?: string[]; with?: { $oids?: string[] } };

/** A fake server that answers by what is asked: preview, a lookup by select, or the send. */
function server(handlers: { preview: Command[]; lookup: (q: Q) => unknown[]; send: (body: Command[]) => unknown }): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (o: RequestOptions) => {
    calls.push(o);
    if (o.query?.previewOnly) return handlers.preview;
    const body = o.body as Q[];
    if (body.length === 1 && body[0]!.select && body[0]!.with?.$oids) return rows(handlers.lookup(body[0]!));
    return handlers.send(o.body as Command[]);
  });
  return { request: request as Transport["request"], calls };
}

// The projection as the server spells it (live shapes, 2026-11-04).
const REQUEST: Command[] = [
  { "@t": { AssetType: "Task", Name: "new task", Parent: "Story:1" } },
  { from: "Story", filter: ["Number=$n"], with: { $n: ["S-1", "S-2"] }, update: { Estimate: 5, Owners: { add: ["Member:20"] } } },
  { from: "Epic:9", execute: "Inactivate" }
];
const PREVIEW = [
  { "@t": { AssetType: "Task", Name: "new task", Parent: "Story:1" } },
  { "@u1": { oid: "Story:1", update: { Estimate: { add: ["5"], remove: [] }, Owners: { add: ["Member:20"], remove: [] } } } },
  { "@u2": { oid: "Story:2", update: { Estimate: { add: ["5"], remove: [] }, Owners: { add: ["Member:20"], remove: [] } } } },
  { "@x": { oid: "Epic:9", execute: { op: "Inactivate", args: {} } } }
] as unknown as Command[];
const BEFORE: Record<string, Record<string, unknown>> = {
  "Story:1": { _oid: "Story:1:100", Estimate: "3", Owners: [], ChangeDate: "2026-11-04T16:00:00.1" },
  "Story:2": { _oid: "Story:2", Estimate: null, Owners: [{ _oid: "Member:20" }], ChangeDate: "2026-11-04T16:00:00.2" },
  "Epic:9": { _oid: "Epic:9", AssetState: "Active", ChangeDate: "2026-11-04T16:00:00.3" }
};
const NAMES: Record<string, { Name: string; Number: string }> = { "Story:1": { Name: "One", Number: "S-1" }, "Story:2": { Name: "Two", Number: "S-2" }, "Epic:9": { Name: "Nine", Number: "E-9" }, "Task:50": { Name: "new task", Number: "TK-50" } };
const AFTER: Record<string, string> = { "Task:50": "2026-11-04T17:00:00.5", "Story:1": "2026-11-04T17:00:00.1", "Epic:9": "2026-11-04T17:00:00.3" };
const lookup = (q: Q) => q.with!.$oids!.map((oid) => {
  if (q.select!.includes("Moment")) throw new Error("no Moment reads");
  if (q.select!.length === 1 && q.select![0] === "ChangeDate") return { _oid: oid, ChangeDate: AFTER[oid] };
  if (q.select!.includes("Name") || q.select!.includes("Number")) return { _oid: oid, ...Object.fromEntries(q.select!.map((a) => [a, NAMES[oid]?.[a as "Name"]])) };
  return BEFORE[oid];
});

group("batch", () => {
  it("describe reads creates and queries off the request, and updates and executes per asset off the projection", () => {
    const d = describe(REQUEST, PREVIEW);
    expect(d.creates).toEqual([{ index: 0, alias: "@t", type: "Task", name: "new task" }]);
    expect(d.updates.map((u) => u.oid)).toEqual(["Story:1", "Story:2"]);
    expect(d.executes).toEqual([{ oid: "Epic:9", op: "Inactivate", args: {} }]);
  });

  it("runBatch: preview, name, snapshot, send guarded on the snapshot's ChangeDates, then a receipt — created with alias and number, touched, skipped, after-stamps, reverse", async () => {
    let sent: Command[] = [];
    // Story:2 changed after the snapshot: its guarded update matches nothing.
    const t = server({ preview: PREVIEW, lookup, send: (b) => { sent = b; return envelope({ assetsCreated: { oidTokens: ["Task:50"], count: 1 }, assetsModified: { oidTokens: ["Story:1:101"], count: 1 }, assetsOperatedOn: { oidTokens: ["Epic:9"], count: 1 } }); } });
    const confirm = vi.fn((_r: Receipt) => true);
    const r = await runBatch(t, schema, REQUEST, { confirm });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]!.before["Story:1"]).toEqual({ Estimate: "3", Owners: [], ChangeDate: "2026-11-04T16:00:00.1" });
    expect(sent[1]).toEqual({ from: "Story", filter: ["ID=$oid", "ChangeDate='2026-11-04T16:00:00.1'"], with: { $oid: "Story:1" }, update: { Estimate: { add: ["5"], remove: [] }, Owners: { add: ["Member:20"], remove: [] } } });
    expect(t.calls.at(-3)!.idempotent).toBe(false); // the batch creates: never resent
    expect(r.sent && r.guarded).toBe(true);
    expect(r.created).toEqual([{ alias: "@t", type: "Task", oid: "Task:50", number: "TK-50", name: "new task" }]);
    expect(r.touched).toEqual([{ oid: "Story:1", number: "S-1", name: "One" }, { oid: "Epic:9", number: "E-9", name: "Nine" }]);
    expect(r.skipped).toEqual(["Story:2"]);
    expect(r.after).toEqual(AFTER);
    expect(r.reverse.commands).toEqual([
      { from: "Story:1", update: { Estimate: "3", Owners: { add: [], remove: ["Member:20"] } } },
      { from: "Epic:9", execute: "Reactivate" },
      { from: "Task:50", execute: "Delete" }
    ]);
  });

  it("reverseOf restores only what the response confirms: a null scalar is restored as null, a value already present is not removed, an unknown operation is a note", () => {
    const d = describe([], [
      { "@a": { oid: "Story:2", update: { Estimate: { add: ["5"], remove: [] }, Owners: { add: ["Member:20"], remove: [] } } } },
      { "@b": { oid: "Epic:9", execute: { op: "QuickClose", args: {} } } },
      { "@c": { oid: "Story:3", update: { Name: { add: ["x"], remove: [] } } } }
    ] as unknown as Command[]);
    const r = reverseOf(d, { "Story:2": { Estimate: null, Owners: ["Member:20"] }, "Epic:9": { AssetState: "Active" } }, { created: [], modified: ["Story:2"], operated: ["Epic:9"] });
    expect(r.commands).toEqual([{ from: "Story:2", update: { Estimate: null } }]);
    expect(r.notes.slice(1)).toEqual(["Epic:9: QuickClose has no known inverse (was Active)"]);
  });

  it("dryRun and a declined confirm send nothing; an unguardable batch is refused before any request unless guard is off", async () => {
    const t = server({ preview: PREVIEW, lookup, send: () => { throw new Error("must not send"); } });
    expect((await runBatch(t, schema, REQUEST, { dryRun: true })).sent).toBe(false);
    expect((await runBatch(t, schema, REQUEST, { confirm: () => false })).sent).toBe(false);
    const aliasedUpdate: Command[] = [{ "@u": { from: "Story:1", update: { Name: "x" } } }];
    const none = server({ preview: [], lookup, send: () => envelope() });
    await expect(runBatch(none, schema, aliasedUpdate)).rejects.toBeInstanceOf(UnguardableError);
    expect(none.calls).toHaveLength(0);
    expect((await runBatch(none, schema, aliasedUpdate, { guard: false })).guarded).toBe(false);
    await expect(runBatch(none, schema, [{ from: "@s", execute: "Delete" }], { guard: false })).rejects.toThrow(/rejected by the server/);
  });

  it("a send that fails outright throws BatchSendError carrying the receipt up to the attempt", async () => {
    const t = server({ preview: PREVIEW, lookup, send: () => { throw new Error("socket hang up"); } });
    const e = (await runBatch(t, schema, REQUEST).catch((x: unknown) => x)) as BatchSendError;
    expect(e).toBeInstanceOf(BatchSendError);
    expect(e.receipt.sentCommands).toHaveLength(4);
    expect(e.receipt.before["Epic:9"]).toBeDefined();
    expect(e.receipt.sent).toBe(false);
  });

  it("a batch of only aliased updates and executes is work: with guard off it is sent as written, noted as unsnapshotted, and left out of the reverse", async () => {
    // gh-v1's `apply` hit this: preview echoes aliased writes unexpanded, so nothing reads as per-asset work.
    const close: Command[] = [{ "@close": { from: "Story:20", execute: "QuickClose" } }];
    let sent: Command[] | undefined;
    const t = server({ preview: close, lookup: (q) => q.with!.$oids!.map((oid) => (q.select!.includes("Name") ? { _oid: oid, Name: "Twenty", Number: "S-20" } : { _oid: oid, ChangeDate: "2026-11-06T10:00:00.1" })), send: (body) => { sent = body; return envelope({ assetsOperatedOn: { oidTokens: ["Story:20:900"], count: 1 } }); } });
    const r = await runBatch(t, schema, close, { guard: false });
    expect(sent).toEqual(close);
    expect(r.sent).toBe(true);
    expect(r.described.deferred).toEqual([{ index: 0, alias: "@close", from: "Story:20", kind: "execute" }]);
    expect(r.touched).toEqual([{ oid: "Story:20", number: "S-20", name: "Twenty" }]); // named after the send: preview never listed it
    expect(r.after).toEqual({ "Story:20": "2026-11-06T10:00:00.1" });
    expect(r.notes.join("\n")).toMatch(/@close.*aliased execute.*not reversible/);
    expect(r.reverse.commands).toEqual([]);
    expect(r.reverse.notes.join("\n")).toMatch(/@close.*not reversed/);
  });

  it("confirm sees the touched assets' names on the receipt, looked up once; a failed name lookup is a note, not a silence", async () => {
    const t = server({ preview: PREVIEW, lookup, send: () => envelope({ assetsCreated: { oidTokens: ["Task:50"], count: 1 }, assetsModified: { oidTokens: ["Story:1"], count: 1 }, assetsOperatedOn: { oidTokens: ["Epic:9"], count: 1 } }) });
    let seen: Receipt["names"] | undefined;
    const r = await runBatch(t, schema, REQUEST, { confirm: (receipt) => { seen = receipt.names; return true; } });
    expect(seen).toEqual({ "Story:1": { number: "S-1", name: "One" }, "Story:2": { number: "S-2", name: "Two" }, "Epic:9": { number: "E-9", name: "Nine" } });
    const nameQueries = t.calls.filter((c) => (c.body as Q[])[0]?.select?.includes("Name") && (c.body as Q[])[0]?.with?.$oids?.some((o) => o.startsWith("Story")));
    expect(nameQueries).toHaveLength(1); // not again after the send
    expect(r.touched.map((x) => x.name)).toEqual(["One", "Nine"]);
    expect(r.notes).toEqual([]);

    const refusing = server({ preview: PREVIEW, lookup: (q) => { if (q.select!.includes("Name") && q.with!.$oids![0]!.startsWith("Epic")) throw new Error("Unknown AttributeDefinition: Epic.Name"); return lookup(q); }, send: () => envelope({ assetsOperatedOn: { oidTokens: ["Epic:9"], count: 1 } }) });
    const lookupFailed = (await runBatch(refusing, schema, REQUEST).catch((e: unknown) => e)) as Receipt;
    expect(lookupFailed.sent).toBe(true);
    expect(lookupFailed.notes.some((n) => /could not look up Name for 1 Epic asset: .*Epic\.Name/.test(n))).toBe(true);
  });

  it("a read-back that fails after the send throws BatchRecordError with the receipt: sent, outcome and reverse kept, after incomplete", async () => {
    const afterFails = (q: Q) => { if (q.select!.length === 1 && q.select![0] === "ChangeDate") throw new Error("socket hang up"); return lookup(q); };
    const t = server({ preview: PREVIEW, lookup: afterFails, send: () => envelope({ assetsCreated: { oidTokens: ["Task:50"], count: 1 }, assetsModified: { oidTokens: ["Story:1"], count: 1 }, assetsOperatedOn: { oidTokens: ["Epic:9"], count: 1 } }) });
    const e = (await runBatch(t, schema, REQUEST).catch((x: unknown) => x)) as BatchRecordError;
    expect(e).toBeInstanceOf(BatchRecordError);
    expect(e.message).toMatch(/sent and its outcome recorded.*receipt\.after is incomplete.*socket hang up/);
    expect(e.receipt.sent).toBe(true);
    expect(e.receipt.outcome?.created).toEqual(["Task:50"]);
    expect(e.receipt.created).toEqual([{ alias: "@t", type: "Task", oid: "Task:50", number: "TK-50", name: "new task" }]);
    expect(e.receipt.reverse.commands.length).toBeGreaterThan(0);
    expect(e.receipt.after).toEqual({});
  });

  it("reversible puts a Reactivate before deleting an asset that is closed now: Agility refuses to delete a closed asset", async () => {
    const receipt = { after: { "Task:50": "2026-11-04T17:00:00.5", "Story:1": "2026-11-04T17:00:00.1" }, reverse: { notes: [], commands: [{ from: "Story:1", update: { Estimate: "3" } }, { from: "Task:50", execute: "Delete" }] as Command[] } };
    const t = server({ preview: [], lookup: (q) => q.with!.$oids!.map((oid) => (q.select![0] === "AssetState" ? { _oid: oid, AssetState: "Closed" } : { _oid: oid, ChangeDate: receipt.after[oid as "Task:50"] })), send: () => envelope() });
    const r = await reversible(t, receipt);
    expect(r.reactivated).toEqual(["Task:50"]);
    expect(r.commands).toEqual([{ from: "Story:1", update: { Estimate: "3" } }, { from: "Task:50", execute: "Reactivate" }, { from: "Task:50", execute: "Delete" }]);
    // An open one is deleted as is.
    const open = server({ preview: [], lookup: (q) => q.with!.$oids!.map((oid) => (q.select![0] === "AssetState" ? { _oid: oid, AssetState: "Active" } : { _oid: oid, ChangeDate: receipt.after[oid as "Task:50"] })), send: () => envelope() });
    expect((await reversible(open, receipt)).reactivated).toEqual([]);
  });

  it("reversible drops assets changed since the batch (their ChangeDate is not the one recorded after it) unless forced", async () => {
    const receipt = { after: { "Story:1": "2026-11-04T17:00:00.1", "Epic:9": "2026-11-04T17:00:00.3" }, reverse: { notes: [], commands: [{ from: "Story:1", update: { Estimate: "3" } }, { from: "Epic:9", execute: "Reactivate" }] as Command[] } };
    const now: Record<string, string> = { "Story:1": "2026-11-04T18:00:00.9", "Epic:9": "2026-11-04T17:00:00.3" };
    const t = server({ preview: [], lookup: (q) => q.with!.$oids!.map((oid) => ({ _oid: oid, ChangeDate: now[oid] })), send: () => envelope() });
    const r = await reversible(t, receipt);
    expect(r.drifted).toEqual([{ oid: "Story:1", was: "2026-11-04T17:00:00.1", now: "2026-11-04T18:00:00.9" }]);
    expect(r.commands).toEqual([{ from: "Epic:9", execute: "Reactivate" }]);
    expect((await reversible(t, receipt, { force: true })).commands).toHaveLength(2);
  });
});

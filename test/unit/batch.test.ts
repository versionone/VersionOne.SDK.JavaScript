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
      { "@b": { oid: "Epic:9", execute: { op: "Split", args: {} } } },
      { "@c": { oid: "Story:3", update: { Name: { add: ["x"], remove: [] } } } }
    ] as unknown as Command[]);
    const r = reverseOf(d, { "Story:2": { Estimate: null, Owners: ["Member:20"] }, "Epic:9": { AssetState: "Active" } }, { created: [], modified: ["Story:2"], operated: ["Epic:9"] });
    expect(r.commands).toEqual([{ from: "Story:2", update: { Estimate: null } }]);
    expect(r.notes.slice(1)).toEqual(["Epic:9: Split has no known inverse (was Active)"]);
  });

  it("an asset whose command failed is failed, not also skipped as changed since the snapshot (a CLI consumer finding)", async () => {
    const preview = [{ "@x": { oid: "Conversation:12", execute: { op: "Delete", args: {} } } }, { "@y": { oid: "Epic:9", execute: { op: "Inactivate", args: {} } } }] as unknown as Command[];
    const t = server({
      preview,
      lookup: (q) => q.with!.$oids!.map((oid) => (q.select!.includes("Name") ? { _oid: oid } : q.select!.includes("Children") ? { _oid: oid, Children: [] } : { _oid: oid, AssetState: "Active", ChangeDate: "2026-11-11T09:00:00.1" })),
      send: () => envelope({ assetsOperatedOn: { oidTokens: [], count: 0 }, commandFailures: { commands: [{ error: { sourceCommandIndex: 0, message: "Unknown Operation 'Conversation.Delete'" } }], count: 1 } })
    });
    const r = await runBatch(t, schema, [{ from: "Conversation:12", execute: "Delete" }, { from: "Epic:9", execute: "Inactivate" }]);
    expect(r.failed).toEqual(["Conversation:12"]);
    expect(r.skipped).toEqual(["Epic:9"]); // matched nothing: changed since the snapshot
  });

  it("reverseOf leaves out an operation the type does not have, by meta's Operations, and says so: a created Conversation is not deleted (a CLI consumer finding)", () => {
    const d = describe([{ "@c": { AssetType: "Conversation" } }, { "@e": { AssetType: "Expression", BelongsTo: "@c", Content: "x" } }], []);
    const can = (type: string, op: string) => schema.canOperate(type, op);
    expect(can("Conversation", "Delete")).toBe(false);
    expect(can("Expression", "Delete")).toBe(true);
    expect(can("NoSuchType", "Delete")).toBeUndefined(); // not loaded: don't know, keep the command
    const r = reverseOf(d, {}, { created: ["Conversation:12:300", "Expression:13:301"], modified: [], operated: [] }, { canOperate: can });
    expect(r.commands).toEqual([{ from: "Expression:13", execute: "Delete" }]);
    expect(r.notes.join("\n")).toMatch(/Conversation:12: Conversation has no Delete operation, so it is not deleted \(the server removes a Conversation once its last Expression is deleted\)/);
    // Without the schema's answer, the old behaviour: delete everything created.
    expect(reverseOf(d, {}, { created: ["Conversation:12", "Expression:13"], modified: [], operated: [] }).commands).toHaveLength(2);
  });

  it("reverseOf reopens what a close cascaded to, after the parent and top down; unread, it says what it could not reopen (a CLI consumer finding)", () => {
    const d = describe([], [{ "@x": { oid: "Story:1", execute: { op: "QuickClose", args: {} } } }] as unknown as Command[]);
    const done = { created: [], modified: [], operated: ["Story:1"] };
    const open = { "Story:1": ["Task:5", "Test:7", "Task:6"] };
    const r = reverseOf(d, { "Story:1": { AssetState: "Active" } }, done, { openDescendants: open, cascaded: { "Story:1": ["Task:5", "Test:7"] } });
    expect(r.commands).toEqual([{ from: "Story:1", execute: "Reactivate" }, { from: "Task:5", execute: "Reactivate" }, { from: "Test:7", execute: "Reactivate" }]);
    expect(r.notes.join("\n")).toMatch(/Story:1: QuickClose also closed Task:5, Test:7; reopened after it/);
    const unread = reverseOf(d, {}, done, { openDescendants: open });
    expect(unread.commands).toEqual([{ from: "Story:1", execute: "Reactivate" }]);
    expect(unread.notes.join("\n")).toMatch(/Story:1: QuickClose may also have closed 3 open descendants \(Task:5, Test:7, Task:6\); they could not be read back/);
  });

  it("runBatch on a close: records the open descendants top down before, the ones the close closed after, stamps them, and reverses parent first (a CLI consumer finding)", async () => {
    // Epic:9 → Story:1 → Task:5 (open) and Task:6 (closed already); Inactivate on the Epic closes Story:1 and Task:5.
    const children: Record<string, string[]> = { "Epic:9": ["Story:1"], "Story:1": ["Task:5", "Task:6"], "Task:5": [], "Task:6": [] };
    let state: Record<string, string> = { "Epic:9": "Active", "Story:1": "Active", "Task:5": "Active", "Task:6": "Closed" };
    const preview = [{ "@x": { oid: "Epic:9", execute: { op: "Inactivate", args: {} } } }] as unknown as Command[];
    const t = server({
      preview,
      lookup: (q) => q.with!.$oids!.map((oid) => {
        const sel = q.select!;
        if (sel.length === 1 && sel[0] === "Children") return { _oid: oid, Children: children[oid]!.map((c) => ({ _oid: c })) };
        if (sel.length === 1 && sel[0] === "AssetState") return { _oid: oid, AssetState: state[oid] };
        if (sel.length === 1 && sel[0] === "ChangeDate") return { _oid: oid, ChangeDate: `2026-11-11T10:00:00.${oid.length}` };
        if (sel.includes("Name")) return { _oid: oid, Name: oid, Number: oid };
        return { _oid: oid, AssetState: state[oid], ChangeDate: "2026-11-11T09:00:00.1" };
      }),
      send: () => { state = { ...state, "Epic:9": "Closed", "Story:1": "Closed", "Task:5": "Closed" }; return envelope({ assetsOperatedOn: { oidTokens: ["Epic:9"], count: 1 } }); }
    });
    const r = await runBatch(t, schema, [{ from: "Epic:9", execute: "Inactivate" }]);
    expect(r.openDescendants).toEqual({ "Epic:9": ["Story:1", "Task:5"] }); // Task:6 was closed already: not the cascade's
    expect(r.cascaded).toEqual({ "Epic:9": ["Story:1", "Task:5"] });
    expect(Object.keys(r.after).sort()).toEqual(["Epic:9", "Story:1", "Task:5"]); // so a later reverse can check them for drift
    expect(r.reverse.commands).toEqual([
      { from: "Epic:9", execute: "Reactivate" },
      { from: "Story:1", execute: "Reactivate" },
      { from: "Task:5", execute: "Reactivate" }
    ]);
    // A preview records the open descendants too, and sends nothing.
    state = { "Epic:9": "Active", "Story:1": "Active", "Task:5": "Active", "Task:6": "Closed" };
    expect((await runBatch(t, schema, [{ from: "Epic:9", execute: "Inactivate" }], { dryRun: true })).openDescendants).toEqual({ "Epic:9": ["Story:1", "Task:5"] });
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
    // the CLI consumer's `apply` hit this: preview echoes aliased writes unexpanded, so nothing reads as per-asset work.
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

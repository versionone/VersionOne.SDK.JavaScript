/**
 * The batch service: an api/asset batch sent with a record of what it did.
 * Ported from gh-v1's lib/batch.js — preview, describe, snapshot, send
 * (guarded by default), receipt, reverse — minus what is the CLI's: file
 * I/O, console output, permalinks and the confirm prompt (a callback here).
 *
 * A receipt is what the response alone is not: the request as sent, the
 * server's projection (one command per asset it would touch), a BEFORE
 * snapshot of exactly the attributes each projected update names (and the
 * AssetState of each execute, and every touched asset's ChangeDate) taken
 * just before sending, and from those, what a person needs afterwards: the
 * created assets with their aliases, numbers and names; the touched assets;
 * which were skipped by the guard; and a reverse batch that undoes what
 * succeeded, best effort, with a note for anything it cannot.
 *
 * The snapshot keeps the endpoint's spelling (strings, relations as OID
 * tokens) on purpose: it is what a reverse batch writes back.
 */
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless, typeOfOid } from "../types/oid";
import * as assetApi from "../wire/assetApi";
import type { Command, CommandValue } from "../wire/assetApi";
import { aliased, guard, stampsOf, touchedBy, unguardable, UnguardableError } from "./guard";
import type { Schema } from "./schema";

/** OIDs per lookup query: bounded, never one giant filter. */
export const CHUNK = 100;

// ---- describing a batch ----------------------------------------------------------

export interface Described {
  creates: { index: number; alias: string | null; type: string; name: string | null }[];
  queries: { index: number; from: string }[];
  updates: { oid: Oid; attributes: Record<string, CommandValue> }[];
  executes: { oid: Oid; op: string; args: Record<string, CommandValue> }[];
}

const bodyOf = (c: Command): Record<string, unknown> => aliased(c)?.body ?? (c as Record<string, unknown>);

/** What a batch does: creates and queries read off the request; updates and executes, per asset, off the projection. */
export function describe(commands: Command[], projected: Command[]): Described {
  const out: Described = { creates: [], queries: [], updates: [], executes: [] };
  commands.forEach((c, index) => {
    const a = aliased(c), body = bodyOf(c);
    if (typeof body.AssetType === "string") out.creates.push({ index, alias: a?.alias ?? null, type: body.AssetType, name: typeof body.Name === "string" ? body.Name : null });
    else if (typeof body.from === "string" && !("update" in body) && !("execute" in body)) out.queries.push({ index, from: body.from });
  });
  for (const p of projected) {
    const body = bodyOf(p);
    if (typeof body.oid !== "string") continue;
    const oid = momentless(body.oid);
    if (body.update && typeof body.update === "object") out.updates.push({ oid, attributes: body.update as Record<string, CommandValue> });
    else if (body.execute !== undefined) {
      const e = body.execute as string | { op: string; args?: Record<string, CommandValue> };
      out.executes.push({ oid, op: typeof e === "string" ? e : e.op, args: typeof e === "string" ? {} : e.args ?? {} });
    }
  }
  return out;
}

// ---- reading assets --------------------------------------------------------------

const byType = (oids: Iterable<Oid>): Map<AssetTypeToken, Oid[]> => {
  const out = new Map<AssetTypeToken, Oid[]>();
  for (const oid of new Set([...oids].map(momentless))) out.set(typeOfOid(oid), [...(out.get(typeOfOid(oid)) ?? []), oid]);
  return out;
};
const chunks = <T>(list: T[]): T[][] => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
/** A relation as a reverse batch writes it: OID tokens. */
const plain = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "_oid" in v ? momentless(String((v as { _oid: unknown })._oid)) : v ?? null;

export interface Named { number: string | null; name: string | null }

/**
 * Numbers and names, one bounded query per type and chunk, asking each type
 * only for what the schema says it has (a Conversation has neither, and
 * asking fails the query). Cosmetic: a lookup the server refuses leaves
 * those assets unnamed rather than failing a batch that may already be sent.
 */
export async function namesOf(transport: Transport, schema: Schema, oids: Iterable<Oid>): Promise<Map<Oid, Named>> {
  const out = new Map<Oid, Named>();
  for (const [type, list] of byType(oids)) {
    await schema.load(type);
    const select = ["Name", "Number"].filter((a) => schema.attribute(type, a));
    if (!select.length) continue;
    for (const part of chunks(list)) {
      try {
        const rows = await assetApi.query<Asset & { Name?: string; Number?: string }>(transport, { from: type, select, filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
        for (const r of rows) out.set(momentless(r._oid), { number: r.Number ?? null, name: r.Name ?? null });
      } catch { /* cosmetic: leave these unnamed */ }
    }
  }
  return out;
}

/** The values about to be overwritten: each update's named attributes, each execute's AssetState, and every touched asset's ChangeDate. */
export async function snapshot(transport: Transport, described: Described): Promise<Record<Oid, Record<string, unknown>>> {
  const wanted = new Map<Oid, Set<string>>();
  const want = (oid: Oid, attrs: string[]) => { const s = wanted.get(oid) ?? new Set<string>(); attrs.forEach((a) => s.add(a)); wanted.set(oid, s); };
  for (const u of described.updates) want(u.oid, [...Object.keys(u.attributes), "ChangeDate"]);
  for (const e of described.executes) want(e.oid, ["AssetState", "ChangeDate"]);
  const before: Record<Oid, Record<string, unknown>> = {};
  for (const [type, oids] of byType(wanted.keys())) {
    const select = [...new Set(oids.flatMap((o) => [...wanted.get(o)!]))];
    for (const part of chunks(oids)) {
      const rows = await assetApi.query<Asset>(transport, { from: type, select, filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
      for (const r of rows) {
        const oid = momentless(r._oid), row = r as unknown as Record<string, unknown>;
        before[oid] = Object.fromEntries([...wanted.get(oid)!].map((a) => [a, plain(row[a])]));
      }
    }
  }
  return before;
}

// ---- undoing it --------------------------------------------------------------------

/** The known inverse operations. Anything else is reported, not guessed. */
export const INVERSE: Readonly<Record<string, string>> = { Inactivate: "Reactivate", Reactivate: "Inactivate", Delete: "Undelete", Undelete: "Delete" };

export interface Reverse { commands: Command[]; notes: string[] }

/**
 * A batch that undoes what the response says succeeded — best effort. Only
 * what the response confirms is reversed (membership in it, not command
 * index, decides): updated attributes put back from the snapshot, the
 * inverse operation where one is known, created assets deleted (newest
 * first).
 */
export function reverseOf(described: Described, before: Record<Oid, Record<string, unknown>>, done: { created: Oid[]; modified: Oid[]; operated: Oid[] }): Reverse {
  const commands: Command[] = [], notes: string[] = [];
  const modified = new Set(done.modified.map(momentless)), operated = new Set(done.operated.map(momentless));
  for (const u of described.updates) {
    if (!modified.has(u.oid)) continue;
    const was = before[u.oid];
    if (!was) { notes.push(`${u.oid}: no snapshot, cannot restore`); continue; }
    const update: Record<string, CommandValue> = {};
    for (const [attr, change] of Object.entries(u.attributes)) {
      const prior = was[attr];
      const c = change && typeof change === "object" && !Array.isArray(change) ? change as { add?: CommandValue; remove?: CommandValue } : {};
      const add = ([] as CommandValue[]).concat(c.add ?? []), remove = ([] as CommandValue[]).concat(c.remove ?? []);
      if (Array.isArray(prior)) {
        const added = add.filter((v) => !prior.includes(v)), removed = remove.filter((v) => prior.includes(v));
        if (added.length || removed.length) update[attr] = { add: removed, remove: added };
      } else if (prior === undefined) notes.push(`${u.oid}.${attr}: not in snapshot, cannot restore`);
      else update[attr] = prior as CommandValue; // a scalar or single relation: put the old value back (null clears)
    }
    if (Object.keys(update).length) commands.push({ from: u.oid, update });
  }
  for (const e of described.executes) {
    if (!operated.has(e.oid)) continue;
    const inverse = INVERSE[e.op];
    if (inverse) commands.push({ from: e.oid, execute: inverse });
    else notes.push(`${e.oid}: ${e.op} has no known inverse (was ${String(before[e.oid]?.AssetState ?? "?")})`);
  }
  for (const oid of [...done.created].reverse()) commands.push({ from: momentless(oid), execute: "Delete" });
  if (commands.length) notes.unshift("restores the state recorded at snapshotAt; anything that changed between then and sentAt is not reflected, and a scalar restored to null is cleared, not unset");
  return { commands, notes };
}

// ---- the receipt -----------------------------------------------------------------------

export interface Receipt {
  receipt: 1;
  request: Command[];
  previewedAt: string;
  preview: Command[];
  described: Described;
  snapshotAt?: string;
  /** Before values per touched asset, ChangeDate included: what the guard compared and the reverse restores. */
  before: Record<Oid, Record<string, unknown>>;
  /** Was the batch sent? False for a preview, a declined confirm, or nothing to do. */
  sent: boolean;
  guarded: boolean;
  /** The batch as sent (the guarded projection, or the request as written). */
  sentCommands?: Command[];
  sentAt?: string;
  /** What the server says the batch did. */
  outcome?: assetApi.Outcome;
  created: ({ alias: string | null; type: string; oid: Oid } & Named)[];
  touched: ({ oid: Oid } & Named)[];
  /** ChangeDate of everything the batch touched, just after it: the stamp a later reverse checks for drift. */
  after: Record<Oid, string>;
  /** Touched assets the guard left alone: changed or gone since the snapshot. */
  skipped: Oid[];
  reverse: Reverse;
}

/** The send itself failed (a timeout, a 5xx): whether the server applied it is unknown. The receipt holds everything up to the attempt. */
export class BatchSendError extends Error {
  readonly receipt: Receipt;
  constructor(cause: unknown, receipt: Receipt) {
    super(`the batch send failed; whether the server applied it is unknown: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "BatchSendError";
    this.receipt = receipt;
  }
}

export interface BatchOptions {
  /** Send as a compare-and-set (default). An unguardable batch then throws UnguardableError before any request; pass false to send it as written. */
  guard?: boolean;
  /** Stop after the snapshot and send nothing: the receipt says what would happen. */
  dryRun?: boolean;
  /** Asked after the snapshot, before the send; false sends nothing. */
  confirm?: (receipt: Receipt) => boolean | Promise<boolean>;
}

const now = (): string => new Date().toISOString();

/** Preview, describe, name, snapshot, (confirm,) send, receipt. */
export async function runBatch(transport: Transport, schema: Schema, commands: Command[], options: BatchOptions = {}): Promise<Receipt> {
  const useGuard = options.guard ?? true;
  if (!commands.length) throw new Error("the batch is empty");
  const refused = unguardable(commands);
  const fatal = refused.filter((r) => r.reason.includes("rejected by the server"));
  if (fatal.length || (useGuard && refused.length)) throw new UnguardableError(useGuard ? refused : fatal);

  const previewedAt = now();
  const projected = await assetApi.preview(transport, commands);
  const described = describe(commands, projected);
  const touched = touchedBy(projected);
  const names = await namesOf(transport, schema, touched);
  const receipt: Receipt = { receipt: 1, request: commands, previewedAt, preview: projected, described, before: {}, sent: false, guarded: false, created: [], touched: [], after: {}, skipped: [], reverse: { commands: [], notes: [] } };
  const nothing = !described.creates.length && !described.updates.length && !described.executes.length && !described.queries.length;
  if (nothing) return receipt;
  receipt.snapshotAt = now();
  receipt.before = await snapshot(transport, described);
  if (options.dryRun) return receipt;
  if (options.confirm && !(await options.confirm(receipt))) return receipt;

  let toSend = commands, unstamped: Oid[] = [];
  if (useGuard) {
    const stamps = Object.fromEntries(Object.entries(receipt.before).flatMap(([oid, v]) => (typeof v.ChangeDate === "string" ? [[oid, v.ChangeDate]] : [])));
    ({ commands: toSend, unstamped } = guard(projected, stamps));
  }
  receipt.guarded = useGuard;
  receipt.sentCommands = toSend;
  receipt.sentAt = now();
  let done: assetApi.Outcome;
  try {
    done = assetApi.outcomeOf(await assetApi.send(transport, toSend, { idempotent: useGuard && !toSend.some((c) => "AssetType" in bodyOf(c)) }));
  } catch (error) {
    throw new BatchSendError(error, receipt);
  }
  receipt.sent = true;
  receipt.outcome = done;

  // Everything below decorates a response already recorded; a failed lookup cannot cost the record.
  const createdNames = await namesOf(transport, schema, done.created);
  receipt.created = done.created.map((oid, i) => ({ alias: described.creates[i]?.alias ?? null, type: described.creates[i]?.type ?? typeOfOid(oid), oid, ...(createdNames.get(oid) ?? { number: null, name: null }) }));
  const hit = [...new Set([...done.modified, ...done.operated])];
  receipt.touched = hit.map((oid) => ({ oid, ...(names.get(oid) ?? { number: null, name: null }) }));
  const all = [...done.created, ...hit];
  receipt.after = all.length ? await stampsOf(transport, all) : {};
  receipt.skipped = useGuard ? [...new Set([...unstamped, ...touched.filter((oid) => !hit.includes(oid))])] : [];
  receipt.reverse = reverseOf(described, receipt.before, done);
  return receipt;
}

/**
 * A receipt's reverse batch, minus the assets someone changed since the
 * batch (their ChangeDate is no longer the one recorded just after it),
 * unless `force`. Send what it returns with runBatch like any batch.
 */
export async function reversible(transport: Transport, receipt: Pick<Receipt, "reverse" | "after">, options: { force?: boolean } = {}): Promise<{ commands: Command[]; drifted: { oid: Oid; was: string; now: string | null }[] }> {
  const targets = receipt.reverse.commands.map((c) => momentless(String(bodyOf(c).from)));
  const now = await stampsOf(transport, targets.filter((oid) => receipt.after[oid] !== undefined));
  const drifted = targets.flatMap((oid) => (receipt.after[oid] !== undefined && now[oid] !== receipt.after[oid] ? [{ oid, was: receipt.after[oid]!, now: now[oid] ?? null }] : []));
  const skip = new Set(options.force ? [] : drifted.map((d) => d.oid));
  return { commands: receipt.reverse.commands.filter((c) => !skip.has(momentless(String(bodyOf(c).from)))), drifted };
}

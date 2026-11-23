/**
 * The batch service: an api/asset batch sent with a record of what it did.
 * Ported from the CLI consumer's batch module — preview, describe, snapshot, send
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
 * Closing a workitem cascades: the server's Inactivate and QuickClose also close
 * its open descendants, and Reactivate reopens only the asset it names. So
 * before a batch that closes, the receipt records each closing target's
 * open descendants; after it, the ones the close actually closed; and the
 * reverse reopens the parent, then those, top down.
 *
 * The snapshot keeps the endpoint's spelling (strings, relations as OID
 * tokens) on purpose: it is what a reverse batch writes back.
 */
import { UsageError, WrappedError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless, typeOfOid } from "../types/oid";
import * as assetApi from "../wire/assetApi";
import type { Command, CommandValue } from "../wire/assetApi";
import { aliased, guard, GuardedPassError, passesOf, sendPasses, stampsOf, touchedBy, unguardable, UnguardableError } from "./guard";
import type { Schema } from "./schema";

/** OIDs per lookup query: bounded, never one giant filter. */
export const CHUNK = 100;

// ---- describing a batch ----------------------------------------------------------

export interface Described {
  creates: { index: number; alias: string | null; type: string; name: string | null }[];
  queries: { index: number; from: string }[];
  updates: { oid: Oid; attributes: Record<string, CommandValue> }[];
  executes: { oid: Oid; op: string; args: Record<string, CommandValue> }[];
  /**
   * Aliased updates and executes: preview does not expand them, so they
   * have no per-asset entry above, no snapshot and no reverse. They are
   * work all the same, sent as written (only with guard: false).
   */
  deferred: { index: number; alias: string; from: string; kind: "update" | "execute" }[];
}

const bodyOf = (c: Command): Record<string, unknown> => aliased(c)?.body ?? (c as Record<string, unknown>);

/** What a batch does: creates and queries read off the request; updates and executes, per asset, off the projection. */
export function describe(commands: Command[], projected: Command[]): Described {
  const out: Described = { creates: [], queries: [], updates: [], executes: [], deferred: [] };
  commands.forEach((c, index) => {
    const a = aliased(c), body = bodyOf(c);
    if (a && typeof body.from === "string" && ("update" in body || "execute" in body)) out.deferred.push({ index, alias: a.alias, from: body.from, kind: "update" in body ? "update" : "execute" });
    else if (typeof body.AssetType === "string") out.creates.push({ index, alias: a?.alias ?? null, type: body.AssetType, name: typeof body.Name === "string" ? body.Name : null });
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

/** Told about a name lookup that failed: the type, the assets left unnamed, and why. */
export type NameLookupFailure = (failure: { type: AssetTypeToken; oids: Oid[]; error: unknown }) => void;

/**
 * Numbers and names, one bounded query per type and chunk, asking each type
 * only for what the schema says it has (a Conversation has neither, and
 * asking fails the query). Cosmetic: a lookup that fails leaves those assets
 * unnamed rather than failing a batch that may already be sent, and is
 * reported to `onFailure` so a caller can say so.
 */
export async function namesOf(transport: Transport, schema: Schema, oids: Iterable<Oid>, onFailure?: NameLookupFailure): Promise<Map<Oid, Named>> {
  const out = new Map<Oid, Named>();
  for (const [type, list] of byType(oids)) {
    let select: string[];
    try {
      await schema.load(type);
      select = ["Name", "Number"].filter((a) => schema.attribute(type, a));
    } catch (error) {
      onFailure?.({ type, oids: list, error });
      continue;
    }
    if (!select.length) continue;
    for (const part of chunks(list)) {
      try {
        const rows = await assetApi.query<Asset & { Name?: string; Number?: string }>(transport, { from: type, select, filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
        for (const r of rows) out.set(momentless(r._oid), { number: r.Number ?? null, name: r.Name ?? null });
      } catch (error) {
        onFailure?.({ type, oids: part, error });
      }
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
export const INVERSE: Readonly<Record<string, string>> = { Inactivate: "Reactivate", QuickClose: "Reactivate", Reactivate: "Inactivate", Delete: "Undelete", Undelete: "Delete" };

/** Operations that close an asset's open descendants along with it (the server's close cascade). */
export const CASCADING: ReadonlySet<string> = new Set(["Inactivate", "QuickClose"]);

/** How deep a cascade is followed: Epic → sub-Epic → Story → Task is four. */
const CASCADE_DEPTH = 8;

/**
 * Each root's open descendants, top down (children, then grandchildren, …),
 * through the Children relation of the types that have one. One bounded
 * query per type and chunk for each level's children, and one for their
 * states. A root whose type has no Children has none.
 */
export async function openDescendantsOf(transport: Transport, schema: Schema, roots: Oid[]): Promise<Record<Oid, Oid[]>> {
  const out: Record<Oid, Oid[]> = {};
  const rootOf = new Map<Oid, Oid>(roots.map((r) => [momentless(r), momentless(r)]));
  const seen = new Set(rootOf.keys());
  let frontier = [...rootOf.keys()];
  for (let depth = 0; depth < CASCADE_DEPTH && frontier.length; depth += 1) {
    const children = new Map<Oid, Oid>(); // child → its root
    for (const [type, list] of byType(frontier)) {
      await schema.load(type);
      if (!schema.attribute(type, "Children")) continue;
      for (const part of chunks(list)) {
        const rows = await assetApi.query<Asset & { Children?: unknown }>(transport, { from: type, select: ["Children"], filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
        for (const r of rows) {
          const parent = momentless(r._oid);
          for (const c of ([] as unknown[]).concat(plain(r.Children) ?? [])) {
            const child = momentless(String(c));
            if (seen.has(child)) continue;
            seen.add(child);
            children.set(child, rootOf.get(parent)!);
          }
        }
      }
    }
    const states = children.size ? await statesOf(transport, [...children.keys()]) : {};
    frontier = [];
    for (const [child, root] of children) {
      if (states[child] === undefined || isClosed(states[child])) continue; // gone, or closed already: not the cascade's
      rootOf.set(child, root);
      (out[root] ??= []).push(child);
      frontier.push(child);
    }
  }
  return out;
}

export interface Reverse { commands: Command[]; notes: string[] }

/** What reverseOf can know beyond the response, each optional. */
export interface ReverseContext {
  /** Per closing target, its open descendants before the batch (Receipt.openDescendants). */
  openDescendants?: Record<Oid, Oid[]>;
  /** Per closing target, the descendants the close closed (Receipt.cascaded); undefined when they could not be read back. */
  cascaded?: Record<Oid, Oid[]>;
  /** Can this type do this operation? Undefined is "don't know", and the command is kept. */
  canOperate?: (type: AssetTypeToken, op: string) => boolean | undefined;
}

/**
 * A batch that undoes what the response says succeeded — best effort. Only
 * what the response confirms is reversed (membership in it, not command
 * index, decides): updated attributes put back from the snapshot, the
 * inverse operation where one is known (and, for a close, the descendants
 * it closed reopened after it, top down), created assets deleted (newest
 * first). An operation a type does not have, by `context.canOperate`, is
 * a note rather than a command the server would refuse.
 */
export function reverseOf(described: Described, before: Record<Oid, Record<string, unknown>>, done: { created: Oid[]; modified: Oid[]; operated: Oid[] }, context: ReverseContext = {}): Reverse {
  const commands: Command[] = [], notes: string[] = [];
  const cannot = (oid: Oid, op: string) => context.canOperate?.(typeOfOid(oid), op) === false;
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
    if (!inverse) { notes.push(`${e.oid}: ${e.op} has no known inverse (was ${String(before[e.oid]?.AssetState ?? "?")})`); continue; }
    if (cannot(e.oid, inverse)) { notes.push(`${e.oid}: ${typeOfOid(e.oid)} has no ${inverse} operation, so its ${e.op} is not reversed`); continue; }
    commands.push({ from: e.oid, execute: inverse });
    if (!CASCADING.has(e.op)) continue;
    const open = context.openDescendants?.[e.oid] ?? [];
    const closed = context.cascaded ? context.cascaded[e.oid] ?? [] : undefined;
    if (closed === undefined) {
      if (open.length) notes.push(`${e.oid}: ${e.op} may also have closed ${open.length} open descendant${open.length === 1 ? "" : "s"} (${open.join(", ")}); they could not be read back, so they are not reopened`);
      continue;
    }
    for (const d of closed) {
      if (cannot(d, "Reactivate")) notes.push(`${d}: closed with ${e.oid}, but ${typeOfOid(d)} has no Reactivate operation`);
      else commands.push({ from: d, execute: "Reactivate" });
    }
    if (closed.length) notes.push(`${e.oid}: ${e.op} also closed ${closed.join(", ")}; reopened after it`);
  }
  for (const oid of [...done.created].reverse().map(momentless)) {
    if (cannot(oid, "Delete")) notes.push(`${oid}: ${typeOfOid(oid)} has no Delete operation, so it is not deleted${typeOfOid(oid) === "Conversation" ? " (the server removes a Conversation once its last Expression is deleted)" : ""}`);
    else commands.push({ from: oid, execute: "Delete" });
  }
  for (const d of described.deferred ?? []) notes.push(`command ${d.index} (${d.alias}): an aliased ${d.kind} of ${d.from}, sent as written with no snapshot; not reversed`);
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
  /** Numbers and names of the assets the preview touches, looked up before confirm. */
  names: Record<Oid, Named>;
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
  /** Touched assets the guard left alone: changed or gone since the snapshot. Not the ones whose command failed: those are in `failed`. */
  skipped: Oid[];
  /** Touched assets whose command the server reports as failed (outcome.failures says why). */
  failed: Oid[];
  /** Per asset the batch closes (Inactivate, QuickClose): its open descendants at the snapshot, top down. */
  openDescendants: Record<Oid, Oid[]>;
  /** Per asset the batch closed: the descendants the close closed with it, read back after the send. */
  cascaded: Record<Oid, Oid[]>;
  reverse: Reverse;
  /** What the record could not do and why: a name lookup that failed, deferred commands sent unsnapshotted. */
  notes: string[];
}

/**
 * The batch was sent and the server's outcome is on the receipt
 * (`receipt.sent`, `receipt.outcome`, `receipt.reverse`), but reading the
 * assets back afterwards failed, so `receipt.after` is incomplete: keep the
 * receipt, and know that a reverse built from it cannot check every asset
 * for changes made since.
 */
export class BatchRecordError extends WrappedError {
  readonly receipt: Receipt;
  constructor(cause: unknown, receipt: Receipt) {
    super(`the batch was sent and its outcome recorded, but reading the assets back afterwards failed, so receipt.after is incomplete: ${cause instanceof Error ? cause.message : String(cause)}`, "BATCH_RECORD", cause);
    this.name = "BatchRecordError";
    this.receipt = receipt;
  }
}

/** The send itself failed (a timeout, a 5xx): whether the server applied it is unknown. The receipt holds everything up to the attempt. */
export class BatchSendError extends WrappedError {
  readonly receipt: Receipt;
  constructor(cause: unknown, receipt: Receipt) {
    super(`the batch send failed; whether the server applied it is unknown: ${cause instanceof Error ? cause.message : String(cause)}`, "BATCH_SEND", cause);
    this.name = "BatchSendError";
    this.receipt = receipt;
  }
}

export interface BatchOptions {
  /** Send as a compare-and-set (default). An unguardable batch then throws UnguardableError before any request; pass false to send it as written. */
  guard?: boolean;
  /** Stop after the snapshot and send nothing: the receipt says what would happen. */
  dryRun?: boolean;
  /** Asked after the snapshot, before the send, with the touched assets' names on the receipt; false sends nothing. */
  confirm?: (receipt: Receipt) => boolean | Promise<boolean>;
}

const now = (): string => new Date().toISOString();

/** Preview, describe, name, snapshot, (confirm,) send, receipt. */
export async function runBatch(transport: Transport, schema: Schema, commands: Command[], options: BatchOptions = {}): Promise<Receipt> {
  const useGuard = options.guard ?? true;
  if (!commands.length) throw new UsageError("the batch is empty");
  const refused = unguardable(commands);
  const fatal = refused.filter((r) => r.reason.includes("rejected by the server"));
  if (fatal.length || (useGuard && refused.length)) throw new UnguardableError(useGuard ? refused : fatal);

  const notes: string[] = [];
  const noteFailure: NameLookupFailure = ({ type, oids, error }) =>
    notes.push(`could not look up Name for ${oids.length} ${type} asset${oids.length === 1 ? "" : "s"}: ${error instanceof Error ? error.message : String(error)}`);
  const previewedAt = now();
  const projected = await assetApi.preview(transport, commands);
  const described = describe(commands, projected);
  const touched = touchedBy(projected);
  const names = await namesOf(transport, schema, touched, noteFailure);
  const receipt: Receipt = { receipt: 1, request: commands, previewedAt, preview: projected, described, names: Object.fromEntries(names), before: {}, sent: false, guarded: false, created: [], touched: [], after: {}, skipped: [], failed: [], openDescendants: {}, cascaded: {}, reverse: { commands: [], notes: [] }, notes };
  const nothing = !described.creates.length && !described.updates.length && !described.executes.length && !described.queries.length && !described.deferred.length;
  if (nothing) return receipt;
  for (const d of described.deferred) notes.push(`command ${d.index} (${d.alias}): an aliased ${d.kind}, which preview does not expand; sent as written, not snapshotted, not reversible`);
  receipt.snapshotAt = now();
  receipt.before = await snapshot(transport, described);
  const closing = described.executes.filter((e) => CASCADING.has(e.op)).map((e) => e.oid);
  if (closing.length) receipt.openDescendants = await openDescendantsOf(transport, schema, closing);
  if (options.dryRun) return receipt;
  if (options.confirm && !(await options.confirm(receipt))) return receipt;

  let unstamped: Oid[] = [];
  receipt.guarded = useGuard;
  receipt.sentAt = now();
  let done: assetApi.Outcome;
  try {
    if (useGuard) {
      // Guarded pass by pass: a second command on the same asset (Reactivate
      // then Delete in a reverse) goes only if the first applied (guard.ts).
      const stamps = Object.fromEntries(Object.entries(receipt.before).flatMap(([oid, v]) => (typeof v.ChangeDate === "string" ? [[oid, v.ChangeDate]] : [])));
      receipt.sentCommands = guard(passesOf(projected)[0]!, stamps).commands; // what the first pass sends; replaced below by everything sent
      const result = await sendPasses(transport, projected, stamps);
      ({ outcome: done, unstamped } = result);
      receipt.sentCommands = result.sent;
    } else {
      receipt.sentCommands = commands;
      done = assetApi.outcomeOf(await assetApi.send(transport, commands));
    }
  } catch (error) {
    if (error instanceof GuardedPassError) {
      // Earlier passes applied: the receipt says so, and what failed after.
      receipt.sent = true;
      receipt.outcome = error.outcome;
      receipt.sentCommands = error.sent;
    }
    throw new BatchSendError(error, receipt);
  }
  receipt.sent = true;
  receipt.outcome = done;

  // The record, from the response alone: nothing below this block can lose it.
  const hit = [...new Set([...done.modified, ...done.operated])];
  const unnamed = { number: null, name: null };
  receipt.created = done.created.map((oid, i) => ({ alias: described.creates[i]?.alias ?? null, type: described.creates[i]?.type ?? typeOfOid(oid), oid, ...unnamed }));
  receipt.touched = hit.map((oid) => ({ oid, ...(names.get(oid) ?? unnamed) }));
  // A failed command names its asset in what was sent: the guard's
  // with.$oid, or the from of a per-asset command sent as written.
  const sentAs = receipt.sentCommands ?? [];
  const oidOfSent = (i: number | null): Oid | null => {
    const body = i === null ? undefined : (sentAs[i] ? bodyOf(sentAs[i]!) : undefined);
    const id = (body?.with as { $oid?: unknown } | undefined)?.$oid ?? body?.from;
    return typeof id === "string" && id.includes(":") ? momentless(id) : null;
  };
  receipt.failed = [...new Set(done.failures.map((f) => oidOfSent(f.index)).filter((oid): oid is Oid => !!oid && touched.includes(oid) && !hit.includes(oid)))];
  receipt.skipped = useGuard ? [...new Set([...unstamped, ...touched.filter((oid) => !hit.includes(oid) && !receipt.failed.includes(oid))])] : [];
  // What each type can do, from the definitions already loaded (or loadable):
  // an unknown answer keeps the command, as before.
  for (const type of new Set([...done.created, ...hit].map((oid) => typeOfOid(momentless(oid))))) await schema.load(type).catch(() => null);
  const canOperate = (type: AssetTypeToken, op: string) => schema.canOperate(type, op);
  const operatedNow = new Set(done.operated.map(momentless));
  const closed = Object.keys(receipt.openDescendants).filter((oid) => operatedNow.has(oid) && receipt.openDescendants[oid]!.length);
  // Until the cascade is read back, the reverse says what it could not reopen.
  receipt.reverse = reverseOf(described, receipt.before, done, { openDescendants: receipt.openDescendants, cascaded: closed.length ? undefined : {}, canOperate });

  // Decoration, read back from the server. Names are cosmetic (a failure is
  // a note); the after stamps are not, so a failure there throws with the
  // receipt, outcome and all.
  try {
    if (closed.length) {
      // The descendants the close closed: open at the snapshot, closed now.
      const states = await statesOf(transport, closed.flatMap((oid) => receipt.openDescendants[oid]!));
      receipt.cascaded = Object.fromEntries(closed.map((oid) => [oid, receipt.openDescendants[oid]!.filter((d) => isClosed(states[d]))]));
      receipt.reverse = reverseOf(described, receipt.before, done, { openDescendants: receipt.openDescendants, cascaded: receipt.cascaded, canOperate });
    }
    const more = await namesOf(transport, schema, [...done.created, ...hit.filter((oid) => !names.has(oid))], noteFailure);
    receipt.created = receipt.created.map((c) => ({ ...c, ...(more.get(c.oid) ?? unnamed) }));
    receipt.touched = receipt.touched.map((t) => (names.has(t.oid) ? t : { ...t, ...(more.get(t.oid) ?? unnamed) }));
    // The cascade's descendants too: a later reverse reopens them, and checks them for changes first.
    const all = [...new Set([...done.created, ...hit, ...Object.values(receipt.cascaded).flat()])];
    receipt.after = all.length ? await stampsOf(transport, all) : {};
  } catch (error) {
    throw new BatchRecordError(error, receipt);
  }
  return receipt;
}

/** Each asset's AssetState by name ("Active", "Closed"), one bounded query per type and chunk. An asset that no longer exists is absent. */
async function statesOf(transport: Transport, oids: Oid[]): Promise<Record<Oid, string>> {
  const out: Record<Oid, string> = {};
  for (const [type, list] of byType(oids)) {
    for (const part of chunks(list)) {
      const rows = await assetApi.query<Asset & { AssetState?: unknown }>(transport, { from: type, select: ["AssetState"], filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
      for (const r of rows) if (r.AssetState != null) out[momentless(r._oid)] = String(r.AssetState);
    }
  }
  return out;
}

/** AssetState as the endpoint spells a closed asset: by name, or by the server's code (128). */
const isClosed = (state: string | undefined): boolean => state === "Closed" || state === "128";

/**
 * A receipt's reverse batch, minus the assets someone changed since the
 * batch (their ChangeDate is no longer the one recorded just after it),
 * unless `force`. Send what it returns with runBatch like any batch.
 *
 * Agility refuses to Delete a closed asset (Violation'AssetCannotDeleteClosed),
 * so a Delete of an asset that is closed now gets a Reactivate just before
 * it: two commands on one asset, which runBatch sends in two guarded passes
 * (the Delete only if the Reactivate applied). `reactivated` lists them.
 */
export async function reversible(transport: Transport, receipt: Pick<Receipt, "reverse" | "after">, options: { force?: boolean } = {}): Promise<{ commands: Command[]; drifted: { oid: Oid; was: string; now: string | null }[]; reactivated: Oid[] }> {
  const targets = receipt.reverse.commands.map((c) => momentless(String(bodyOf(c).from)));
  const now = await stampsOf(transport, targets.filter((oid) => receipt.after[oid] !== undefined));
  const drifted = targets.flatMap((oid) => (receipt.after[oid] !== undefined && now[oid] !== receipt.after[oid] ? [{ oid, was: receipt.after[oid]!, now: now[oid] ?? null }] : []));
  const skip = new Set(options.force ? [] : drifted.map((d) => d.oid));
  const kept = receipt.reverse.commands.filter((c) => !skip.has(momentless(String(bodyOf(c).from))));
  const deletes = kept.flatMap((c) => (bodyOf(c).execute === "Delete" ? [momentless(String(bodyOf(c).from))] : []));
  const states = deletes.length ? await statesOf(transport, deletes) : {};
  const reactivated = deletes.filter((oid) => isClosed(states[oid]));
  const commands = kept.flatMap((c) => {
    const body = bodyOf(c), oid = momentless(String(body.from));
    return body.execute === "Delete" && reactivated.includes(oid) ? [{ from: oid, execute: "Reactivate" } as Command, c] : [c];
  });
  return { commands, drifted, reactivated };
}

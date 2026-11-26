/**
 * The guard: an api/asset batch sent as a compare-and-set, so a change only
 * lands on an asset nobody else has changed since it was read.
 *
 * How: preview the batch (the server's projection expands every query-
 * scoped update and execute into one command per asset), read each touched
 * asset's Moment (or take the one the caller read earlier, with the row a
 * person is looking at), and send each per-asset command scoped to that
 * version of the asset and to its still being the current one:
 *
 *   { from: "Story", where: { ID: "$oid", Moment: "$moment" },
 *     filter: ["RetireDateUTC=''"], with: { $oid, $moment }, update | execute }
 *
 * `Moment` in a query selects the asset AS IT WAS at that moment, so alone
 * it guards nothing: an update scoped by a stale Moment lands on the
 * current asset. Every version but the current one has a RetireDateUTC, so
 * the filter keeps the version only while it is current. Together they are
 * exact. Settled live on 2026-11-26 (test/integration/guard.test.ts, and
 * issue #51 of this repository):
 *   - the current moment matches and applies; a stale one matches nothing
 *     (query, preview and send alike), and resending a command that applied
 *     applies nothing;
 *   - a moment in the future, or between two of the asset's versions, and a
 *     deleted asset's last moment, match nothing; a closed asset is guardable;
 *   - Moment travels as a `with` variable like any value.
 * What the server does that shapes this module:
 *   - A command that MATCHED lists its asset in the response even when no
 *     value changed (and makes no new version). So an asset in neither
 *     modified nor operated, with no failure of its own, matched nothing:
 *     that is a conflict, and a no-op is never mistaken for one.
 *   - The response's OID tokens carry no moment, so a second command on
 *     the same asset needs the moment read again (the passes below).
 *   - `RetireDateUTC=''` WITHOUT a Moment, and a Moment that is not a
 *     number, are server errors (HTTP 500). Both terms are always sent
 *     together and the moment is checked to be digits first.
 *
 * The blind spot, which no version stamp can close: a change that makes no
 * new version of the asset is invisible. Adding a child Task to a Story
 * changes the Story's Children and leaves its Moment (and ChangeDate) as
 * they were. The guard protects an asset's own attributes, not what other
 * assets say about it.
 *
 * The Ideas product's types (Idea*) keep no history and have no Moment;
 * nothing of theirs can be guarded.
 *
 * A guarded batch without creates is safe to send twice — an applied
 * command has advanced the Moment, so a resend matches nothing — and is
 * sent marked idempotent (spec 000 section 6).
 */
import { ApiError, UsageError, WrappedError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless, typeOfOid } from "../types/oid";
import * as assetApi from "../wire/assetApi";
import type { Command, CommandValue, ExecuteBody } from "../wire/assetApi";

/** OIDs per Moment read: bounded, never one giant filter. */
export const CHUNK = 100;

/** Types with no Moment (the Ideas product keeps no history): nothing of theirs can be guarded. */
export const UNGUARDABLE_TYPES: readonly AssetTypeToken[] = ["Idea", "IdeaChangeSet", "IdeaStatus", "IdeaComment", "IdeaCategory", "IdeaForum", "IdeaUser"];

/**
 * Why a command cannot be sent guarded:
 *   aliasedWrite   an aliased update or execute: preview does not expand it
 *   bareAliasFrom  a bare update or execute from an alias: the server rejects it, guarded or not
 *   inlineCreate   an update that creates assets inline: the projection normalises the creates away
 *   noMoment       an asset of a type that keeps no history (Idea*)
 */
export type UnguardableCode = "aliasedWrite" | "bareAliasFrom" | "inlineCreate" | "noMoment";

/** Why a command cannot be sent guarded, by its index in the batch (-1 for an asset the preview found). Branch on `code`; `reason` is for a person. */
export interface Unguardable { index: number; code: UnguardableCode; reason: string }

/** A batch the guard will not send, rather than send unguarded without saying so. */
export class UnguardableError extends UsageError {
  readonly reasons: Unguardable[];
  constructor(reasons: Unguardable[]) {
    super(`cannot guard this batch: ${reasons.map((r) => `command ${r.index}: ${r.reason}`).join("; ")}`);
    this.name = "UnguardableError";
    this.reasons = reasons;
  }
}

// ---- reading commands ----------------------------------------------------------

/** The alias and body of an aliased command, or null for a bare one. */
export function aliased(command: Command): { alias: string; body: Record<string, unknown> } | null {
  const keys = Object.keys(command);
  return keys.length === 1 && keys[0]!.startsWith("@") ? { alias: keys[0]!, body: (command as Record<string, Record<string, unknown>>)[keys[0]!]! } : null;
}
const bodyOf = (c: Command): Record<string, unknown> => aliased(c)?.body ?? (c as Record<string, unknown>);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A relation value that is itself a create: the projection normalises these away, so they cannot be guarded. */
const isCreateValue = (v: unknown): boolean =>
  (isObject(v) && "AssetType" in v) || (Array.isArray(v) && v.some(isCreateValue)) || (isObject(v) && ([] as unknown[]).concat(v.add ?? []).some(isCreateValue));

/** The commands of a batch the guard cannot cover, and why. Empty means it can. */
export function unguardable(commands: Command[]): Unguardable[] {
  const out: Unguardable[] = [];
  commands.forEach((c, index) => {
    const a = aliased(c);
    const body = bodyOf(c);
    const writes = "update" in body || "execute" in body;
    if (a && writes) out.push({ index, code: "aliasedWrite", reason: `${a.alias} is an aliased ${"update" in body ? "update" : "execute"}: preview does not expand it, so it cannot be read or guarded per asset` });
    else if (!a && writes && typeof body.from === "string" && body.from.startsWith("@")) out.push({ index, code: "bareAliasFrom", reason: `a bare update or execute from an alias (${body.from}) is rejected by the server; alias the command itself` });
    if (isObject(body.update) && Object.values(body.update).some(isCreateValue)) out.push({ index, code: "inlineCreate", reason: "an update that creates assets inline: the projection normalises the creates away" });
  });
  return out;
}

/** A projected per-asset command: the asset and what is done to it. */
interface PerAsset { oid: Oid; update?: Record<string, CommandValue>; execute?: CommandValue }
function perAsset(projected: Command): PerAsset | null {
  const body = bodyOf(projected);
  return typeof body.oid === "string" && ("update" in body || "execute" in body)
    ? { oid: momentless(body.oid), update: body.update as Record<string, CommandValue> | undefined, execute: body.execute as CommandValue | undefined }
    : null;
}

/** The assets a projection updates or operates on, once each, in order. */
export const touchedBy = (projected: Command[]): Oid[] => [...new Set(projected.flatMap((p) => { const x = perAsset(p); return x ? [x.oid] : []; }))];

// ---- the stamp -----------------------------------------------------------------

/** A Moment as the server writes it: digits. Anything else must never reach a query (the server answers a non-number with a 500). */
const MOMENT = /^\d+$/;

/** Each asset's current Moment, one bounded query per type and chunk. An asset that no longer exists is absent. */
export async function stampsOf(transport: Transport, oids: readonly Oid[]): Promise<Record<Oid, string>> {
  const byType = new Map<string, Oid[]>();
  for (const oid of new Set(oids.map(momentless))) { const t = typeOfOid(oid); byType.set(t, [...(byType.get(t) ?? []), oid]); }
  const out: Record<Oid, string> = {};
  for (const [type, list] of byType) {
    if (UNGUARDABLE_TYPES.includes(type)) continue;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      const rows = await assetApi.query<Asset & { Moment?: string | number }>(transport, { from: type, select: ["Moment"], filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
      for (const r of rows) if (r.Moment != null) out[momentless(r._oid)] = String(r.Moment);
    }
  }
  return out;
}

/**
 * The batch to send: the projection, each per-asset update or execute
 * rewritten as a command on that asset at its moment, while that version
 * is current. Creates and queries pass through as the projection echoed
 * them. An asset with no stamp (gone since the preview) is left out and
 * reported as a conflict.
 */
export function guard(projected: Command[], stamps: Readonly<Record<Oid, string>>): { commands: Command[]; unstamped: Oid[] } {
  const commands: Command[] = [], unstamped: Oid[] = [];
  for (const p of projected) {
    const x = perAsset(p);
    if (!x) { commands.push(p); continue; }
    const stamp = stamps[x.oid];
    if (stamp === undefined) { unstamped.push(x.oid); continue; }
    if (!MOMENT.test(stamp)) throw new UsageError(`${x.oid}: ${JSON.stringify(stamp)} is not a Moment (digits); refusing to guard on it`, { oid: x.oid, stamp });
    // Both terms, always: the moment picks the version, the filter requires it to be the current one.
    const scope = { from: typeOfOid(x.oid), where: { ID: "$oid", Moment: "$moment" }, filter: ["RetireDateUTC=''"], with: { $oid: x.oid, $moment: stamp } };
    commands.push(x.update ? { ...scope, update: x.update } : { ...scope, execute: x.execute as ExecuteBody["execute"] });
  }
  return { commands, unstamped };
}

// ---- passes --------------------------------------------------------------------

/**
 * A projection split into passes: the k-th per-asset command for each asset
 * goes in pass k; creates and queries ride in pass 0. One pass is the usual
 * case. Two commands on one asset (a reverse batch's Reactivate then Delete,
 * say) cannot share a pass: both would be stamped with the Moment read
 * before the batch, the first would advance it, and the second would match
 * nothing — a conflict nobody caused.
 */
export function passesOf(projected: Command[]): Command[][] {
  const seen = new Map<Oid, number>();
  const passes: Command[][] = [[]];
  for (const p of projected) {
    const x = perAsset(p);
    const k = x ? seen.get(x.oid) ?? 0 : 0;
    if (x) seen.set(x.oid, k + 1);
    (passes[k] ??= []).push(p);
  }
  return passes;
}

/** A guarded send that failed after some passes applied: `outcome` and `sent` say what did. */
export class GuardedPassError extends WrappedError {
  constructor(cause: unknown, readonly outcome: assetApi.Outcome, readonly sent: Command[], readonly pass: number) {
    super(`guarded send failed in pass ${pass + 1}${pass ? " (earlier passes applied)" : ""}: ${cause instanceof Error ? cause.message : String(cause)}`, "GUARDED_PASS", cause);
    this.name = "GuardedPassError";
  }
}

/**
 * Send a projection guarded, pass by pass. Pass 0 is guarded on `stamps`
 * (read before the batch). A later pass sends an asset's next command only
 * if its previous one applied, guarded on the Moment read again just
 * after it (the response does not say the new moment) — so the chain stays
 * a compare-and-set, with one narrow window between our write and that
 * read. An asset whose earlier command matched nothing is left alone for
 * the rest of the batch. Failure indexes are
 * positions in `sent` (all passes, in order). A send that fails in the
 * first pass throws as it would alone; in a later pass it throws a
 * GuardedPassError carrying what the earlier passes did.
 */
export async function sendPasses<Row extends Asset = Asset>(transport: Transport, projected: Command[], stamps: Readonly<Record<Oid, string>>, options: Pick<assetApi.SendOptions, "lookup" | "throwOnFailure"> = {}): Promise<{ outcome: assetApi.Outcome<Row>; sent: Command[]; unstamped: Oid[] }> {
  const passes = passesOf(projected);
  const outcome = assetApi.emptyOutcome<Row>();
  const sent: Command[] = [], unstamped: Oid[] = [];
  const requestIds: (string | null)[] = [];
  let applied = new Set<Oid>();
  for (const [k, pass] of passes.entries()) {
    let current: { commands: Command[]; unstamped: Oid[] };
    if (k === 0) current = guard(pass, stamps);
    else {
      // Only assets whose previous command applied go on, stamped afresh.
      const eligible = pass.filter((p) => applied.has(perAsset(p)!.oid));
      current = guard(eligible, await stampsOf(transport, eligible.map((p) => perAsset(p)!.oid)));
    }
    const commands = current.commands;
    unstamped.push(...current.unstamped);
    if (!commands.length) break;
    const offset = sent.length;
    let done: assetApi.Outcome<Row>;
    try {
      const creates = commands.some((c) => "AssetType" in bodyOf(c));
      done = assetApi.outcomeOf(await assetApi.send<Row>(transport, commands, { ...options, idempotent: !creates }));
    } catch (error) {
      // Nothing applied yet: the error is the whole story, as for a single send.
      if (k === 0) throw error;
      throw new GuardedPassError(error, outcome, sent, k);
    }
    sent.push(...commands);
    assetApi.mergeOutcome(outcome, done, offset);
    requestIds.push(done.requestId);
    applied = new Set([...done.modified, ...done.operated].map(momentless));
  }
  // One send (the usual case) has one request id, and it is the outcome's; several sends have none that is "the" request.
  if (requestIds.length === 1) outcome.requestId = requestIds[0]!;
  return { outcome, sent, unstamped: [...new Set(unstamped)] };
}

// ---- the whole move --------------------------------------------------------------

/** The asset a sent command addresses: the guard's `with.$oid`, or the `from` of a command sent as written. */
export function oidOfSent(command: Command | undefined): Oid | null {
  const body = command ? bodyOf(command) : undefined;
  const id = (body?.with as { $oid?: unknown } | undefined)?.$oid ?? body?.from;
  return typeof id === "string" && id.includes(":") ? momentless(id) : null;
}

/**
 * What a guarded batch did: the Outcome of a plain send, plus what the
 * guard knows.
 */
export type GuardedResult<Row extends Asset = Asset> = assetApi.Outcome<Row> & {
  /** Every asset the projection would update or operate on. */
  touched: Oid[];
  /**
   * Touched assets whose command matched nothing: changed by someone since
   * the moment they were guarded on, or gone. Nothing was applied to them.
   * (An asset whose command matched and failed is in `failures`, not here;
   * one whose command matched and changed no value is a success.)
   */
  conflicts: Oid[];
  /** For a log or a receipt: the server's projection, the batch as sent, and the moment each asset was guarded on. */
  details: { projected: Command[]; sent: Command[]; stamps: Record<Oid, string> };
};

/**
 * A guarded batch in which at least one asset had changed (or gone) since
 * the moment it was guarded on. Thrown only when asked (`throwOnFailure`);
 * `result` is the whole GuardedResult — what did apply is committed — and
 * `conflicts` the assets nothing was applied to. Read the asset again and
 * decide: this is "someone else got there first", not a refusal.
 */
export class ConflictError<Row extends Asset = Asset> extends ApiError {
  readonly conflicts: Oid[];
  readonly result: GuardedResult<Row>;
  constructor(result: GuardedResult<Row>) {
    super(`${result.conflicts.join(", ")} changed since ${result.conflicts.length === 1 ? "it was" : "they were"} read; nothing was applied to ${result.conflicts.length === 1 ? "it" : "them"}`, 200, "CONFLICT", result.conflicts, "conflict");
    this.name = "ConflictError";
    this.conflicts = result.conflicts;
    this.result = result;
  }
}

export interface GuardedOptions extends Pick<assetApi.SendOptions, "lookup" | "throwOnFailure"> {
  /**
   * Moments the caller already holds, by OID: guard those assets on the
   * version the caller saw, not on one read now. Select `Moment` with the
   * row you show a person, keep it with what you drew, and pass it when
   * they act: a change made in between is then a conflict. Assets not
   * named here are read just before the send, as without this option. A
   * moment for an asset the batch does not touch is ignored.
   */
  moments?: Readonly<Record<Oid, string | number>>;
}

/**
 * Preview, stamp, send guarded. Throws UnguardableError, before any write,
 * for a batch the guard cannot cover (send such a batch with a plain send,
 * knowingly). With `throwOnFailure`, a failed command throws a
 * CommandFailureError and, when none failed, a conflict throws a
 * ConflictError.
 */
export async function sendGuarded<Row extends Asset = Asset>(transport: Transport, commands: Command[], options: GuardedOptions = {}): Promise<GuardedResult<Row>> {
  const refused = unguardable(commands);
  if (refused.length) throw new UnguardableError(refused);
  const projected = await assetApi.preview(transport, commands);
  const touched = touchedBy(projected);
  const ideas = touched.filter((oid) => UNGUARDABLE_TYPES.includes(typeOfOid(oid)));
  if (ideas.length) throw new UnguardableError(ideas.map((oid) => ({ index: -1, code: "noMoment" as const, reason: `${oid}: ${typeOfOid(oid)} keeps no history and has no Moment` })));
  const given = Object.fromEntries(Object.entries(options.moments ?? {}).map(([oid, m]) => [momentless(oid), String(m)]).filter(([oid]) => touched.includes(oid!)));
  const stamps: Record<Oid, string> = { ...(await stampsOf(transport, touched.filter((oid) => !(oid in given)))), ...given };
  const { outcome, sent, unstamped } = await sendPasses<Row>(transport, projected, stamps, { lookup: options.lookup, throwOnFailure: options.throwOnFailure });
  const result: GuardedResult<Row> = { ...outcome, touched, conflicts: conflictsOf(touched, outcome, sent, unstamped), details: { projected, sent, stamps } };
  if (options.throwOnFailure && result.conflicts.length) throw new ConflictError(result);
  return result;
}

/** The touched assets a guarded send applied nothing to and reported no failure for: their command matched nothing. */
export function conflictsOf(touched: readonly Oid[], outcome: assetApi.Outcome, sent: readonly Command[], unstamped: readonly Oid[]): Oid[] {
  const hit = new Set([...outcome.modified, ...outcome.operated].map(momentless));
  const failed = new Set(outcome.failures.flatMap((f) => (f.index === null ? [] : [oidOfSent(sent[f.index])])));
  return [...new Set([...unstamped, ...touched.filter((oid) => !hit.has(oid) && !failed.has(oid))])];
}

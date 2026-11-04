/**
 * The guard: an api/asset batch sent as a compare-and-set, so a change only
 * lands on an asset nobody else has changed since it was read. Ported from
 * gh-v1's lib/batch.js `guarded()`, with a different stamp.
 *
 * How: preview the batch (the server's projection expands every query-
 * scoped update and execute into one command per asset), read each touched
 * asset's ChangeDate, and send each per-asset command as a query-scoped one
 * filtered on its ID and that ChangeDate. An asset changed in between has a
 * newer ChangeDate, matches nothing, and is left alone; the response's
 * modified/operated lists say which assets the batch actually touched, so
 * the rest are `skipped`.
 *
 * The stamp, settled live on 2026-11-04 (test/integration/guard.test.ts):
 *   - ChangeDate as a filter LITERAL is a true compare-and-set: the value
 *     just read matches, a stale one matches nothing, and resending the same
 *     guarded batch writes nothing the second time.
 *   - ChangeDate as a `with` VARIABLE never matches, not even the value just
 *     read back — so this is the one place a value is spliced into filter
 *     text. It is the server's own timestamp, checked against a strict date
 *     pattern first, so it cannot carry grammar. The ID stays a variable.
 *   - Moment is NOT a stamp: `Moment=<an earlier moment of this asset>`
 *     selects the asset as it was then (as-of), and an update scoped by it
 *     lands on the current asset. A Moment guard guards nothing.
 * Every type has ChangeDate except the Ideas product's (Idea*), which keeps
 * no history and cannot be guarded.
 *
 * A guarded batch without creates is safe to send twice — an applied
 * command has advanced the ChangeDate, so a resend matches nothing — and is
 * sent marked idempotent (spec 000 §6).
 */
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless, typeOfOid } from "../types/oid";
import * as assetApi from "../wire/assetApi";
import type { AssetApiResponse, Command, CommandValue, ExecuteBody } from "../wire/assetApi";

/** OIDs per ChangeDate read: bounded, never one giant filter. */
export const CHUNK = 100;

/** Types with no ChangeDate (the Ideas product keeps no history): nothing of theirs can be guarded. */
export const UNGUARDABLE_TYPES: readonly AssetTypeToken[] = ["Idea", "IdeaChangeSet", "IdeaStatus", "IdeaComment", "IdeaCategory", "IdeaForum", "IdeaUser"];

/** Why a command cannot be sent guarded, by its index in the batch. */
export interface Unguardable { index: number; reason: string }

/** A batch the guard will not send, rather than send unguarded without saying so. */
export class UnguardableError extends Error {
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
    if (a && writes) out.push({ index, reason: `${a.alias} is an aliased ${"update" in body ? "update" : "execute"}: preview does not expand it, so it cannot be read or guarded per asset` });
    else if (!a && writes && typeof body.from === "string" && body.from.startsWith("@")) out.push({ index, reason: `a bare update or execute from an alias (${body.from}) is rejected by the server; alias the command itself` });
    if (isObject(body.update) && Object.values(body.update).some(isCreateValue)) out.push({ index, reason: "an update that creates assets inline: the projection normalises the creates away" });
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

/** A ChangeDate as the server writes it: 2026-11-04T16:49:40.12 (trailing zeros trimmed, no zone). */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/;

/** Each asset's current ChangeDate, one bounded query per type and chunk. An asset that no longer exists is absent. */
export async function stampsOf(transport: Transport, oids: readonly Oid[]): Promise<Record<Oid, string>> {
  const byType = new Map<string, Oid[]>();
  for (const oid of new Set(oids.map(momentless))) { const t = typeOfOid(oid); byType.set(t, [...(byType.get(t) ?? []), oid]); }
  const out: Record<Oid, string> = {};
  for (const [type, list] of byType) {
    if (UNGUARDABLE_TYPES.includes(type)) continue;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      const rows = await assetApi.query<Asset & { ChangeDate?: string }>(transport, { from: type, select: ["ChangeDate"], filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
      for (const r of rows) if (r.ChangeDate != null) out[momentless(r._oid)] = String(r.ChangeDate);
    }
  }
  return out;
}

/**
 * The batch to send: the projection, each per-asset update or execute
 * rewritten as a query-scoped command on its ID and ChangeDate. Creates and
 * queries pass through as the projection echoed them. An asset with no
 * stamp (gone since the preview) is left out and reported as skipped.
 */
export function guard(projected: Command[], stamps: Readonly<Record<Oid, string>>): { commands: Command[]; unstamped: Oid[] } {
  const commands: Command[] = [], unstamped: Oid[] = [];
  for (const p of projected) {
    const x = perAsset(p);
    if (!x) { commands.push(p); continue; }
    const stamp = stamps[x.oid];
    if (stamp === undefined) { unstamped.push(x.oid); continue; }
    if (!STAMP.test(stamp)) throw new Error(`${x.oid}: ChangeDate ${JSON.stringify(stamp)} is not a timestamp; refusing to put it in a filter`);
    // The literal is deliberate: as a `with` variable a ChangeDate never compares equal (see above).
    const scope = { from: typeOfOid(x.oid), filter: ["ID=$oid", `ChangeDate='${stamp}'`], with: { $oid: x.oid } };
    commands.push(x.update ? { ...scope, update: x.update } : { ...scope, execute: x.execute as ExecuteBody["execute"] });
  }
  return { commands, unstamped };
}

// ---- the whole move --------------------------------------------------------------

export interface GuardedResult<Row extends Asset = Asset> {
  response: AssetApiResponse<Row>;
  /** The server's projection the guard was built from. */
  projected: Command[];
  /** The batch as sent. */
  sent: Command[];
  /** Every asset the projection would update or operate on. */
  touched: Oid[];
  /** Each touched asset's ChangeDate when read: the stamp it was guarded on. */
  stamps: Record<Oid, string>;
  /**
   * Touched assets the batch left alone: changed or gone since they were
   * read — or their command failed, which `response.commandFailures` says.
   */
  skipped: Oid[];
}

/**
 * Preview, stamp, send guarded. Throws UnguardableError, before any request,
 * for a batch the guard cannot cover; send such a batch with assetApi.send,
 * knowingly.
 */
export async function sendGuarded<Row extends Asset = Asset>(transport: Transport, commands: Command[], options: Pick<assetApi.SendOptions, "lookup" | "throwOnFailure"> = {}): Promise<GuardedResult<Row>> {
  const refused = unguardable(commands);
  if (refused.length) throw new UnguardableError(refused);
  const projected = await assetApi.preview(transport, commands);
  const touched = touchedBy(projected);
  const ideas = touched.filter((oid) => UNGUARDABLE_TYPES.includes(typeOfOid(oid)));
  if (ideas.length) throw new UnguardableError(ideas.map((oid) => ({ index: -1, reason: `${oid}: ${typeOfOid(oid)} has no ChangeDate` })));
  const stamps = await stampsOf(transport, touched);
  const { commands: sent, unstamped } = guard(projected, stamps);
  const creates = sent.some((c) => "AssetType" in bodyOf(c));
  const response = await assetApi.send<Row>(transport, sent, { ...options, idempotent: !creates });
  const done = new Set([...response.assetsModified.oidTokens, ...response.assetsOperatedOn.oidTokens].map(momentless));
  return { response, projected, sent, touched, stamps, skipped: [...new Set([...unstamped, ...touched.filter((oid) => !done.has(oid))])] };
}

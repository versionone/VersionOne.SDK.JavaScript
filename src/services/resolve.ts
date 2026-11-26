/**
 * The resolve service: what a person types (an asset number, an OID token)
 * turned into the asset it names. Ported from the CLI consumer's resolve module,
 * minus the prompting, which stays in the
 * CLI.
 *
 * Which type a number's prefix belongs to is the instance's business (the
 * prefixes are configurable), so there is no client-side prefix map: every
 * type whose Number attribute is its own definition is a "number root", and
 * one api/asset request asks each root for all the numbers at once. Workitem
 * is one root and covers every workitem type, custom ones included; the rest
 * come from the metamodel (test/unit/resolve.test.ts recomputes the list
 * from metamodel.json, so it cannot drift).
 *
 * Numbers travel as a `with` list, never spliced into the filter text: a
 * value is then data, not grammar (an em dash in a filter literal fails to
 * parse; the same value as a variable does not — live, 2026-11-04). Number
 * matching on the server is case-insensitive.
 */
import { UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import { assetStateOf, type Asset, type AssetStateValue, type Oid } from "../types/asset";
import type { Schema, TypeCache } from "./schema";
import type { AssetTypeToken } from "../types/metamodel";
import { isOidToken, momentless, typeOfOid } from "../types/oid";
import * as assetApi from "../wire/assetApi";

/**
 * Types whose Number attribute is their own definition (no Base), from the
 * canned metamodel, each with what it can be asked for: Number always, Name
 * and AssetState where the type has them (ExternalActionInvocation has
 * neither, Grant no Name — an unknown select token fails the query).
 */
export const NUMBER_ROOTS: Readonly<Record<AssetTypeToken, readonly string[]>> = {
  Environment: ["Number", "Name", "AssetState"],
  ExternalActionInvocation: ["Number"],
  Goal: ["Number", "Name", "AssetState"],
  Grant: ["Number", "AssetState"],
  Issue: ["Number", "Name", "AssetState"],
  Milestone: ["Number", "Name", "AssetState"],
  Okr: ["Number", "Name", "AssetState"],
  OkrSession: ["Number", "Name", "AssetState"],
  RegressionPlan: ["Number", "Name", "AssetState"],
  RegressionSuite: ["Number", "Name", "AssetState"],
  RegressionTest: ["Number", "Name", "AssetState"],
  Request: ["Number", "Name", "AssetState"],
  Roadmap: ["Number", "Name", "AssetState"],
  StrategicTheme: ["Number", "Name", "AssetState"],
  Topic: ["Number", "Name", "AssetState"],
  Workitem: ["Number", "Name", "AssetState"]
};

/**
 * An asset number as a person types one: a prefix and digits (S-1234,
 * TK-12). Prefixes are instance configuration, so any length is accepted;
 * a false positive ("UTF-8") costs nothing but a `missing`. Scanning prose
 * for numbers (commit messages) wants a stricter pattern, and is the
 * caller's.
 */
export const isAssetNumber = (text: string): boolean => /^[A-Za-z]+-\d+$/.test(text.trim());

/** How many numbers one request asks about: bounded, never one giant filter. */
export const CHUNK = 100;

/**
 * A resolved asset: a row, under the names every row uses, with what
 * resolving reads. `Number` is null for an asset that has none (or for an
 * OID token taken as given by `ref`), `Name` and `AssetState` likewise.
 */
export interface ResolvedAsset {
  _oid: Oid;
  AssetType: AssetTypeToken;
  /** The number as the server spells it. */
  Number: string | null;
  Name: string | null;
  AssetState: AssetStateValue | null;
}

export interface Resolution {
  /** In the order asked for, one per distinct number (or OID) found. */
  found: ResolvedAsset[];
  /** What nothing answered to, as it was asked for. */
  missing: string[];
}

// Roots an instance turned out not to have, asked once, then left out. With a
// TypeCache (the client passes its schema's) that is the cache's own record of
// types the instance lacks (null), so clients that share a cache share it;
// without one, it is remembered per transport.
const absentRoots = new WeakMap<Transport, Set<string>>();

interface Absent { has(root: string): boolean; add(root: string): void }
const absentFor = (transport: Transport, types?: TypeCache): Absent => {
  if (types) return { has: (root) => types.types.get(root) === null, add: (root) => { types.types.set(root, null); } };
  const set = absentRoots.get(transport) ?? new Set<string>();
  absentRoots.set(transport, set);
  return set;
};
const UNKNOWN_TYPE = /^Unknown AssetType: (\S+)/;

type Row = Asset & { Name?: string | null; Number?: string; AssetState?: unknown };

async function askRoots(transport: Transport, numbers: string[], types?: TypeCache): Promise<Row[]> {
  const absent = absentFor(transport, types);
  for (let attempt = 0; ; attempt += 1) {
    const roots = Object.keys(NUMBER_ROOTS).filter((r) => !absent.has(r));
    try {
      const results = await assetApi.queries<Row>(transport, roots.map((from) => ({
        from,
        select: [...NUMBER_ROOTS[from]!],
        filter: ["Number=$numbers"],
        with: { $numbers: numbers },
        page: { size: numbers.length, start: 0 }
      })));
      return results.flat();
    } catch (error) {
      // An instance without one of the roots answers "Unknown AssetType" for
      // that query alone. Remember it and ask again without it — once; any
      // other failure is the caller's to see.
      const unknown = error instanceof assetApi.CommandFailureError ? error.failures.map((f) => UNKNOWN_TYPE.exec(f.message)?.[1]) : [];
      if (attempt > 0 || !unknown.length || unknown.some((t) => !t || !roots.includes(t))) throw error;
      for (const t of unknown) absent.add(t!);
    }
  }
}

/** Resolve asset numbers in one request per hundred numbers. Not found is not an error: it is `missing`. */
export async function resolveNumbers(transport: Transport, numbers: readonly string[], options: { types?: TypeCache } = {}): Promise<Resolution> {
  const firsts = new Map<string, string>();
  for (const n of numbers) if (!firsts.has(n.trim().toUpperCase())) firsts.set(n.trim().toUpperCase(), n.trim());
  const asked = [...firsts.values()];
  const invalid = asked.filter((n) => !isAssetNumber(n));
  if (invalid.length) throw new UsageError(`not asset numbers (expected a prefix and digits, S-1234): ${invalid.join(", ")}`);
  const byNumber = new Map<string, ResolvedAsset>();
  for (let i = 0; i < asked.length; i += CHUNK) {
    for (const r of await askRoots(transport, asked.slice(i, i + CHUNK), options.types)) {
      if (!r.Number || byNumber.has(r.Number.toUpperCase())) continue;
      const oid = momentless(r._oid);
      byNumber.set(r.Number.toUpperCase(), { _oid: oid, AssetType: typeOfOid(oid), Number: r.Number, Name: r.Name ?? null, AssetState: assetStateOf(r.AssetState) as AssetStateValue | null });
    }
  }
  return {
    found: asked.flatMap((n) => byNumber.get(n.toUpperCase()) ?? []),
    missing: asked.filter((n) => !byNumber.has(n.toUpperCase()))
  };
}

/**
 * One asset by whichever shape the person has: an OID token (Story:1234 —
 * used as is, no request, so `Number`, `Name` and `AssetState` are null) or
 * a number (resolved; null when no root knows it). Anything else is a
 * UsageError. `resolveRefs` reads OID tokens too.
 */
export async function resolveRef(transport: Transport, spec: string, options: { types?: TypeCache } = {}): Promise<ResolvedAsset | null> {
  const text = spec.trim();
  if (isOidToken(text)) { const oid = momentless(text); return { _oid: oid, AssetType: typeOfOid(oid), Number: null, Name: null, AssetState: null }; }
  if (isAssetNumber(text)) return (await resolveNumbers(transport, [text], options)).found[0] ?? null;
  throw new UsageError(`"${spec}" is neither an asset number (S-1234) nor an OID token (Story:1234)`);
}

/**
 * Several refs at once, numbers and OID tokens mixed, as a message or a
 * command line mentions them: every one is read, so each answer carries its
 * Number, Name and AssetState where its type has them, and one that names
 * nothing is `missing`. Two requests at most, however many refs: one for
 * the numbers (every number root asked at once), one for the OID tokens
 * (one query per asset type among them). `schema` says which of the three
 * attributes each OID's type has; an unknown select would fail the query.
 */
export async function resolveRefs(transport: Transport, schema: Schema, specs: readonly string[], options: { types?: TypeCache } = {}): Promise<Resolution> {
  const asked = [...new Map(specs.map((s) => [s.trim().toUpperCase(), s.trim()])).values()];
  const invalid = asked.filter((s) => !isOidToken(s) && !isAssetNumber(s));
  if (invalid.length) throw new UsageError(`neither asset numbers (S-1234) nor OID tokens (Story:1234): ${invalid.join(", ")}`);
  const numbers = asked.filter((s) => !isOidToken(s));
  const byNumber = new Map((numbers.length ? (await resolveNumbers(transport, numbers, options)).found : []).map((r) => [r.Number!.toUpperCase(), r]));
  const oids = [...new Set(asked.filter(isOidToken).map(momentless))];
  const byType = new Map<AssetTypeToken, Oid[]>();
  for (const oid of oids) byType.set(typeOfOid(oid), [...(byType.get(typeOfOid(oid)) ?? []), oid]);
  const queries: assetApi.QueryBody[] = [];
  for (const [type, list] of byType) {
    // A type the instance does not have has no assets: its OIDs are simply missing.
    if (!(await schema.load(type))) continue;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      queries.push({ from: type, select: ["Number", "Name", "AssetState"].filter((a) => schema.attribute(type, a)), filter: ["ID=$oids"], with: { $oids: part }, page: { size: part.length, start: 0 } });
    }
  }
  const byOid = new Map<Oid, ResolvedAsset>();
  for (const r of (queries.length ? await assetApi.queries<Row>(transport, queries) : []).flat()) {
    const oid = momentless(r._oid);
    byOid.set(oid, { _oid: oid, AssetType: typeOfOid(oid), Number: r.Number ?? null, Name: r.Name ?? null, AssetState: assetStateOf(r.AssetState) as AssetStateValue | null });
  }
  const isOid = (spec: string): boolean => isOidToken(spec);
  const answer = (spec: string): ResolvedAsset | undefined => (isOid(spec) ? byOid.get(momentless(spec)) : byNumber.get(spec.toUpperCase()));
  return { found: asked.flatMap((s) => answer(s) ?? []), missing: asked.filter((s) => !answer(s)) };
}

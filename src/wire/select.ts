/**
 * Select paths, resolved against the schema: what type of value a key in a
 * query row carries. api/asset and query.v1 spell every scalar as a string
 * and a sub-selected single relation as a one-element list, so translating
 * a row into the model needs the attribute behind each key. The grammar of
 * a select path (V1Query.g, as the docs publish it):
 *
 *   Attribute                        Estimate
 *   Relation.Attribute               Status.Name          one hop, or many
 *   Relation:Downcast                Children:Task        the relation narrowed to a subtype
 *   Relation[filter]                 BlockingIssues[AssetState!='Closed']
 *   Relation.@Aggregate              Owners.@Count        a number, always
 *
 * and a sub-select `{ from: <path>, select: [...] }` whose key in the row is
 * its `from`. A path is resolved hop by hop; a hop through a multi-value
 * relation makes the value a list.
 */
import type { AssetTypeToken, AttributeDefinition, AttributeLookup } from "../types/metamodel";
import { isOidToken, typeOfOid } from "../types/oid";

export type Aggregate = "Count" | "DistinctCount" | "Sum" | "Avg" | "Min" | "Max";

export type PathResolution =
  | {
      kind: "resolved";
      /** The attribute the path ends on; null for an aggregate. */
      definition: AttributeDefinition | null;
      /** For a relation, the type of the value (after any downcast); for a scalar, the type that defines it. */
      valueType: AssetTypeToken | null;
      /** True when any hop fans out: the value is a list. */
      multi: boolean;
      aggregate: Aggregate | null;
    }
  /** The lookup has not loaded this type; load it and resolve again. */
  | { kind: "needs"; type: AssetTypeToken }
  /** Not a path the schema knows (a missing attribute, a scalar mid-path): leave the value as sent. */
  | { kind: "unknown"; at: string };

interface Segment { name: string; downcast: string | null; aggregate: Aggregate | null }

/** Split a path on "." outside brackets and quotes, then read each segment. */
export function segmentsOf(path: string): Segment[] {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, current = "";
  for (const ch of path) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (ch === "." && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((raw) => {
    if (raw.startsWith("@")) return { name: raw, downcast: null, aggregate: raw.slice(1) as Aggregate };
    const bare = raw.replace(/\[[\s\S]*\]$/, ""); // a trailing [filter] narrows rows, not the type
    const colon = bare.indexOf(":");
    return colon < 0 ? { name: bare, downcast: null, aggregate: null } : { name: bare.slice(0, colon), downcast: bare.slice(colon + 1) || null, aggregate: null };
  });
}

/** An attribute of a type, by its bare name; undefined when the type is not loaded, null when the type has no such attribute. */
export function attributeOf(lookup: AttributeLookup, type: AssetTypeToken, name: string): AttributeDefinition | null | undefined {
  const t = lookup.assetType(type);
  if (t === undefined) return undefined;
  if (t === null) return null;
  return t.Attributes[`${type}.${name}`] ?? Object.values(t.Attributes).find((a) => a.Name === name) ?? null;
}

/** What a select path yields on rows of `type`. */
export function resolvePath(lookup: AttributeLookup, type: AssetTypeToken, path: string): PathResolution {
  const segments = segmentsOf(path);
  let current = type, multi = false, last: AttributeDefinition | null = null;
  for (const [i, seg] of segments.entries()) {
    if (seg.aggregate) {
      return i === segments.length - 1 ? { kind: "resolved", definition: null, valueType: null, multi: false, aggregate: seg.aggregate } : { kind: "unknown", at: path };
    }
    const def = attributeOf(lookup, current, seg.name);
    if (def === undefined) return { kind: "needs", type: current };
    if (def === null) return { kind: "unknown", at: `${current}.${seg.name}` };
    if (def.AttributeType !== "Relation") {
      return i === segments.length - 1 ? { kind: "resolved", definition: def, valueType: current, multi, aggregate: null } : { kind: "unknown", at: path };
    }
    multi ||= def.IsMultivalue;
    const next = seg.downcast ?? def.RelatedAsset;
    if (!next) return { kind: "unknown", at: `${current}.${seg.name}` };
    current = next;
    last = def;
  }
  return { kind: "resolved", definition: last, valueType: current, multi, aggregate: null };
}

/** The minimum of a query this module needs to see: where it reads from and what it selects. */
export interface SelectShape { from: string; select?: (string | SelectShape)[] }

/**
 * The asset type a query's `from` reads: a type token as is, the type of an
 * OID token, or the AssetType of the aliased create earlier in the batch.
 * Null when it cannot be told (an alias to a query, say).
 */
export function fromTypeOf(from: string, batch: readonly unknown[] = []): AssetTypeToken | null {
  const fromOid = isOidToken(from) ? typeOfOid(from) : null;
  if (fromOid) return fromOid;
  if (from.startsWith("@")) {
    for (const command of batch) {
      const body = (command as Record<string, unknown>)?.[from];
      const assetType = body && typeof body === "object" ? (body as Record<string, unknown>).AssetType : undefined;
      if (typeof assetType === "string") return assetType;
    }
    return null;
  }
  return from;
}

/**
 * The types the lookup must load before every key of this query's rows can
 * be resolved — empty when it can resolve them all now. A lazy schema loads
 * these and asks again; a path that still does not resolve is unknown, not
 * missing, and is left alone.
 */
export function typesNeeded(lookup: AttributeLookup, query: SelectShape, type: AssetTypeToken): Set<AssetTypeToken> {
  const needed = new Set<AssetTypeToken>();
  if (lookup.assetType(type) === undefined) { needed.add(type); return needed; }
  for (const entry of query.select ?? []) {
    const path = typeof entry === "string" ? entry : entry.from;
    const r = resolvePath(lookup, type, path);
    if (r.kind === "needs") needed.add(r.type);
    else if (r.kind === "resolved" && typeof entry !== "string" && r.valueType) for (const t of typesNeeded(lookup, entry, r.valueType)) needed.add(t);
  }
  return needed;
}

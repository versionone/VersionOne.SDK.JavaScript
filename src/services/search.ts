/**
 * Text search across asset types: one page of mixed rows, one order, a
 * total.
 *
 * Within one family of types a search is an ordinary read with `find`
 * (`client.query({ from: "Story", find, findin, … })`). Across unrelated
 * types (a Story, a Request, an Issue, a Goal on one page) the rows need
 * attributes their common base type does not define — `Number` first of
 * all — and that takes selecting a subtype's attribute from the base type.
 * rest-1 answers such a select; query.v1 and api/asset refuse it on
 * instances before the release that allows it. So this service asks
 * rest-1 today. That is not part of its contract: the call, the rows and
 * the total stay as they are when the route moves.
 *
 * The caller names an attribute once, plainly (`"Number"`, `"Status"`),
 * and never writes or reads a type-qualified name: the schema says which
 * of the searched types define it, the request asks each of them, and a
 * row has the key under its plain name — its value when the row's type
 * defines the attribute, null when it does not.
 */
import { UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import * as rest1 from "../wire/rest1";
import type { Schema } from "./schema";

/** The type every searchable asset descends from, and the one a mixed search reads. */
const ROOT = "BaseAsset";
export const DEFAULT_SELECT = ["Name", "Number", "AssetType", "AssetState"] as const;
export const DEFAULT_FINDIN = ["Name", "Number"] as const;

export interface SearchOptions {
  /**
   * The asset types to search: concrete types (`"Story"`, `"Request"`),
   * at least one. There is no default: a default of "work items" would
   * silently leave out requests, issues, goals and topics.
   */
  types: readonly string[];
  /**
   * Attributes for each row, by plain name; a path (`"Scope.Name"`) is
   * keyed as written. A row whose type lacks one has null there. Default:
   * Name, Number, AssetType, AssetState.
   */
  select?: readonly string[];
  /** Attributes to search in, by plain name. Default: Name and Number. Always sent: the server's own default differs by type. */
  findin?: readonly string[];
  /**
   * Filter terms, sent as written. Unlike a select, a filter is an
   * expression, and a condition across types has no plain spelling: a term
   * on an attribute only some types have is type-qualified by the caller
   * (`"(Workitem.Owners.IsSelf='true'|Request.Owner.IsSelf='true')"`).
   */
  filter?: readonly string[];
  /** Equality terms: attribute → value, the value carried as a variable. */
  where?: Readonly<Record<string, string>>;
  /** Variables for `filter`. */
  with?: Readonly<Record<string, string | string[]>>;
  /** Sort terms, sent as written (`"-ChangeDateUTC"`): one order across every type. */
  sort?: readonly string[];
  /** Required, like every read. */
  page: { size: number; start: number };
}

/** A search row when the caller names no type of its own: `_oid` and the selected keys. */
export type SearchRow = { _oid: Oid } & Record<string, unknown>;

/** One page of a search: the rows, how many assets match in all, and whether more follow this page. */
export interface SearchResult<Row extends { _oid: Oid } = SearchRow> { rows: Row[]; total: number | null; more: boolean }

const quoted = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The types as a set, each loaded and checked: known, concrete, and a descendant of the root. */
async function checked(schema: Schema, types: readonly string[]): Promise<string[]> {
  if (!Array.isArray(types) || !types.length) throw new UsageError("search needs `types`: the asset types to search, such as [\"Story\", \"Defect\", \"Request\"]; there is no default");
  const unique = [...new Set(types)];
  await Promise.all([ROOT, ...unique].map((t) => schema.load(t)));
  for (const token of unique) {
    const type = schema.assetType(token);
    if (!type) throw new UsageError(`search: there is no asset type "${token}"`);
    if (type.Abstract) throw new UsageError(`search: "${token}" is an abstract type; list the concrete types to search, or use client.query with \`find\` to search one family (from: "${token}")`);
    let base = type.Base;
    while (base && base !== ROOT) base = (await schema.load(base))?.Base;
    if (base !== ROOT) throw new UsageError(`search: "${token}" does not descend from ${ROOT} and cannot be searched with other types; use client.query with \`find\` (from: "${token}")`);
  }
  return unique;
}

/**
 * A plain name as the request spells it: itself when every searched asset
 * has it (the root defines it, or one type is searched), otherwise once
 * per type that defines it, qualified. A name no type defines is a
 * mistake in the call.
 */
function spelled(schema: Schema, types: readonly string[], names: readonly string[], what: string): string[] {
  if (types.length === 1) {
    for (const name of names) if (!schema.attribute(types[0]!, name.split(".")[0]!)) throw new UsageError(`search: ${what} "${name}" is not an attribute of ${types[0]}`);
    return [...names];
  }
  return names.flatMap((name) => {
    const head = name.split(".")[0]!;
    if (schema.attribute(ROOT, head)) return [name];
    const defining = types.filter((t) => schema.attribute(t, head));
    if (!defining.length) throw new UsageError(`search: ${what} "${name}" is not an attribute of any type searched (${types.join(", ")})`);
    return defining.map((t) => `${t}.${name}`);
  });
}

/** A row with exactly the selected keys: null where its type has no such attribute, a relation as bare Refs, nothing unselected. */
function shaped<Row extends { _oid: Oid }>(row: Asset, select: readonly string[]): Row {
  const out: Record<string, unknown> = { _oid: row._oid };
  const bare = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(bare) : value && typeof value === "object" && typeof (value as { _oid?: unknown })._oid === "string" ? { _oid: (value as { _oid: string })._oid } : value;
  const sent = row as unknown as Record<string, unknown>;
  // A selected path's values arrive beside the relation and were folded onto its Refs: read them back from there.
  const along = (name: string): unknown => {
    const dot = name.indexOf(".");
    const target = dot < 0 ? undefined : sent[name.slice(0, dot)];
    const attribute = name.slice(dot + 1);
    const of = (ref: unknown): unknown => (ref && typeof ref === "object" ? (ref as Record<string, unknown>)[attribute] ?? null : null);
    return Array.isArray(target) ? target.map(of) : of(target);
  };
  for (const name of select) out[name] = name in sent ? bare(sent[name] ?? null) : along(name);
  return out as Row;
}

/** One page of the assets of `types` whose text matches, as `{ rows, total, more }`. */
export async function search<Row extends { _oid: Oid } = SearchRow>(transport: Transport, schema: Schema, text: string, options: SearchOptions): Promise<SearchResult<Row>> {
  if (typeof text !== "string" || !text.trim()) throw new UsageError("search needs text: the server answers a search for nothing with no rows, which would read as \"nothing matches\"");
  if (!options?.page) throw new UsageError("search without a page: every read must be bounded");
  const types = await checked(schema, options.types);
  const select = [...new Set(options.select ?? DEFAULT_SELECT)];
  const findin = [...new Set(options.findin ?? DEFAULT_FINDIN)];
  if (!findin.length) throw new UsageError("search needs at least one attribute in `findin`");
  const one = types.length === 1;
  const filter = [...(options.filter ?? [])];
  const variables: Record<string, string | string[]> = { ...options.with };
  Object.entries(options.where ?? {}).forEach(([attribute, value], i) => {
    const name = `$where${i}`;
    filter.push(`${attribute}=${name}`);
    variables[name] = value;
  });
  if (!one) filter.unshift(`AssetType=${types.map(quoted).join(",")}`);
  const result = await rest1.list(transport, one ? types[0]! : ROOT, {
    find: text,
    findin: spelled(schema, types, findin, "findin"),
    select: spelled(schema, types, select, "select"),
    filter: filter.length ? filter : undefined,
    with: Object.keys(variables).length ? variables : undefined,
    sort: options.sort ? [...options.sort] : undefined,
    page: options.page,
    needTotal: true
  });
  return { rows: result.rows.map((row) => shaped<Row>(row, select)), total: result.total, more: result.more };
}

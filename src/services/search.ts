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
import { ATTRIBUTE_NAMES, CONCRETE_SUBTYPES } from "../types/assets/subtypes";
import * as rest1 from "../wire/rest1";
import type { Schema } from "./schema";

/** The type every searchable asset descends from, and the one a mixed search reads. */
const ROOT = "BaseAsset";
export const DEFAULT_SELECT = ["Name", "Number", "AssetType", "AssetState"] as const;
export const DEFAULT_FINDIN = ["Name", "Number"] as const;

export interface SearchOptions {
  /**
   * The asset types to search, at least one: concrete types (`"Story"`,
   * `"Request"`), or a family by its abstract type (`"Workitem"` is
   * stories, defects, epics, themes, tasks, tests and test sets). There is
   * no default: one would silently leave types out.
   */
  types: readonly string[];
  /**
   * Attributes for each row, by plain name; a path (`"Scope.Name"`) is
   * keyed as written. A row whose type lacks one has null there, and so
   * does every row when none of the searched types has it. Default: Name,
   * Number, AssetType, AssetState.
   */
  select?: readonly string[];
  /**
   * Attributes to search in, by plain name. Default: Name and Number.
   * Always sent: the server's own default differs by type. One that none
   * of the searched types has is left out; if none is left, the search is
   * refused.
   */
  findin?: readonly string[];
  /**
   * Filter terms, sent as written. Unlike a select, a filter is an
   * expression, and a condition across types has no plain spelling: a term
   * on an attribute only some types have is type-qualified by the caller
   * (`"(Workitem.Owners.IsSelf='true'|Request.Owner.IsSelf='true')"`).
   * Qualify such a term whatever `types` is: an unqualified
   * `"Owners.Name='x'"` happens to be accepted when one type is searched
   * and is refused when several are.
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

/**
 * The types as a set of concrete types, each loaded and checked. A family
 * named by its abstract type (`"Workitem"`) stands for its concrete
 * subtypes as the product ships them; one of those this instance does not
 * have is left out, since the caller did not name it.
 */
async function checked(schema: Schema, types: readonly string[]): Promise<string[]> {
  if (!Array.isArray(types) || !types.length) throw new UsageError("search needs `types`: the asset types to search, such as [\"Story\", \"Defect\", \"Request\"]; there is no default");
  const named = [...new Set(types)];
  await Promise.all([ROOT, ...named].map((t) => schema.load(t)));
  const concrete = new Set<string>();
  for (const token of named) {
    const type = schema.assetType(token);
    if (!type) throw new UsageError(`search: there is no asset type "${token}"`);
    if (!type.Abstract) { concrete.add(token); continue; }
    const family = CONCRETE_SUBTYPES[token];
    if (!family) throw new UsageError(`search: "${token}" is an abstract type whose concrete subtypes the SDK does not know; list the concrete types to search`);
    const loaded = await Promise.all(family.map((t) => schema.load(t)));
    family.forEach((t, i) => { if (loaded[i]) concrete.add(t); });
  }
  for (const token of concrete) {
    let base = schema.assetType(token)!.Base;
    while (base && base !== ROOT) base = (await schema.load(base))?.Base;
    if (base !== ROOT) throw new UsageError(`search: "${token}" does not descend from ${ROOT} and cannot be searched with other types; use client.query with \`find\` (from: "${token}")`);
  }
  if (!concrete.size) throw new UsageError(`search: none of the types named (${named.join(", ")}) has a concrete type on this instance`);
  return [...concrete];
}

/**
 * Plain names as the request spells them. A name every searched asset has
 * (the root defines it, or one type is searched and has it) goes as
 * written; otherwise it goes once per searched type that defines it,
 * qualified. A name none of the searched types defines is left out of the
 * request (each row then has null there, by the rule: a row has the key's
 * value if its type has the attribute): which types are searched is often
 * a user's choice, and a caller's fixed list of columns must not fail for
 * it. Only a name that is no attribute of anything is a mistake in the
 * call: not one of the product's attribute names, not a custom field, not
 * defined by any type searched.
 */
function spelled(schema: Schema, types: readonly string[], names: readonly string[], what: string): string[] {
  const one = types.length === 1;
  return names.flatMap((name) => {
    const head = name.split(".")[0]!;
    if (one ? schema.attribute(types[0]!, head) : schema.attribute(ROOT, head)) return [name];
    const defining = one ? [] : types.filter((t) => schema.attribute(t, head));
    if (!defining.length && !ATTRIBUTE_NAMES.has(head) && !head.startsWith("Custom_")) throw new UsageError(`search: ${what} "${name}" is not an attribute of any asset type (searched: ${types.join(", ")})`);
    return defining.map((t) => `${t}.${name}`);
  });
}

/** A row with exactly the selected keys: null where its type has no such attribute, nothing unselected. */
function shaped<Row extends { _oid: Oid }>(row: Asset, select: readonly string[]): Row {
  const sent = row as unknown as Record<string, unknown>;
  return Object.fromEntries([["_oid", row._oid], ...select.map((name) => [name, sent[name] ?? null])]) as Row;
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
  const searchIn = spelled(schema, types, findin, "findin");
  if (!searchIn.length) throw new UsageError(`search: none of the types searched (${types.join(", ")}) has any of the attributes in \`findin\` (${findin.join(", ")}): there is nothing to search in`);
  const asked = spelled(schema, types, select, "select");
  // The paths' related types too, so a date at the end of a path is spelled as every read spells it.
  await schema.ensureFor(types.map((from) => ({ from, select: select.filter((name) => schema.attribute(from, name.split(".")[0]!)) })));
  const result = await rest1.list(transport, one ? types[0]! : ROOT, {
    find: text,
    findin: searchIn,
    // Every searched asset has a Name: asked for when nothing selected applies, so the server does not choose the attributes itself.
    select: asked.length ? asked : ["Name"],
    filter: filter.length ? filter : undefined,
    with: Object.keys(variables).length ? variables : undefined,
    sort: options.sort ? [...options.sort] : undefined,
    page: options.page,
    needTotal: true
  }, { lookup: schema });
  return { rows: result.rows.map((row) => shaped<Row>(row, select)), total: result.total, more: result.more };
}

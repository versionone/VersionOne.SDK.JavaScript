/**
 * The rest-1.v1 wire module: what the endpoint takes and returns, and the
 * translation into the model. rest-1 is the endpoint with the most
 * translation, which is exactly why none of it may leak past this file.
 *
 * Reads (all GET, JSON asked for by Accept):
 *   /rest-1.v1/Data/<Type>           a list; where, sel, find, findin, sort, page (size,start), deleted, needTotal, with, asof
 *                                    (taken as a query's `filter`/`select`; `where`/`sel` are rest-1's spellings, translated here)
 *   /rest-1.v1/Data/<Type>/<id>      one asset
 *   /rest-1.v1/Hist/<Type>[/<id>]    history: the same shape, one row per moment, ids carrying the moment
 *   /rest-1.v1/New/<Type>?ctx=<oid>   a template: the asset the type's initializer would create in that
 *                                    context (the server runs the type's initializer with ctx as the
 *                                    context OID — a Timebox gets the next sprint name, dates after the
 *                                    schedule's last timebox, the schedule, a state and the owner; live
 *                                    2026-11-14). Same document shape, id "", every attribute with act "set".
 *
 * Two writes, kept narrow: rest-1 carries nothing api/asset does, except
 *   POST /rest-1.v1/Data/<Type>/<id>?op=<Operation>   the operation's RESULT, which api/asset drops:
 *                                    Copy answers the new asset's id (Story:146979:194422), any other
 *                                    operation the source at its new moment; an unknown operation is 400
 *                                    "Unknown Operation 'Story.NoSuchOp'" (live 2026-11-14).
 *
 * What it returns, verified against a dev instance (2026-09-07):
 *   { _type: "Assets"|"History", total?, pageSize, pageStart, Assets: [
 *       { _type: "Asset", href, id: "Story:2104"|"Story:2104:2797", Attributes: {
 *           Name:   { _type: "Attribute", name, value },                      scalar; multi-value as an array
 *           Owners: { _type: "Relation",  name, value: [{ _type: "Asset", href, idref }] }   multi-value relation
 *           Super:  { _type: "Relation",  name, value: { _type: "Asset", href, idref } | null } single relation
 *       } } ] }
 *   - `total` only with needTotal=true (else absent; -1 in some renderings).
 *   - AssetState is the NUMBER (the server's AssetState enum); the model wants the name.
 *   - a type-qualified sel (Story.Number on BaseAsset) arrives keyed by its plain name (Number).
 *   - selecting a relation also brings its display columns (Owners.Name,
 *     Owners.Nickname, Status.Name) uninvited; they are dropped unless selected.
 *   - a page is required by this module: no Data read is unbounded.
 */
import { ApiError, UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import { assetStateOf, dateString, type Asset, type Oid, type Ref } from "../types/asset";
import type { AttributeLookup } from "../types/metamodel";
import { momentless } from "../types/oid";
import type { Query, QueryBody } from "./assetApi";
import { rejected } from "./queryV1";
import { resolvePath } from "./select";

export { momentless };

// ---- what the endpoint returns -------------------------------------------

export interface AssetRefDocument { _type: "Asset"; href: string; idref: Oid }
export interface AttributeDocument { _type: "Attribute"; name: string; value: unknown }
export interface RelationDocument { _type: "Relation"; name: string; value: AssetRefDocument | AssetRefDocument[] | null }
export interface AssetDocument { _type: "Asset"; href: string; id: string; Attributes?: Record<string, AttributeDocument | RelationDocument> }
export interface AssetsDocument { _type: "Assets" | "History"; total?: number; pageSize: number; pageStart: number; Assets: AssetDocument[] }

// ---- what the endpoint takes ---------------------------------------------

export interface ReadParams {
  /** Attributes to select, as a query's `select`; a type-qualified name (Story.Number) reaches a subtype's attribute from a base type. */
  select?: string[];
  /** Filter terms, as a query's `filter`, joined with ';' (AND). */
  filter?: string[];
  /** The filter context: { $oids: [...] } — sent in rest-1's spelling, $name=a,b|$other=c. */
  with?: Record<string, string | string[]>;
  find?: string;
  findin?: string[];
  sort?: string[];
  /** Required. size first, then start. */
  page: { size: number; start: number };
  deleted?: boolean;
  needTotal?: boolean;
  asof?: string;
}

// ---- translation -----------------------------------------------------------


const toRef = (doc: AssetRefDocument): Ref => ({ _oid: momentless(doc.idref) });

/**
 * One rest-1 asset as the model carries it. Relations become Refs;
 * AssetState becomes its name; everything else is the value as sent. The
 * row's own _oid keeps its moment only on a history read (it is the moment
 * that identifies the row).
 *
 * A Ref is `{ _oid }` and nothing else, as on every read. rest-1 adds
 * display columns beside a selected relation without being asked
 * (`Owners.Name`, `Owners.Nickname`): they are dropped, because the row
 * has the keys that were selected and no others. A path the caller did
 * select (`"Owners.Name"`, or type-qualified, `"Story.Owners.Name"`) is at
 * `row["Owners.Name"]`. When nothing was selected (a template, a read
 * without `select`) the server chose the attributes, and every column it
 * sent stays, under its own key.
 */
export function fromAssetDocument<Row extends Asset = Asset>(doc: AssetDocument, { history = false, select }: { history?: boolean; select?: readonly string[] } = {}): Row {
  const out: Record<string, unknown> = { _oid: history ? doc.id : momentless(doc.id) };
  // rest-1 keys a type-qualified select (`Story.Scope.Name`) by its plain path (`Scope.Name`).
  const selected = (key: string): boolean => !select || select.some((s) => s === key || s.endsWith(`.${key}`));
  for (const [key, a] of Object.entries(doc.Attributes ?? {})) {
    if (a._type === "Relation") {
      out[key] = Array.isArray(a.value) ? a.value.map(toRef) : a.value ? toRef(a.value) : null;
    } else if (key.includes(".") && !selected(key)) {
      continue; // a display column nobody asked for
    } else if (key === "AssetState" && typeof a.value === "number") {
      out[key] = assetStateOf(a.value);
    } else {
      out[key] = a.value;
    }
  }
  return out as Row;
}

/**
 * What a rest-1 read is given beyond its parameters: the schema, so a date
 * is spelled as every read spells it. rest-1 sends values already typed
 * (a number is a number) except dates, which it writes its own way, and a
 * date cannot be told from text by its looks. Without a lookup, or for a
 * type it has not loaded, values are as rest-1 sent them.
 */
export interface ReadContext {
  /**
   * A lookup that can also load (the client's schema) is asked for the
   * types of the rows that came back before they are read: a read through
   * a base type answers rows of its subtypes, which no caller can load
   * ahead of the answer.
   */
  lookup?: AttributeLookup & { ensureFor?(commands: readonly { from: string; select?: string[] }[]): Promise<void> };
}

/** The row's dates in the model's spelling, by the row's own type. */
function dated<Row extends Asset>(row: Row, lookup: AttributeLookup | undefined): Row {
  if (!lookup) return row;
  const type = row._oid.split(":")[0]!;
  const values = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (key === "_oid" || (typeof value !== "string" && !Array.isArray(value))) continue;
    const resolution = resolvePath(lookup, type, key);
    if (resolution.kind !== "resolved" || resolution.definition?.AttributeType !== "Date") continue;
    values[key] = Array.isArray(value) ? value.map(dateString) : dateString(value);
  }
  return row;
}

/** The query string rest-1 wants, from the model's parameters. */
export function toQuery(params: ReadParams): Record<string, string | undefined> {
  return {
    sel: params.select?.join(","),
    where: params.filter?.length ? params.filter.join(";") : undefined,
    with: params.with ? Object.entries(params.with).map(([k, v]) => `${k}=${[].concat(v as never).join(",")}`).join("|") : undefined,
    find: params.find,
    findin: params.findin?.join(","),
    sort: params.sort?.join(","),
    page: `${params.page.size},${params.page.start}`,
    deleted: params.deleted === undefined ? undefined : String(params.deleted),
    needTotal: params.needTotal === undefined ? undefined : String(params.needTotal),
    asof: params.asof
  };
}

// ---- the calls -------------------------------------------------------------

/** One page of a rest-1 read: the rows, the total when asked for with `needTotal` (null otherwise), and whether more pages follow (as `Page.more`: exact with a total, else whether this page came back full). */
export interface ReadResult<Row extends Asset = Asset> { rows: Row[]; total: number | null; more: boolean; pageSize: number; pageStart: number }

async function read<Row extends Asset>(transport: Transport, path: string, params: ReadParams, history: boolean, context: ReadContext = {}): Promise<ReadResult<Row>> {
  if (!params.page) throw new UsageError(`rest-1 read of ${path} without a page: every read must be bounded`);
  let doc: AssetsDocument;
  try {
    doc = await transport.request<AssetsDocument>({ method: "GET", path, query: toQuery(params), responseType: "json" });
  } catch (error) {
    // A read rest-1 refused (a bad filter, an unknown attribute) reads like one query.v1 refused.
    throw error instanceof ApiError && error.status === 400 ? rejected(error) : error;
  }
  const sent = (doc.Assets ?? []).map((a) => fromAssetDocument<Row>(a, { history, select: params.select }));
  await context.lookup?.ensureFor?.([...new Set(sent.map((row) => row._oid.split(":")[0]!))].map((from) => ({ from, select: params.select })));
  const rows = sent.map((row) => dated(row, context.lookup));
  const total = typeof doc.total === "number" && doc.total >= 0 ? doc.total : null;
  return { rows, total, more: total === null ? rows.length === params.page.size : params.page.start + rows.length < total, pageSize: doc.pageSize, pageStart: doc.pageStart };
}

/** A bounded list read of a type. */
export const list = <Row extends Asset = Asset>(transport: Transport, type: string, params: ReadParams, context?: ReadContext): Promise<ReadResult<Row>> =>
  read<Row>(transport, `/rest-1.v1/Data/${encodeURIComponent(type)}`, params, false, context);

/** One asset by OID. */
export async function get<Row extends Asset = Asset>(transport: Transport, oid: Oid, select?: string[], context: ReadContext = {}): Promise<Row> {
  const [type, id] = momentless(oid).split(":");
  const doc = await transport.request<AssetDocument>({ method: "GET", path: `/rest-1.v1/Data/${encodeURIComponent(type!)}/${encodeURIComponent(id!)}`, query: { sel: select?.join(",") }, responseType: "json" });
  return dated(fromAssetDocument<Row>(doc, { select }), context.lookup);
}

/**
 * What an operation answered with: the asset the server returned, as an
 * OID token — for Copy the copy, for anything else the operated asset —
 * and the moment the server stamped on it.
 */
export interface OperationResult { oid: Oid; moment: string | null }

/**
 * Run an operation (Copy, Inactivate, …) through rest-1, for its result.
 * api/asset's `execute` performs the same operations but reports only the
 * operated asset, so a Copy's new OID is unobservable there; rest-1 answers
 * it. Not idempotent: never retried.
 */
export async function operate(transport: Transport, oid: Oid, op: string): Promise<OperationResult> {
  const [type, id] = momentless(oid).split(":");
  if (!type || !id) throw new UsageError(`"${oid}" is not an OID token (Story:1234)`);
  const doc = await transport.request<AssetDocument>({ method: "POST", path: `/rest-1.v1/Data/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, query: { op }, responseType: "json" });
  if (!doc || typeof doc.id !== "string" || !doc.id) throw new ApiError(`rest-1 ${op} on ${oid} did not answer with an asset`, 200, "BAD_RESPONSE", doc);
  const moment = doc.id.split(":")[2] ?? null;
  return { oid: momentless(doc.id), moment };
}

/** A new asset's template as the model carries it: the attributes the initializer set, no `_oid`. */
export type Template<Row extends Asset = Asset> = Partial<Omit<Row, "_oid">>;

/**
 * The template for a new asset of `type` in a context (a Scope, a parent
 * asset): what the server's initializer would fill in — defaults nothing
 * else exposes. Idempotent, like any GET. Without a context the template
 * is empty, and an unknown context is echoed back, not refused.
 */
export async function template<Row extends Asset = Asset>(transport: Transport, type: string, options: { ctx?: Oid } & ReadContext = {}): Promise<Template<Row>> {
  const doc = await transport.request<AssetDocument>({ method: "GET", path: `/rest-1.v1/New/${encodeURIComponent(type)}`, query: { ctx: options.ctx ? momentless(options.ctx) : undefined }, responseType: "json" });
  const { _oid: _ignored, ...values } = dated(fromAssetDocument<Row>({ ...doc, id: doc.id || `${type}:0` }), options.lookup);
  return values as Template<Row>;
}

/** A bounded history read: one row per moment, _oid carrying the moment. */
export const history = <Row extends Asset = Asset>(transport: Transport, target: string, params: ReadParams, context?: ReadContext): Promise<ReadResult<Row>> => {
  const [type, id] = target.split(":");
  const path = id ? `/rest-1.v1/Hist/${encodeURIComponent(type!)}/${encodeURIComponent(id)}` : `/rest-1.v1/Hist/${encodeURIComponent(type!)}`;
  return read<Row>(transport, path, params, true, context);
};

// ---- rest-1 spellings of a query -----------------------------------------------

/**
 * A query as someone who knows rest-1 writes it, or as a saved rest-1 URL's
 * parameters read: `sel` for `select`, `where` as filter text, lists as
 * comma-joined strings, `page` as "size,start". Anything a QueryBody
 * already says is accepted unchanged.
 */
export interface LooseQuery {
  from: string;
  select?: string | (string | LooseQuery)[];
  /** rest-1's spelling of `select`. */
  sel?: string | (string | LooseQuery)[];
  filter?: string | string[];
  /** rest-1's spelling: filter text (one term, or a list of terms). An object is a query's own `where` (attribute → value) and stays one. */
  where?: string | string[] | Record<string, string>;
  sort?: string | string[];
  findin?: string | string[];
  /** `{ size, start }`, or rest-1's "size,start". */
  page?: { size: number | string; start: number | string } | string;
  [key: string]: unknown;
}

/** Split a comma-joined list outside brackets, parentheses and quotes: "Name,Owners[Name='a,b'].Name" is two entries. */
function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, current = "";
  for (const ch of text) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}
const listOf = (value: string | string[]): string[] => (typeof value === "string" ? splitList(value) : value);

/**
 * A query written with rest-1's spellings, as the QueryBody every read
 * takes: `sel` becomes `select`, a textual `where` becomes `filter`,
 * comma-joined `select` / `sort` / `findin` become lists, and a
 * "size,start" page becomes `{ size, start }`; sub-selects are normalised
 * the same way, and every other key is kept as written. A query that
 * already is a QueryBody comes back equal; one written with a page is
 * typed as a read takes it (`Query`). Nothing is sent. Saying one
 * thing twice (`sel` and `select`, a textual `where` and `filter`) is a
 * UsageError rather than a guess at which was meant, and so is `deleted`:
 * a QueryBody cannot ask for deleted assets (`client.deleted` reads those).
 */
export function normalizeQuery(query: LooseQuery & { page: NonNullable<LooseQuery["page"]> }): Query;
export function normalizeQuery(query: LooseQuery): QueryBody;
export function normalizeQuery(query: LooseQuery): QueryBody {
  if (!query || typeof query !== "object" || typeof query.from !== "string" || !query.from) throw new UsageError("a query needs a `from`: an asset type token or an OID token");
  const { sel, select, where, filter, sort, findin, page, ...rest } = query;
  if (sel !== undefined && select !== undefined) throw new UsageError(`query of ${query.from} has both \`sel\` and \`select\`: write one (\`select\`)`);
  if ("deleted" in rest) throw new UsageError(`query of ${query.from} asks for \`deleted\`: only rest-1 reads deleted assets — use client.deleted(type, params)`);
  const out: Record<string, unknown> = { ...rest };
  const chosen = select ?? sel;
  if (chosen !== undefined) out.select = listOf(chosen as string | string[]).map((entry: string | LooseQuery) => (typeof entry === "string" ? entry : normalizeQuery(entry)));
  const textualWhere = typeof where === "string" || Array.isArray(where);
  if (textualWhere && filter !== undefined) throw new UsageError(`query of ${query.from} has both a textual \`where\` and \`filter\`: write one (\`filter\`)`);
  if (textualWhere) out.filter = typeof where === "string" ? [where] : where;
  else if (where !== undefined) out.where = where;
  if (filter !== undefined) out.filter = typeof filter === "string" ? [filter] : filter;
  if (sort !== undefined) out.sort = listOf(sort);
  if (findin !== undefined) out.findin = listOf(findin);
  if (page !== undefined) {
    const [size, start] = typeof page === "string" ? page.split(",").map((n) => Number(n.trim())) : [Number(page.size), Number(page.start)];
    if (!Number.isInteger(size) || !Number.isInteger(start) || size! < 0 || start! < 0) throw new UsageError(`query of ${query.from}: page ${JSON.stringify(page)} is not { size, start } or "size,start"`);
    out.page = { size, start };
  }
  for (const flag of ["needTotal"]) if (out[flag] === "true" || out[flag] === "false") out[flag] = out[flag] === "true";
  return out as unknown as QueryBody;
}

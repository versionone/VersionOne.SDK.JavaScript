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
 *
 * What it returns, verified against a dev instance (2026-09-07):
 *   { _type: "Assets"|"History", total?, pageSize, pageStart, Assets: [
 *       { _type: "Asset", href, id: "Story:2104"|"Story:2104:2797", Attributes: {
 *           Name:   { _type: "Attribute", name, value },                      scalar; multi-value as an array
 *           Owners: { _type: "Relation",  name, value: [{ _type: "Asset", href, idref }] }   multi-value relation
 *           Super:  { _type: "Relation",  name, value: { _type: "Asset", href, idref } | null } single relation
 *       } } ] }
 *   - `total` only with needTotal=true (else absent; -1 in some renderings).
 *   - AssetState is the NUMBER (Core's AssetState enum); the model wants the name.
 *   - a type-qualified sel (Story.Number on BaseAsset) arrives keyed by its plain name (Number).
 *   - selecting a relation also brings its display columns (Owners.Name,
 *     Owners.Nickname, Status.Name) uninvited; they are folded onto the Refs.
 *   - a page is required by this module: no Data read is unbounded.
 */
import { UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import { assetStateOf, type Asset, type Oid, type Ref } from "../types/asset";
import { momentless } from "../types/oid";

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
  /** @deprecated rest-1's own spelling of `select`; kept for one alpha. */
  sel?: string[];
  /** Filter terms, as a query's `filter`, joined with ';' (AND). */
  filter?: string[];
  /** @deprecated rest-1's own spelling of `filter`; kept for one alpha. */
  where?: string[];
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
 * One rest-1 asset as the model carries it. Relations become Refs; the
 * display columns rest-1 adds beside a selected relation (Owners.Name) are
 * folded onto those Refs by position, and kept under their dotted key too
 * for a caller that asked for them by name; AssetState becomes its name;
 * everything else is the value as sent. The row's own _oid keeps its
 * moment only on a history read (it is the moment that identifies the row).
 */
export function fromAssetDocument<Row extends Asset = Asset>(doc: AssetDocument, { history = false } = {}): Row {
  const out: Record<string, unknown> = { _oid: history ? doc.id : momentless(doc.id) };
  const attrs = doc.Attributes ?? {};
  for (const [key, a] of Object.entries(attrs)) {
    if (a._type === "Relation") {
      out[key] = Array.isArray(a.value) ? a.value.map(toRef) : a.value ? toRef(a.value) : null;
    } else if (key === "AssetState" && typeof a.value === "number") {
      out[key] = assetStateOf(a.value);
    } else {
      out[key] = a.value;
    }
  }
  // Fold "Rel.Attr" columns onto the Ref(s) of a selected relation.
  for (const [key, a] of Object.entries(attrs)) {
    const dot = key.indexOf(".");
    if (dot < 0 || a._type !== "Attribute") continue;
    const rel = key.slice(0, dot), attr = key.slice(dot + 1);
    if (attr.includes(".")) continue; // deeper paths stay as columns only
    const target = out[rel];
    const values = a.value;
    if (Array.isArray(target) && Array.isArray(values)) target.forEach((ref, i) => { if (ref && typeof ref === "object") (ref as Record<string, unknown>)[attr] = values[i]; });
    else if (target && typeof target === "object" && !Array.isArray(target) && !Array.isArray(a.value)) (target as Record<string, unknown>)[attr] = a.value;
  }
  return out as Row;
}

/** The query string rest-1 wants, from the model's parameters. */
export function toQuery(params: ReadParams): Record<string, string | undefined> {
  return {
    sel: (params.select ?? params.sel)?.join(","),
    where: (params.filter ?? params.where)?.length ? (params.filter ?? params.where)!.join(";") : undefined,
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

export interface ReadResult<Row extends Asset = Asset> { rows: Row[]; total: number | null; pageSize: number; pageStart: number }

async function read<Row extends Asset>(transport: Transport, path: string, params: ReadParams, history: boolean): Promise<ReadResult<Row>> {
  if (!params.page) throw new UsageError(`rest-1 read of ${path} without a page: every read must be bounded`);
  const doc = await transport.request<AssetsDocument>({ method: "GET", path, query: toQuery(params), responseType: "json" });
  return { rows: (doc.Assets ?? []).map((a) => fromAssetDocument<Row>(a, { history })), total: typeof doc.total === "number" && doc.total >= 0 ? doc.total : null, pageSize: doc.pageSize, pageStart: doc.pageStart };
}

/** A bounded list read of a type. */
export const list = <Row extends Asset = Asset>(transport: Transport, type: string, params: ReadParams): Promise<ReadResult<Row>> =>
  read<Row>(transport, `/rest-1.v1/Data/${encodeURIComponent(type)}`, params, false);

/** One asset by OID. */
export async function get<Row extends Asset = Asset>(transport: Transport, oid: Oid, select?: string[]): Promise<Row> {
  const [type, id] = momentless(oid).split(":");
  const doc = await transport.request<AssetDocument>({ method: "GET", path: `/rest-1.v1/Data/${encodeURIComponent(type!)}/${encodeURIComponent(id!)}`, query: { sel: select?.join(",") }, responseType: "json" });
  return fromAssetDocument<Row>(doc);
}

/** A bounded history read: one row per moment, _oid carrying the moment. */
export const history = <Row extends Asset = Asset>(transport: Transport, target: string, params: ReadParams): Promise<ReadResult<Row>> => {
  const [type, id] = target.split(":");
  const path = id ? `/rest-1.v1/Hist/${encodeURIComponent(type!)}/${encodeURIComponent(id)}` : `/rest-1.v1/Hist/${encodeURIComponent(type!)}`;
  return read<Row>(transport, path, params, true);
};

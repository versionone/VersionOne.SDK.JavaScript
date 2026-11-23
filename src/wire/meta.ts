/**
 * The meta.v1 wire module: what the endpoint delivers, and the translation
 * into the metamodel types (src/types/metamodel.ts).
 *
 * meta.v1 describes the instance's schema. Three reads:
 *   GET /meta.v1                          the whole metamodel (large: ~7 MB, 165 types)
 *   GET /meta.v1/<Type>                   one asset type with its attributes
 *   GET /meta.v1/<Type>/<Attribute>       one attribute definition
 *
 * Every meta.v1 answer carries one strong ETag for the whole schema
 * ("26.3.1.13.636764259167912911": the release and a change stamp), the
 * same on the document, a type and an attribute, and If-None-Match with
 * that exact tag answers 304 with no body (live 2026-11-14; a weak form
 * is not matched). So "has the schema changed?" is one conditional read
 * of the smallest resource, and a cached metamodel needs re-parsing only
 * when the tag moves. Cache-Control is public with a max-age under an
 * hour.
 *
 * The delivered document is its own vocabulary — Token, DisplayName,
 * IsMultivalue, RelatedAsset, Base — and NOT the attribute set of the
 * metamodel's own AttributeDefinition asset type (NativeValue, IsBasic, …).
 * The hand-written types model the delivered document. References inside
 * it arrive as { href, tokenref } or { href, nameref }; the model keeps the
 * token. An attribute the type defines itself has no Base; an inherited one
 * names the defining ancestor's attribute.
 */
import { UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { AssetType, AssetTypeToken, AttributeDefinition, AttributeTokenRef, AttributeType, Metamodel } from "../types/metamodel";

// ---- what the endpoint delivers ------------------------------------------------

export interface TokenRef { href: string; tokenref: AttributeTokenRef }
export interface NameRef { href: string; nameref: AssetTypeToken }

export interface AttributeDefinitionDocument {
  HREF?: string;
  _type: "AttributeDefinition";
  Name: string;
  Token: AttributeTokenRef;
  DisplayName: string;
  AttributeType: AttributeType;
  IsReadOnly: boolean;
  IsRequired: boolean;
  IsMultivalue: boolean;
  IsCanned: boolean;
  IsCustom: boolean;
  /** Present on an inherited attribute: the defining ancestor's attribute. */
  Base?: TokenRef;
  ReciprocalRelation?: TokenRef;
  OrderByAttribute?: TokenRef;
  DisplayByAttribute?: TokenRef;
  /** Present on a Relation. */
  RelatedAsset?: NameRef;
}

export interface AssetTypeDocument {
  HREF?: string;
  Version?: string;
  _type: "AssetType";
  Token: AssetTypeToken;
  /** The delivered Name is a reference to the type's Name attribute; the token is the name. */
  Name: TokenRef | string;
  DisplayName: string;
  Abstract: boolean;
  /** Absent on a root type. */
  Base?: NameRef;
  DefaultOrderBy?: TokenRef;
  DefaultDisplayBy?: TokenRef;
  ShortName?: TokenRef;
  Description?: TokenRef;
  Attributes: Record<string, AttributeDefinitionDocument>;
  Operations?: Record<string, unknown>;
  Rules?: Record<string, unknown>;
}

export interface MetamodelDocument {
  HREF?: string;
  Version: string;
  AssetTypes: Record<string, AssetTypeDocument>;
}

// ---- translation ----------------------------------------------------------------

export function toAttributeDefinition(doc: AttributeDefinitionDocument): AttributeDefinition {
  return {
    _type: "AttributeDefinition",
    Name: doc.Name,
    Token: doc.Token,
    DisplayName: doc.DisplayName,
    AttributeType: doc.AttributeType,
    IsReadOnly: doc.IsReadOnly,
    IsRequired: doc.IsRequired,
    IsMultivalue: doc.IsMultivalue,
    IsCanned: doc.IsCanned,
    IsCustom: doc.IsCustom,
    ...(doc.Base ? { Base: doc.Base.tokenref } : {}),
    ...(doc.ReciprocalRelation ? { ReciprocalRelation: doc.ReciprocalRelation.tokenref } : {}),
    ...(doc.OrderByAttribute ? { OrderByAttribute: doc.OrderByAttribute.tokenref } : {}),
    ...(doc.DisplayByAttribute ? { DisplayByAttribute: doc.DisplayByAttribute.tokenref } : {}),
    ...(doc.RelatedAsset ? { RelatedAsset: doc.RelatedAsset.nameref } : {})
  };
}

export function toAssetType(doc: AssetTypeDocument): AssetType {
  return {
    _type: "AssetType",
    Name: doc.Token,
    Token: doc.Token,
    DisplayName: doc.DisplayName,
    Abstract: doc.Abstract,
    ...(doc.Base ? { Base: doc.Base.nameref } : {}),
    ...(doc.DefaultOrderBy ? { DefaultOrderBy: doc.DefaultOrderBy.tokenref } : {}),
    ...(doc.DefaultDisplayBy ? { DefaultDisplayBy: doc.DefaultDisplayBy.tokenref } : {}),
    ...(doc.ShortName ? { ShortName: doc.ShortName.tokenref } : {}),
    Attributes: Object.fromEntries(Object.entries(doc.Attributes ?? {}).map(([key, value]) => [key, toAttributeDefinition(value)])),
    ...(doc.Operations ? { Operations: Object.keys(doc.Operations).map((token) => token.slice(token.indexOf(".") + 1)) } : {})
  };
}

export function toMetamodel(doc: MetamodelDocument): Metamodel {
  return { Version: doc.Version, AssetTypes: Object.fromEntries(Object.entries(doc.AssetTypes).map(([key, value]) => [key, toAssetType(value)])) };
}

/** Is this a metamodel document as meta.v1 delivers it? (A downloaded metamodel.json, say.) */
export function isMetamodelDocument(value: unknown): value is MetamodelDocument {
  return !!value && typeof value === "object" && typeof (value as MetamodelDocument).Version === "string" && !!(value as MetamodelDocument).AssetTypes && typeof (value as MetamodelDocument).AssetTypes === "object";
}

// ---- the calls ------------------------------------------------------------------

/** A conditional read: the tag a previous answer carried. With it, an unchanged resource is null. */
export interface ConditionalOptions { ifNoneMatch?: string | null }

/** What a read answered, with the schema's tag as the server sent it (null when it sent none). */
export interface Tagged<T> { value: T; etag: string | null }

/** The smallest meta.v1 resource: what the schema's tag is read from. */
const PROBE_PATH = "/meta.v1/BaseAsset/Name";

async function conditional<Doc>(transport: Transport, path: string, options: ConditionalOptions): Promise<Tagged<Doc> | null> {
  let etag: string | null = null, status = 200;
  const onResponse = (r: { status: number; headers: { get(name: string): string | null } }) => { status = r.status; etag = r.headers.get("etag"); };
  const headers = options.ifNoneMatch ? { "if-none-match": options.ifNoneMatch } : undefined;
  const doc = await transport.request<Doc | undefined>({ method: "GET", path, headers, responseType: "json", onResponse, acceptNotModified: !!options.ifNoneMatch });
  if (status === 304 || doc === undefined) return null;
  return { value: doc, etag };
}

export async function getMetamodel(transport: Transport): Promise<Metamodel> {
  return toMetamodel(await transport.request<MetamodelDocument>({ method: "GET", path: "/meta.v1", responseType: "json" }));
}

/** The metamodel with its tag; null when `ifNoneMatch` still matches (nothing was downloaded). */
export async function readMetamodel(transport: Transport, options: ConditionalOptions = {}): Promise<Tagged<Metamodel> | null> {
  const read = await conditional<MetamodelDocument>(transport, "/meta.v1", options);
  return read && { value: toMetamodel(read.value), etag: read.etag };
}

export async function getAssetType(transport: Transport, token: AssetTypeToken): Promise<AssetType> {
  return toAssetType(await transport.request<AssetTypeDocument>({ method: "GET", path: `/meta.v1/${encodeURIComponent(token)}`, responseType: "json" }));
}

/** One type with the schema's tag; null when `ifNoneMatch` still matches. */
export async function readAssetType(transport: Transport, token: AssetTypeToken, options: ConditionalOptions = {}): Promise<Tagged<AssetType> | null> {
  const read = await conditional<AssetTypeDocument>(transport, `/meta.v1/${encodeURIComponent(token)}`, options);
  return read && { value: toAssetType(read.value), etag: read.etag };
}

/**
 * The schema's current tag, from one small read, or null when the server
 * sends none. With `ifNoneMatch`, "unchanged" is answered as that same tag
 * without a body — the cheapest way to ask whether anything in meta moved.
 */
export async function etag(transport: Transport, options: ConditionalOptions = {}): Promise<string | null> {
  const read = await conditional<unknown>(transport, PROBE_PATH, options);
  return read ? read.etag : options.ifNoneMatch ?? null;
}

export async function getAttributeDefinition(transport: Transport, tokenref: AttributeTokenRef): Promise<AttributeDefinition> {
  const [type, attribute] = tokenref.split(".");
  if (!type || !attribute) throw new UsageError(`"${tokenref}" is not an attribute token ("Story.Name")`);
  return toAttributeDefinition(await transport.request<AttributeDefinitionDocument>({ method: "GET", path: `/meta.v1/${encodeURIComponent(type)}/${encodeURIComponent(attribute)}`, responseType: "json" }));
}

/**
 * The meta.v1 wire module: what the endpoint delivers, and the translation
 * into the metamodel types (src/types/metamodel.ts).
 *
 * meta.v1 describes the instance's schema. Three reads:
 *   GET /meta.v1                          the whole metamodel (large: ~7 MB, 165 types)
 *   GET /meta.v1/<Type>                   one asset type with its attributes
 *   GET /meta.v1/<Type>/<Attribute>       one attribute definition
 *
 * The delivered document is its own vocabulary — Token, DisplayName,
 * IsMultivalue, RelatedAsset, Base — and NOT the attribute set of the
 * metamodel's own AttributeDefinition asset type (NativeValue, IsBasic, …).
 * The hand-written types model the delivered document. References inside
 * it arrive as { href, tokenref } or { href, nameref }; the model keeps the
 * token. An attribute the type defines itself has no Base; an inherited one
 * names the defining ancestor's attribute.
 */
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
    Attributes: Object.fromEntries(Object.entries(doc.Attributes ?? {}).map(([key, value]) => [key, toAttributeDefinition(value)]))
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

export async function getMetamodel(transport: Transport): Promise<Metamodel> {
  return toMetamodel(await transport.request<MetamodelDocument>({ method: "GET", path: "/meta.v1", responseType: "json" }));
}

export async function getAssetType(transport: Transport, token: AssetTypeToken): Promise<AssetType> {
  return toAssetType(await transport.request<AssetTypeDocument>({ method: "GET", path: `/meta.v1/${encodeURIComponent(token)}`, responseType: "json" }));
}

export async function getAttributeDefinition(transport: Transport, tokenref: AttributeTokenRef): Promise<AttributeDefinition> {
  const [type, attribute] = tokenref.split(".");
  if (!type || !attribute) throw new Error(`"${tokenref}" is not an attribute token ("Story.Name")`);
  return toAttributeDefinition(await transport.request<AttributeDefinitionDocument>({ method: "GET", path: `/meta.v1/${encodeURIComponent(type)}/${encodeURIComponent(attribute)}`, responseType: "json" }));
}

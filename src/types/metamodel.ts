export type AssetTypeToken = string;
export type AttributeToken = string;
export type AttributeTokenRef = `${AssetTypeToken}.${AttributeToken}`;
export type AttributeType =
    | "AssetType"
    | "Blob"
    | "Boolean"
    | "Date"
    | "Duration"
    | "Guid"
    | "LocalizerTag"
    | "LongInt"
    | "LongText"
    | "Numeric"
    | "Opaque"
    | "Password"
    | "Rank"
    | "Relation"
    | "State"
    | "Text";

export type NonRelationAttributeType =
    Exclude<AttributeType, "Relation">;

/**
 * An attribute definition as meta.v1 delivers it (the document's own
 * vocabulary, not the AttributeDefinition asset type's attribute set).
 * References are kept as tokens.
 */
export interface AttributeDefinition {
    _type: "AttributeDefinition";
    /** Present on an inherited attribute: the defining ancestor's attribute. Absent on an attribute the type defines itself. */
    Base?: AttributeTokenRef;
    Name: string;
    Token: AttributeTokenRef;
    DisplayName: string;
    AttributeType: AttributeType;
    IsReadOnly: boolean;
    IsRequired: boolean;
    IsMultivalue: boolean;
    IsCanned: boolean;
    IsCustom: boolean;
    ReciprocalRelation?: AttributeTokenRef;
    OrderByAttribute?: AttributeTokenRef;
    DisplayByAttribute?: AttributeTokenRef;
    RelatedAsset?: AssetTypeToken;
}

/** An asset type as meta.v1 delivers it. A root type has no Base. */
export interface AssetType {
    _type: "AssetType";
    Name: string;
    Token: AssetTypeToken;
    DisplayName: string;
    Abstract: boolean;
    /** The type this one extends; absent on a root type such as BaseAsset. */
    Base?: AssetTypeToken;
    DefaultOrderBy?: AttributeTokenRef;
    DefaultDisplayBy?: AttributeTokenRef;
    /** The attribute that carries the short name (Number on workitems). */
    ShortName?: AttributeTokenRef;
    Attributes: Record<AttributeToken, AttributeDefinition>;
}

export type AssetTypeMap = Record<AssetTypeToken, AssetType>;
export type AttributeDefinitionMap = Record<AttributeToken, AttributeDefinition>;

export interface Metamodel {
    Version: string;
    AssetTypes: AssetTypeMap;
}

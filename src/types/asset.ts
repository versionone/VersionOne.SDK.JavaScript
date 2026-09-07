/**
 * The hand-written roots the generated asset types build on. Everything
 * else under src/types/assets is generated from the metamodel.
 *
 * These are MODEL types: one shape, wherever an asset came from or is going.
 * A relation is a Ref here whether api/asset will write it as an OID string
 * or query.v1 read it back as { _oid }; the wire layer translates.
 */

/** An OID token, momentless: "Story:1234". */
export type Oid = string;

/** An ISO-8601 date-time as the API renders it, e.g. "2026-09-06T13:52:51.903". */
export type DateString = string;

/**
 * An AssetState as the model carries it: the names of Core's AssetState
 * enum (VersionOne/AssetState.cs: Future 0, Active 64, Closed 128, Dead 192,
 * OldBrokenDownStory 208, Deprecated 254, Deleted 255). rest-1 renders the
 * number and query.v1 the name; the wire layer normalises to the name.
 */
export type AssetStateValue = "Future" | "Active" | "Closed" | "Dead" | "OldBrokenDownStory" | "Deprecated" | "Deleted";

/** Core's AssetState codes, by name — the rest-1 rendering. */
export const ASSET_STATE_CODES: Record<AssetStateValue, number> = { Future: 0, Active: 64, Closed: 128, Dead: 192, OldBrokenDownStory: 208, Deprecated: 254, Deleted: 255 };

/**
 * A reference to another asset: always at least its OID, plus whatever a
 * select pulled through (Owners.Name lands on the Ref as Name).
 */
export type Ref<T extends Asset = Asset> = { _oid: Oid } & Partial<Omit<T, "_oid">>;

/** The value types an attribute can carry in the model. */
export type AttributeValue = string | number | boolean | null | Ref | Ref[];

/**
 * Custom attributes are not generated: they differ per instance and every one
 * of them is named with the Custom_ prefix, so the root carries them all.
 */
export interface CustomAttributes {
  [custom: `Custom_${string}`]: AttributeValue | undefined;
}

/** The root every generated asset type extends. */
export interface Asset extends CustomAttributes {
  _oid: Oid;
}

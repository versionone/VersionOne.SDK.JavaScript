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
 * An AssetState as the model carries it: the names of the server's AssetState
 * enum (Future 0, Active 64, Closed 128, Dead 192,
 * OldBrokenDownStory 208, Deprecated 254, Deleted 255). rest-1 renders the
 * number and query.v1 the name; the wire layer normalises to the name.
 */
export type AssetStateValue = "Future" | "Active" | "Closed" | "Dead" | "Template" | "OldBrokenDownStory" | "Deprecated" | "Deleted";

/** The server's AssetState codes, by name — the rest-1 rendering. */
export const ASSET_STATE_CODES: Record<AssetStateValue, number> = { Future: 0, Active: 64, Closed: 128, Dead: 192, Template: 200, OldBrokenDownStory: 208, Deprecated: 254, Deleted: 255 };

const STATE_OF_CODE: Record<number, AssetStateValue> = Object.fromEntries(Object.entries(ASSET_STATE_CODES).map(([name, code]) => [code, name as AssetStateValue]));

/**
 * An AssetState by name, whichever way the endpoint spelled it: api/asset
 * and query.v1 send the name ("Closed") for most states but the code for a
 * few ("200", a template), and rest-1 always sends the number. An unknown
 * code is left as sent.
 */
export function assetStateOf(value: unknown): AssetStateValue | string | null {
  if (value == null) return null;
  const code = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isNaN(code) ? String(value) : STATE_OF_CODE[code] ?? String(value);
}

/**
 * A reference to another asset: always its OID. It carries more only when
 * asked to: a sub-select (`{ from: "Owners", select: ["Name"] }`) puts
 * `Name` on each Ref. A dotted path selected by name (`"Owners.Name"`) is
 * not folded onto the Ref: it arrives under its own key, `row["Owners.Name"]`,
 * like everything a query selects.
 */
export type Ref<T extends Asset = Asset> = { _oid: Oid } & Partial<Omit<T, "_oid">> & { readonly [refTarget]?: T };

/**
 * Types only: the key under which a Ref remembers which asset type it
 * points at, so a sub-select can be typed by the related type. Nothing has
 * this property at run time, and a plain `{ _oid }` is still a Ref.
 */
export declare const refTarget: unique symbol;

/** The value types an attribute can carry in the model. */
export type AttributeValue = string | number | boolean | null | Ref | Ref[];

/**
 * Custom attributes are not generated: they differ per instance. One is
 * named with the Custom_ prefix; the reciprocal side of a custom relation,
 * which the server adds on the related type, with ReciprocalOf_ (live
 * 2026-11-12: `Custom_Demo_List.ReciprocalOf_Story_Custom_Demo_Single_List`).
 * The root carries both.
 */
export interface CustomAttributes {
  [custom: `Custom_${string}`]: AttributeValue | undefined;
  [reciprocal: `ReciprocalOf_${string}`]: AttributeValue | undefined;
}

/** The root every generated asset type extends. */
export interface Asset extends CustomAttributes {
  _oid: Oid;
}

/**
 * What an AssetState means for someone deciding what to do with the asset,
 * for the four states whose meaning is established against a server:
 *   "open"      Active
 *   "closed"    Closed
 *   "template"  code 200, which the server sends as "200" (it has no name
 *               for it; `Template` is this SDK's)
 *   "deleted"   Deleted
 * and "other" for every other state — Future, Dead (the server's word for
 * the whole range from 192 up, not a state rows are seen to carry),
 * OldBrokenDownStory (a story that was split: dead, not deleted),
 * Deprecated — and for a value it does not know. Null for no value. Takes
 * a name or a code, as assetStateOf does.
 */
export function assetStateKind(value: unknown): "open" | "closed" | "template" | "deleted" | "other" | null {
  switch (assetStateOf(value)) {
    case null: return null;
    case "Active": return "open";
    case "Closed": return "closed";
    case "Template": return "template";
    case "Deleted": return "deleted";
    default: return "other";
  }
}

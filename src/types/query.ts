/**
 * What the types can say about a query before it is sent. A `from` written
 * as a literal names an asset type the generated model knows; the `select`
 * then completes from that type's attributes, and the rows come back typed
 * by exactly what was selected — `row.Name` is a string, `row.Nmae` is a
 * compile error, and a path the model cannot follow (`Status.Name`) is
 * `unknown` rather than a guess.
 *
 * None of this closes a door: `from` also takes an OID token, an alias, or
 * a type this build does not know; `select` takes any path; and a query
 * built from variables (a `string[]` select) types its rows as `Asset` with
 * unknown keys, as before. The model is one product version's metamodel;
 * an instance may know more, and the types say "unknown", never "no".
 */
import type { Asset } from "./asset";
import type { AssetTypeMap, AssetTypeName, ConcreteAssetTypeName } from "./assets/index";
import type { List } from "./assets/List";

/**
 * An instance's own list type: the one kind of custom asset type Agility
 * allows, a subtype of List spelled `Custom_<Name>` (Base List; seven on
 * the API-testing instance, live 2026-11-12). It has List's attributes
 * (Name, Order, Inactive, ColorName, SelectedInSchemes, …) and its own
 * token as AssetType; a custom relation attribute points at it.
 */
export type CustomList<F extends string = `Custom_${string}`> = Omit<List, "AssetType"> & { readonly AssetType: F };

/** A query's `from`: an asset type token (completed), or anything else the server accepts — an OID token, an alias ("@story"), a type the model lacks. */
export type From = AssetTypeName | (string & {});

/** A create's `AssetType`: a concrete type token (completed), or one the model lacks. */
export type CreateType = ConcreteAssetTypeName | (string & {});

/** The model type of what a `from` reads: the type itself, a custom list type, the type of an OID token, or Asset when the model cannot tell. */
export type TypeOf<F extends string> =
  F extends `${infer T}:${string}` ? TypeOf<T> // an OID token first: a type token never holds a colon
  : F extends keyof AssetTypeMap ? AssetTypeMap[F]
  : F extends `Custom_${string}` ? CustomList<F>
  : Asset;

/**
 * A select path on rows of T: an attribute of T (completed), a path through
 * one (`Status.Name`, `Owners.@Count`, `Children:Task`, `Owners[…]`), or any
 * other path the server may know.
 */
export type SelectPath<T> =
  | (keyof T & string)
  | `${keyof T & string}.${string}`
  | `${keyof T & string}:${string}`
  | `${keyof T & string}[${string}`
  | (string & {});

/** The key a select entry puts on the row: the path itself, or a sub-select's `from`. */
export type SelectKey<E> = E extends string ? E : E extends { from: infer F extends string } ? F : never;

/** The value a selected key carries on rows of T: the attribute's type when the key is one, a number for an aggregate, unknown for a path the model cannot follow. */
export type SelectValue<T, K> = K extends keyof T ? T[K] : K extends `${string}.@${string}` ? number : unknown;

/** Rows of T with exactly the entries of S selected (plus `_oid`, always sent). */
export type Selected<T, S> = S extends readonly (infer E)[] ? Asset & { [K in SelectKey<E>]: SelectValue<T, K> } : Asset;

/** The row type of a query body: what its `from` reads, narrowed to its `select`; just `_oid` when nothing is selected. */
export type RowOf<Q> = Q extends { from: infer F extends string; select: infer S } ? Selected<TypeOf<F>, S> : Asset;

/** The row types of a list of query bodies, in order. */
export type RowsOf<Qs extends readonly unknown[]> = { -readonly [I in keyof Qs]: RowOf<Qs[I]>[] };

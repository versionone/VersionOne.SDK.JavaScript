/**
 * The lists service: which values a list-typed attribute (Status,
 * Priority, Source, Category, a custom dropdown) may take for an asset,
 * or for one about to be created in a scope, and the one value a name
 * means there. Over api/ValidValues (wire/validValues), which applies the
 * scope's scheme and the team's process; what it answers is in that
 * module's header.
 *
 * ONLY RELATIONS TO A LIST TYPE. The endpoint takes no page and no
 * filter, and answers for any attribute: asked for a relation to members
 * or iterations it returns every one in the scope, unbounded. A list type
 * (one that descends from List) is short by nature, so that is all this
 * service asks for; anything else is a UsageError naming the read to use
 * instead. No read in this SDK is unbounded (spec 000 section 6).
 *
 * There is no fallback. On an instance without the endpoint the call
 * fails as the server's 404; it does not quietly offer every value of the
 * list type, which is a different answer.
 */
import { ApiError, UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless } from "../types/oid";
import * as validValues from "../wire/validValues";
import type { Schema } from "./schema";

/** Where the values are asked for: an existing asset (its own scope and team apply), or a type in a scope for one not created yet. */
export type ListTarget =
  | { asset: Oid; /** Answer as if the asset were on this team. */ team?: Oid }
  | { type: AssetTypeToken; scope: Oid; /** The team the new asset will be on. */ team?: Oid };

/** A valid value: the list entry's identity and name, and whatever else was selected. Values are as rest-1 sends them. */
export type ListValue = Asset & { Name: string } & Record<string, unknown>;

export type ValuesInput = ListTarget & {
  /** List-typed attributes of the asset's type, by bare name. One request each, sent one after another. */
  attributes: readonly string[];
  /** More attributes of each value (`Order`, `RollupState`). `Name` is always returned. Not a date, and not a path through a relation. */
  select?: readonly string[];
};

export type ValueInput = ListTarget & {
  attribute: string;
  /** The value's Name as a person would type it, or its OID. */
  name: string;
  /**
   * "exact" (the default): the whole Name, ignoring case and surrounding
   * space. "prefix": also a Name of which the text begins a word ("prog"
   * finds "In Progress"), used only when no Name matches exactly; more
   * than one such Name is AMBIGUOUS_VALUE, never a silent choice.
   */
  match?: "exact" | "prefix";
  select?: readonly string[];
};

const typeOf = (target: ListTarget): AssetTypeToken => ("asset" in target ? momentless(target.asset).split(":")[0]! : target.type);

/** Does `type` descend from List (or is it List)? By the schema, loading ancestors as needed. */
async function isListType(schema: Schema, type: AssetTypeToken): Promise<boolean> {
  const seen = new Set<AssetTypeToken>();
  for (let t: AssetTypeToken | undefined = type; t && !seen.has(t); ) {
    if (t === "List") return true;
    seen.add(t);
    t = (await schema.load(t))?.Base;
  }
  return false;
}

/**
 * The list type an attribute points to, or null when it is not a relation
 * to a list type; undefined when the type has no such attribute.
 */
export async function listTypeOf(schema: Schema, type: AssetTypeToken, attribute: string): Promise<AssetTypeToken | null | undefined> {
  if (!(await schema.load(type))) return undefined;
  const definition = schema.attribute(type, attribute);
  if (!definition) return undefined;
  if (definition.AttributeType !== "Relation" || !definition.RelatedAsset) return null;
  return (await isListType(schema, definition.RelatedAsset)) ? definition.RelatedAsset : null;
}

/** The list type of each attribute, each checked before anything is sent. */
async function checked(schema: Schema, target: ListTarget, attributes: readonly string[], select: readonly string[] | undefined, what: string): Promise<void> {
  const type = typeOf(target);
  if ("asset" in target ? !/^[A-Za-z]\w*:\d+(:\d+)?$/.test(target.asset) : !target.type || !target.scope) throw new UsageError(`${what}: give an asset's OID, or a type and a scope`);
  if (!attributes.length) throw new UsageError(`${what}: no attribute named`);
  for (const attribute of attributes) {
    const listType = await listTypeOf(schema, type, attribute);
    if (listType === undefined) throw new UsageError(`${what}: ${type} has no attribute ${attribute}`);
    if (listType === null) {
      const related = schema.attribute(type, attribute)?.RelatedAsset;
      throw new UsageError(related
        ? `${what}: ${type}.${attribute} points to ${related}, which is not a list type. The server's valid-values endpoint cannot be paged or filtered and would return every ${related} in the scope. Read them with client.query({ from: "${related}", filter, page }) instead`
        : `${what}: ${type}.${attribute} is not a relation, so it has no list of valid values`);
    }
    for (const path of select ?? []) {
      if (path.includes(".")) throw new UsageError(`${what}: select takes attributes of the value itself, not a path (${path})`);
      await schema.load(listType);
      const selected = schema.attribute(listType, path);
      if (!selected) throw new UsageError(`${what}: ${listType} has no attribute ${path}`);
      if (selected.AttributeType === "Date") throw new UsageError(`${what}: ${listType}.${path} is a date, which this endpoint writes in the server's culture format, not ISO. Read it with client.query`);
    }
  }
}

const paramsOf = (target: ListTarget, select: readonly string[] | undefined): validValues.ValidValuesParams => ({ select: ["Name", ...(select ?? []).filter((s) => s !== "Name")], sort: ["Order"], team: target.team });

const read = (transport: Transport, target: ListTarget, attribute: string, select: readonly string[] | undefined): Promise<ListValue[]> =>
  "asset" in target
    ? validValues.forAsset<ListValue>(transport, target.asset, attribute, paramsOf(target, select))
    : validValues.forNew<ListValue>(transport, target.type, attribute, target.scope, paramsOf(target, select));

/**
 * The values each attribute may take there, in the list's own order: a map
 * from attribute name to rows `{ _oid, Name, …selected }`. An attribute
 * with no valid value there maps to `[]` (the scope's scheme selects none,
 * which is a real answer). One request per attribute, one after another.
 */
export async function values(transport: Transport, schema: Schema, input: ValuesInput): Promise<Record<string, ListValue[]>> {
  await checked(schema, input, input.attributes, input.select, "lists.values");
  const out: Record<string, ListValue[]> = {};
  for (const attribute of input.attributes) out[attribute] = await read(transport, input, attribute, input.select);
  return out;
}

const fold = (text: string): string => text.trim().toLocaleLowerCase();
const named = (rows: readonly ListValue[]): string => rows.map((r) => r.Name).join(", ");

/**
 * The one valid value a name means there. `name` may be an OID, which is
 * then checked to be among the valid values. No such value is an ApiError
 * coded NO_SUCH_VALUE; more than one is AMBIGUOUS_VALUE. Both carry
 * `details: { attribute, name, values }`, the candidates as rows (all the
 * valid values, or the ones that matched), so a caller can offer them.
 *
 * This is the check to make before writing a name a person gave. On a
 * write the server enforces a team's process (a status outside it is the
 * command failure `Violation'PrimaryWorkitemCannotHaveInvalidStatus`) and
 * does not enforce a scheme's selection (a status the scope's scheme does
 * not select is accepted, with no violation).
 */
export async function value(transport: Transport, schema: Schema, input: ValueInput): Promise<ListValue> {
  await checked(schema, input, [input.attribute], input.select, "lists.value");
  if (typeof input.name !== "string" || !input.name.trim()) throw new UsageError("lists.value: no name given");
  const all = await read(transport, input, input.attribute, input.select);
  const wanted = fold(input.name);
  const isOid = /^[A-Za-z]\w*:\d+(:\d+)?$/.test(input.name.trim());
  let found = isOid ? all.filter((r) => r._oid === momentless(input.name.trim() as Oid)) : all.filter((r) => fold(String(r.Name)) === wanted);
  if (!found.length && !isOid && input.match === "prefix") found = all.filter((r) => fold(String(r.Name)).split(/\s+/).some((word, i, words) => words.slice(i).join(" ").startsWith(wanted)));
  if (found.length === 1) return found[0]!;
  const type = typeOf(input);
  if (!found.length) {
    throw new ApiError(`${type}.${input.attribute} has no value "${input.name.trim()}" here. ${all.length ? `It can be: ${named(all)}.` : "No value is valid here."}`, 0, "NO_SUCH_VALUE", { attribute: input.attribute, name: input.name, values: all });
  }
  throw new ApiError(`${type}.${input.attribute}: "${input.name.trim()}" matches more than one value here: ${named(found)}.`, 0, "AMBIGUOUS_VALUE", { attribute: input.attribute, name: input.name, values: found });
}

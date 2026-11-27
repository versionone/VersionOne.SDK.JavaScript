/**
 * The lists service: which values a list-typed attribute (Status,
 * Priority, Source, Category, a custom dropdown) may take for an asset,
 * or for one about to be created in a scope, and the one value a name
 * means there. Over api/ValidValues (wire/validValues), which applies the
 * team's own values and the asset type's rule for its lists (for work
 * items, the scope's scheme); what it answers is in that module's header.
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
 *
 * Values are translated by the schema like any other row: the endpoint
 * sends every value as a string, and a number, a Boolean and a relation
 * come out as they do from `client.query` (spec 000 section 2). A date
 * cannot be: the endpoint writes it in the server's culture format.
 */
import { ApiError, UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless } from "../types/oid";
import { scalar } from "../wire/assetApi";
import * as validValues from "../wire/validValues";
import type { Schema } from "./schema";

/**
 * Where the values are asked for: an existing asset (its own scope and team
 * apply), or a type in a scope for one not created yet.
 */
export type ListTarget =
  | {
      asset: Oid;
      /** Answer as if the asset were on this team; `null` as if on no team (the asset's own team's values are then not considered). */
      team?: Oid | null;
    }
  | {
      type: AssetTypeToken;
      scope: Oid;
      /** The team the new asset will be on. */
      team?: Oid;
      /**
       * More of the asset to be, for a type whose rule for its lists
       * needs it: `{ RegressionPlan: "RegressionPlan:7" }` for a
       * RegressionSuite. An attribute name to an OID or a plain value.
       */
      context?: Readonly<Record<string, string>>;
    };

/**
 * A valid value: the list entry's identity and name, and whatever else was
 * selected, translated as on any read (a number is a number, a relation a
 * Ref or null).
 */
export type ListValue = Asset & { Name: string } & Record<string, unknown>;

export type ValuesInput = ListTarget & {
  /** List-typed attributes of the asset's type, by bare name. One request each, sent together. */
  attributes: readonly string[];
  /**
   * More attributes of each value (`Order`, `RollupState`). `Name` is
   * always returned. Not a date, not a multi-value relation and not a path
   * through a relation.
   */
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

/**
 * Is `type` a list type? Told from its own definition, with no walk up to
 * its ancestors: a type that descends from List has attributes it
 * inherited from List (`Name`, `Order`, …), and each inherited attribute
 * names the ancestor that defines it. That holds for every list type in
 * the product's metamodel, the statuses two levels below List and an
 * instance's custom dropdowns included, and for no other type. A type
 * that cannot be loaded is an error of its own, not "not a list".
 */
async function isListType(schema: Schema, type: AssetTypeToken): Promise<boolean> {
  if (type === "List") return true;
  const loaded = await schema.load(type);
  if (!loaded) throw new ApiError(`could not load the asset type ${type} to tell whether it is a list type`, 404, "NOT_FOUND", { type });
  return Object.values(loaded.Attributes).some((definition) => typeof definition.Base === "string" && definition.Base.startsWith("List."));
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

/**
 * Types whose rule for their lists needs more than a scope, and what it
 * needs. Asked for a new asset without it, the server answers no values
 * and no error, which would read as "nothing is valid here". (The product
 * gives a regression suite no list attribute of its own; this matters for
 * a custom dropdown added to one.)
 */
const NEEDS: Readonly<Record<AssetTypeToken, string>> = { RegressionSuite: "RegressionPlan" };

/** Everything checked before anything is sent: the target, each attribute's list type, what may be selected. Answers each attribute's list type. */
async function checked(schema: Schema, target: ListTarget, attributes: readonly string[], select: readonly string[] | undefined, what: string): Promise<Map<string, AssetTypeToken>> {
  const type = typeOf(target);
  if ("asset" in target ? !/^[A-Za-z]\w*:\d+(:\d+)?$/.test(target.asset) : !target.type || !target.scope) throw new UsageError(`${what}: give an asset's OID, or a type and a scope`);
  if (!attributes.length) throw new UsageError(`${what}: no attribute named`);
  const needed = NEEDS[type];
  if (!("asset" in target) && needed && !target.context?.[needed]) {
    throw new UsageError(`${what}: the valid values of a new ${type} depend on its ${needed}. Give it as context: { ${needed}: "<oid>" }; without it the server answers no values and no error`);
  }
  // The type loads go out together, as for any read; the checks then run in the order the attributes were named.
  const listTypes = await Promise.all(attributes.map((attribute) => listTypeOf(schema, type, attribute)));
  const out = new Map<string, AssetTypeToken>();
  for (const [i, attribute] of attributes.entries()) {
    const listType = listTypes[i];
    if (listType === undefined) throw new UsageError(`${what}: ${type} has no attribute ${attribute}`);
    if (listType === null) {
      const related = schema.attribute(type, attribute)?.RelatedAsset;
      throw new UsageError(related
        ? `${what}: ${type}.${attribute} points to ${related}, which is not a list type. The server's valid-values endpoint cannot be paged or filtered and would return every ${related} in the scope. Read them with client.query({ from: "${related}", filter, page }) instead`
        : `${what}: ${type}.${attribute} is not a relation, so it has no list of valid values`);
    }
    if (select?.length) await schema.load(listType);
    for (const path of select ?? []) {
      if (path.includes(".")) throw new UsageError(`${what}: select takes attributes of the value itself, not a path (${path})`);
      const selected = schema.attribute(listType, path);
      if (!selected) throw new UsageError(`${what}: ${listType} has no attribute ${path}`);
      if (selected.AttributeType === "Date") throw new UsageError(`${what}: ${listType}.${path} is a date, which this endpoint writes in the server's culture format, not ISO. Read it with client.query`);
      if (selected.AttributeType === "Relation" && selected.IsMultivalue) throw new UsageError(`${what}: ${listType}.${path} is a multi-value relation, which this endpoint does not return in a form that can be read. Read it with client.query`);
    }
    out.set(attribute, listType);
  }
  return out;
}

/** A row as the endpoint sent it (every value a string) in the model's shape, by the list type's schema. */
function translated(row: ListValue, schema: Schema, listType: AssetTypeToken): ListValue {
  const out: Record<string, unknown> = { _oid: row._oid };
  for (const [key, value] of Object.entries(row)) {
    if (key === "_oid") continue;
    const definition = schema.attribute(listType, key);
    if (definition?.AttributeType === "Relation") out[key] = typeof value === "string" && value && value !== "NULL" ? { _oid: momentless(value as Oid) } : null;
    else out[key] = definition ? scalar(value, definition.AttributeType) : value;
  }
  return out as ListValue;
}

const paramsOf = (target: ListTarget, select: readonly string[] | undefined): validValues.ValidValuesParams => ({ select: ["Name", ...(select ?? []).filter((s) => s !== "Name")], sort: "Order", team: target.team, ...("asset" in target ? {} : { context: target.context }) });

async function read(transport: Transport, schema: Schema, target: ListTarget, attribute: string, listType: AssetTypeToken, select: readonly string[] | undefined): Promise<ListValue[]> {
  const rows = "asset" in target
    ? await validValues.forAsset<ListValue>(transport, target.asset, attribute, paramsOf(target, select))
    : await validValues.forNew<ListValue>(transport, target.type, attribute, target.scope, paramsOf(target, select));
  return rows.map((row) => translated(row, schema, listType));
}

/**
 * The values each attribute may take there, in the list's own order: a map
 * from attribute name to rows `{ _oid, Name, …selected }`. An attribute
 * with no valid value there maps to `[]` (the scope's scheme selects none,
 * which is a real answer). One request per attribute, sent together.
 */
export async function values(transport: Transport, schema: Schema, input: ValuesInput): Promise<Record<string, ListValue[]>> {
  const listTypes = await checked(schema, input, input.attributes, input.select, "lists.values");
  const answers = await Promise.all(input.attributes.map((attribute) => read(transport, schema, input, attribute, listTypes.get(attribute)!, input.select)));
  return Object.fromEntries(input.attributes.map((attribute, i) => [attribute, answers[i]!]));
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
 * write the server checks one thing, the Status of a story or defect
 * against its team (a team's status on a work item not on that team, or
 * a status no team owns on a work item whose team has its own, is the
 * command failure `Violation'PrimaryWorkitemCannotHaveInvalidStatus`).
 * A status the scope's scheme does not select, an inactive one, and any
 * other list value from anywhere are accepted. The team's own values are
 * offered only on an instance that has team workspaces enabled.
 */
export async function value(transport: Transport, schema: Schema, input: ValueInput): Promise<ListValue> {
  const listTypes = await checked(schema, input, [input.attribute], input.select, "lists.value");
  if (typeof input.name !== "string" || !input.name.trim()) throw new UsageError("lists.value: no name given");
  const all = await read(transport, schema, input, input.attribute, listTypes.get(input.attribute)!, input.select);
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

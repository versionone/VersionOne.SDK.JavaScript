/**
 * The valid-values query service: for a relation that is NOT to a list
 * type (Owners, Team, Timebox, Super, Parent, a custom relation), the
 * query whose rows are the assets it may point to. The caller adds a
 * select, a `find` and a page, and reads it like any other query.
 *
 * Why not ask api/ValidValues, as `client.lists` does: that endpoint takes
 * no page and no filter, and for a relation to members or work items it
 * answers every one. What it evaluates for such a relation is a filter
 * kept in the metamodel, and the metamodel's own asset types can be read
 * like any other:
 *   RelationDefinition  Name, Asset (the type that defines the relation),
 *                       ValidValuesFilter, NewValidValuesFilter; and for
 *                       the relation's other end ReverseName,
 *                       RelatedAssetType, ReverseValidValuesFilter,
 *                       ReverseNewValidValuesFilter.
 *   Override            Name, Asset, ValidValuesFilter: a type's own rule
 *                       for a relation it inherits (a Task's Owners, a
 *                       PrimaryWorkitem's Parent).
 * Which filter applies to an attribute of a type:
 *   - the filter of the relation's definition, found on the type or the
 *     ancestor that defines the attribute;
 *   - replaced by an Override's filter on the type or its nearest
 *     ancestor that has one;
 *   - for an asset that does not exist yet, the definition's "new" filter
 *     when it has one, whatever any Override says (an Override has no
 *     "new" form).
 * A relation with no filter may point to any asset of the related type.
 *
 * The filter's own spelling:
 *   term|term|…            every term must hold
 *   Type.path,op,value,…   `path` on the related asset (the leading type
 *                          is only a label); several values mean any of
 *                          them
 *   $Name                  a value: that attribute of the asset the
 *                          relation belongs to (`$Scope`, `$Parent`)
 *   $                      a value: that asset itself
 * This service turns each term into a query filter term with its values
 * in a `with` variable, reading `$Name` from the asset, or from the scope
 * and context given for one not created yet.
 *
 * NOT FOR LIST TYPES. For a Status or a Priority the server first offers
 * a team's own values, which no filter expresses: that is `client.lists`.
 *
 * Proved against api/ValidValues on the API-testing instance
 * (test/integration/validValuesQuery.test.ts compares the two, relation by
 * relation). Where they can differ: when the asset has no value for a
 * `$Name` the endpoint answers no assets and no error; this service says
 * what is missing instead.
 */
import { ApiError, UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless } from "../types/oid";
import * as assetApi from "../wire/assetApi";
import { isListType } from "./lists";
import type { Schema } from "./schema";

/** Whose relation: an existing asset, or a type in a scope for one not created yet. */
export type RelationTarget =
  | { asset: Oid }
  | {
      type: AssetTypeToken;
      scope: Oid;
      /** More of the asset to be, for a rule that needs it: `{ Parent: "Story:7" }` for a new Task's Owners. An attribute name to an OID (or several) or a plain value. */
      context?: Readonly<Record<string, string | readonly string[]>>;
    };

export type ValidValuesQueryInput = RelationTarget & {
  /** A relation of the asset's type that is not to a list type, by bare name. */
  attribute: string;
};

/**
 * The start of a query for the assets a relation may point to, and
 * nothing but query keys. Spread it into a query and add what to select,
 * a `find` and a page:
 * `client.queryPage({ ...q, select: ["Name"], page: { size: 25, start: 0 } })`.
 */
export interface ValidValuesQuery {
  /** The related asset type. */
  from: AssetTypeToken;
  /** One term per term of the rule; empty when the relation may point to any asset of the type. */
  filter: string[];
  /** The values the terms refer to. Variable names begin `$valid`. */
  with: Record<string, string | string[]>;
}

interface Term { path: string; op: string; values: string[] }

/** A rule as the metamodel spells it, as terms. A term this cannot read is an error, not a term left out: leaving one out would widen the answer. */
export function termsOf(rule: string): Term[] {
  return rule.split("|").filter((t) => t.trim()).map((text) => {
    const [head, op, ...values] = text.split(",").map((p) => p.trim());
    const dot = head?.indexOf(".") ?? -1;
    if (!head || dot < 1 || dot === head.length - 1 || !op || !/^(=|!=|<|<=|>|>=)$/.test(op) || !values.length || values.some((v) => !v)) {
      throw new ApiError(`a valid-values rule this SDK cannot read: "${text}" (of "${rule}")`, 0, "BAD_RESPONSE", { rule });
    }
    return { path: head.slice(dot + 1), op, values };
  });
}

type DefinitionRow = { _oid: Oid; "Asset.Name"?: string | null; "RelatedAssetType.Name"?: string | null; ValidValuesFilter?: string | null; NewValidValuesFilter?: string | null; ReverseValidValuesFilter?: string | null; ReverseNewValidValuesFilter?: string | null };

/** The ancestors of a type, itself first. */
async function lineage(schema: Schema, type: AssetTypeToken): Promise<AssetTypeToken[]> {
  const out: AssetTypeToken[] = [];
  for (let t: AssetTypeToken | undefined = type; t && !out.includes(t); ) {
    out.push(t);
    t = (await schema.load(t))?.Base;
  }
  return out;
}

// The rules are metamodel: read once per relation and kept beside the types they belong to, for as long as the metamodel's tag stands.
const kept = new WeakMap<object, { etag: string | null; rules: Map<string, Promise<{ existing: string | null; fresh: string | null }>> }>();

/** The rule for `type.attribute`, for an existing asset and for a new one, by the three steps in this module's header. One request. */
async function readRule(transport: Transport, types: readonly AssetTypeToken[], attribute: string): Promise<{ existing: string | null; fresh: string | null }> {
  const page = { size: types.length + 1, start: 0 };
  const from = { $name: attribute, $types: [...types] };
  const [defined, reversed, overrides] = await assetApi.queries<DefinitionRow>(transport, [
    { from: "RelationDefinition", select: ["Asset.Name", "ValidValuesFilter", "NewValidValuesFilter"], filter: ["Name=$name", "Asset.Name=$types"], with: from, page },
    { from: "RelationDefinition", select: ["RelatedAssetType.Name", "ReverseValidValuesFilter", "ReverseNewValidValuesFilter"], filter: ["ReverseName=$name", "RelatedAssetType.Name=$types"], with: from, page },
    { from: "Override", select: ["Asset.Name", "ValidValuesFilter"], filter: ["Name=$name", "Asset.Name=$types"], with: from, page }
  ]);
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
  // The definition nearest the type, from whichever end of the relation the attribute is.
  const ends = [
    ...(defined ?? []).map((r) => ({ at: types.indexOf(r["Asset.Name"] ?? ""), existing: text(r.ValidValuesFilter), fresh: text(r.NewValidValuesFilter) })),
    ...(reversed ?? []).map((r) => ({ at: types.indexOf(r["RelatedAssetType.Name"] ?? ""), existing: text(r.ReverseValidValuesFilter), fresh: text(r.ReverseNewValidValuesFilter) }))
  ].filter((e) => e.at >= 0).sort((a, b) => a.at - b.at);
  const definition = ends[0] ?? { existing: null, fresh: null };
  const override = (overrides ?? []).map((r) => ({ at: types.indexOf(r["Asset.Name"] ?? ""), filter: text(r.ValidValuesFilter) })).filter((o) => o.at >= 0 && o.filter).sort((a, b) => a.at - b.at)[0];
  const existing = override?.filter ?? definition.existing;
  return { existing, fresh: definition.fresh ?? existing };
}

function ruleOf(transport: Transport, schema: Schema, types: readonly AssetTypeToken[], attribute: string): Promise<{ existing: string | null; fresh: string | null }> {
  let held = kept.get(schema.cache);
  if (!held || held.etag !== schema.cache.etag) kept.set(schema.cache, (held = { etag: schema.cache.etag, rules: new Map() }));
  const key = `${types[0]}.${attribute}`;
  let rule = held.rules.get(key);
  if (!rule) {
    rule = readRule(transport, types, attribute);
    held.rules.set(key, rule);
    rule.catch(() => held!.rules.delete(key));
  }
  return rule;
}

/** A value read from the asset, as the strings a `with` variable takes; [] when the asset has none. */
function strings(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object") return "_oid" in value ? [momentless((value as { _oid: Oid })._oid)] : [];
  return [String(value)];
}

/** The query for the assets `attribute` may point to, for the asset or for one not created yet. Nothing is read but metamodel and, for an asset, the attributes its rule names. */
export async function queryFor(transport: Transport, schema: Schema, input: ValidValuesQueryInput): Promise<ValidValuesQuery> {
  const what = "validValues.query";
  const existing = "asset" in input;
  if (existing ? !/^[A-Za-z]\w*:\d+(:\d+)?$/.test(input.asset) : !input.type || !input.scope) throw new UsageError(`${what}: give an asset's OID, or a type and a scope`);
  if (!input.attribute) throw new UsageError(`${what}: no attribute named`);
  const type = existing ? momentless(input.asset).split(":")[0]! : input.type;
  if (!(await schema.load(type))) throw new UsageError(`${what}: there is no asset type ${type}`);
  const definition = schema.attribute(type, input.attribute);
  if (!definition) throw new UsageError(`${what}: ${type} has no attribute ${input.attribute}`);
  if (definition.AttributeType !== "Relation" || !definition.RelatedAsset) throw new UsageError(`${what}: ${type}.${input.attribute} is not a relation, so there are no assets it may point to`);
  const related = definition.RelatedAsset;
  if (await isListType(schema, related)) throw new UsageError(`${what}: ${type}.${input.attribute} points to the list type ${related}. Its values depend on the team as well as the scope, which no filter says: ask client.lists.values`);
  const rules = await ruleOf(transport, schema, await lineage(schema, type), input.attribute);
  const rule = existing ? rules.existing : rules.fresh;
  if (!rule) return { from: related, filter: [], with: {} };
  const terms = termsOf(rule);

  // What the rule asks of the asset: `$Name` is an attribute of it, a bare `$` the asset itself.
  const names = [...new Set(terms.flatMap((t) => t.values).filter((v) => v.startsWith("$") && v.length > 1).map((v) => v.slice(1)))];
  for (const name of names) if (!schema.attribute(type, name)) throw new ApiError(`the valid-values rule of ${type}.${input.attribute} names ${type}.${name}, which the type does not have ("${rule}")`, 0, "BAD_RESPONSE", { rule });
  const have = new Map<string, string[]>();
  if (existing) {
    const oid = momentless(input.asset);
    have.set("", [oid]);
    if (names.length) {
      const read = { from: oid, select: names, page: { size: 1, start: 0 } };
      await schema.ensureFor([read]);
      const [row] = await assetApi.query(transport, read, { lookup: schema });
      if (!row) throw new ApiError(`${oid} does not exist, or this member may not see it`, 404, "NOT_FOUND", { oid });
      for (const name of names) have.set(name, strings((row as unknown as Record<string, unknown>)[name]));
    }
  } else {
    // A new asset has no identity yet: the server compares with the null OID, and so does this.
    have.set("", ["NULL"]);
    for (const name of names) have.set(name, name === "Scope" ? [momentless(input.scope)] : strings(input.context?.[name]).map((v) => (/^[A-Za-z]\w*:\d+:\d+$/.test(v) ? momentless(v as Oid) : v)));
  }
  const filter: string[] = [];
  const variables: Record<string, string | string[]> = {};
  for (const [i, term] of terms.entries()) {
    const values = term.values.flatMap((v) => {
      if (!v.startsWith("$")) return [v];
      const found = have.get(v.slice(1)) ?? [];
      if (!found.length) {
        throw new UsageError(existing
          ? `${what}: which assets ${type}.${input.attribute} may point to depends on the asset's ${v.slice(1)}, and ${momentless(input.asset)} has none`
          : `${what}: which assets a new ${type}'s ${input.attribute} may point to depends on its ${v.slice(1)}. Give it as context: { ${v.slice(1)}: "<oid>" }`);
      }
      return found;
    });
    const name = `$valid${i}`;
    filter.push(`${term.path}${term.op}${name}`);
    variables[name] = values.length === 1 ? values[0]! : values;
  }
  return { from: related, filter, with: variables };
}

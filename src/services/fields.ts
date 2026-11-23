/**
 * The fields service: what a form for an asset type in a scope needs to
 * know, from three sources the API keeps apart —
 *   - meta.v1 (through the schema): which attributes are REQUIRED to
 *     create one (IsRequired and writable: Name and Scope on a Story);
 *   - api/visibleFields: which attributes the product SHOWS for the type
 *     in that scope, custom fields included once configured;
 *   - the scope's Scheme: its IMPORTANT fields (Scheme.ImportantFields, a
 *     list of attribute tokens) and whether they are enforced at close
 *     (Scheme.IsRequiredAtClose).
 * One call, one answer, every list spelled as bare attribute names.
 */
import type { Transport } from "../core/transport";
import type { Asset, Oid, Ref } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless } from "../types/oid";
import * as assetApi from "../wire/assetApi";
import * as fields from "../wire/fields";
import type { Schema } from "./schema";

export interface FieldsOf {
  type: AssetTypeToken;
  scope: Oid;
  /** The scope's Scheme; null when the scope has none. */
  scheme: Oid | null;
  /** Attributes the server requires on a create (meta: IsRequired, writable). */
  required: string[];
  /** Attributes the product shows for the type in this scope (api/visibleFields). */
  visible: string[];
  /** The scheme's important fields that belong to this type (or an ancestor); [] when the scheme names none. */
  important: string[];
  /** Whether the scheme enforces its important fields when an asset is closed. */
  requiredAtClose: boolean;
}

type SchemeRow = Asset & { Scheme?: (Ref & { ImportantFields?: unknown; IsRequiredAtClose?: unknown }) | null };

/** The ancestors of a type, itself first, from the loaded schema. */
async function lineage(schema: Schema, type: AssetTypeToken): Promise<AssetTypeToken[]> {
  const out: AssetTypeToken[] = [];
  for (let t: AssetTypeToken | undefined = type; t && !out.includes(t); ) {
    out.push(t);
    const def = await schema.load(t);
    t = def?.Base;
  }
  return out;
}

/**
 * An important-field token as the scheme spells it ("Story.Owners", or a
 * bare "Owners") reduced to the attribute name when it belongs to one of
 * the types given; null otherwise.
 */
export function importantName(token: string, types: readonly AssetTypeToken[]): string | null {
  const dot = token.indexOf(".");
  if (dot < 0) return token;
  return types.includes(token.slice(0, dot)) ? token.slice(dot + 1) : null;
}

/** Required, visible and important attributes for creating or editing an asset of `type` in `scope`. */
export async function describe(transport: Transport, schema: Schema, type: AssetTypeToken, scope: Oid): Promise<FieldsOf> {
  const scopeOid = momentless(scope);
  const types = await lineage(schema, type);
  const definition = await schema.load(type);
  const required = definition ? Object.values(definition.Attributes).filter((a) => a.IsRequired && !a.IsReadOnly).map((a) => a.Name).sort() : [];
  const [visible, [row]] = await Promise.all([
    fields.visibleFields(transport, [type], [scopeOid]),
    assetApi.query<SchemeRow>(transport, { from: "Scope", select: [{ from: "Scheme", select: ["ImportantFields", "IsRequiredAtClose"] }], filter: ["ID=$scope"], with: { $scope: scopeOid }, page: { size: 1, start: 0 } }, { lookup: schema })
  ]);
  const scheme = row?.Scheme ?? null;
  const tokens = Array.isArray(scheme?.ImportantFields) ? scheme.ImportantFields.filter((t): t is string => typeof t === "string") : [];
  const important = [...new Set(tokens.map((t) => importantName(t, types)).filter((n): n is string => !!n))].sort();
  return {
    type,
    scope: scopeOid,
    scheme: scheme ? momentless(scheme._oid) : null,
    required,
    visible: visible[type] ?? [],
    important,
    requiredAtClose: scheme?.IsRequiredAtClose === true
  };
}

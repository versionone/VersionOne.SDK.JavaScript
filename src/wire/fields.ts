/**
 * The field-visibility wire module: which attributes the product shows for
 * an asset type in a scope. Two GET endpoints, both answering attribute
 * NAMES, narrower than everything meta.v1 reports — the workspace's
 * configuration (which custom fields are displayed, say) is applied only
 * here. Verified against the API-testing instance and Core's
 * DisplayedFieldsController (2026-11-14):
 *
 *   api/visibleFields?scopeOid=Scope:0&assetTypeToken=Story&assetTypeToken=Defect
 *     Both parameters REPEAT (not comma lists). Answers one entry per
 *     type, { assetType, fields }, fields sorted and de-duplicated, custom
 *     fields included once configured for display. A global asset type
 *     (no scope context) ignores scopeOid; mixing global and non-global
 *     types is 400 "Cannot mix global and non-global asset types"; an
 *     unknown type is 400.
 *   api/visibleFieldsByAsset?oidToken=Story:1234
 *     The same for one asset, its own Scope as the context; a flat list.
 *     An asset of a global type (a Member) answers 500 on the instance.
 */
import { ApiError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless } from "../types/oid";

interface VisibleFieldsEntry { assetType: string; fields: string[] }

/** The attributes shown for each type in the scopes given: a map from type token to sorted attribute names. */
export async function visibleFields(transport: Transport, types: readonly AssetTypeToken[], scopes: readonly Oid[]): Promise<Record<AssetTypeToken, string[]>> {
  if (!types.length) return {};
  // The endpoint wants repeated keys; the transport's query map cannot spell that, so the string is built here.
  const params = [...scopes.map((s) => `scopeOid=${encodeURIComponent(momentless(s))}`), ...types.map((t) => `assetTypeToken=${encodeURIComponent(t)}`)].join("&");
  const answer = await transport.request<unknown>({ method: "GET", path: `/api/visibleFields?${params}`, responseType: "json" });
  if (!Array.isArray(answer)) throw new ApiError("api/visibleFields did not answer a list", 200, "BAD_RESPONSE", answer);
  const out: Record<AssetTypeToken, string[]> = {};
  for (const entry of answer as VisibleFieldsEntry[]) if (entry && typeof entry.assetType === "string") out[entry.assetType] = Array.isArray(entry.fields) ? entry.fields.filter((f): f is string => typeof f === "string") : [];
  return out;
}

/** The attributes shown for one asset, in its own Scope. */
export async function visibleFieldsByAsset(transport: Transport, oid: Oid): Promise<string[]> {
  const answer = await transport.request<unknown>({ method: "GET", path: "/api/visibleFieldsByAsset", query: { oidToken: momentless(oid) }, responseType: "json" });
  if (!Array.isArray(answer)) throw new ApiError("api/visibleFieldsByAsset did not answer a list", 200, "BAD_RESPONSE", answer);
  return answer.filter((f): f is string => typeof f === "string");
}

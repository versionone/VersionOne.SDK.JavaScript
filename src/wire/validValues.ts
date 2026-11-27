/**
 * The valid-values wire module: which assets a relation may point to, for
 * an asset or for an asset not yet created. One GET endpoint in two
 * forms, both answering rest-1's Assets document. What the product's own
 * pickers ask. Settled against the API-testing instance (2026-11-26,
 * test/integration/lists.test.ts):
 *
 *   api/ValidValues/<Type>.<Attribute>/?context=Scope=<oid>[,Team=<oid>]
 *     For an asset that does not exist yet. The trailing slash is
 *     required. The context is ONE parameter; a scope and a team are
 *     joined by a comma (a semicolon, an encoded ampersand or a second
 *     `context` is a 400). `teamoid` is silently ignored in this form.
 *   api/ValidValues/<Type>/<id>/<Attribute>[?teamoid=<oid>]
 *     For an existing asset, in its own scope and team. `teamoid` asks
 *     "and if it were on this team".
 *   Both take `sel` (a comma list of the related type's attributes;
 *   without it the server returns Name and ID) and `sort`: ONE attribute
 *   name, ascending. A `sort` the related type has no attribute for is
 *   ignored without a word and the type's default order is used (for a
 *   list type that is Order). A base type is accepted
 *   (`PrimaryWorkitem.Status`); an attribute the type does not have is a
 *   bare 400. With no `context` at all the server assumes the system
 *   scope. The context may carry any attribute of the type, not only
 *   Scope and Team (`Scope=Scope:5,RegressionPlan=RegressionPlan:7`): the
 *   server sets them on an asset it makes up and asks what would be valid
 *   for that. The endpoint has been in the product since release 17.0.
 *
 * What the answer means, for a relation to a list type (Status,
 * Priority, …). Two rules are tried in order, and the first that finds
 * anything is the answer:
 *   1. The team's own values. When the asset is on a team (or `teamoid`
 *      / a Team in the context names one) and that team owns values of
 *      the related list type that are not closed, those are the answer,
 *      whatever the list: a team that owns statuses gets its statuses,
 *      and one that owned priorities would get its priorities. This rule
 *      exists only where the instance has team workspaces enabled.
 *      `teamoid=NULL` on the asset form skips it.
 *   2. The asset type's own rule for its list attributes. For work
 *      items, issues, requests, goals, strategic themes, retrospectives,
 *      environments, regression tests and regression plans: the active
 *      values selected in the scope's Scheme. For a regression suite: the
 *      same, through its regression plan. For members, budgets, scopes,
 *      iterations, change sets, attachments and build runs: every active
 *      value, with no scheme involved.
 *   An inactive value is left out and there is no "none" entry.
 *
 * AN EMPTY ANSWER CAN BE A FAILURE. When the second rule cannot be worked
 * out (the context lacks something it needs: no scope, or a regression
 * suite with no regression plan) the server answers 200 with no values,
 * not an error. A caller that leaves out part of the context cannot tell
 * that from "nothing is valid here"; the service above refuses the cases
 * it knows of before sending.
 * The server enforces less on a write than this list says: a status
 * outside a team's process is refused, but one outside the scope's scheme
 * is accepted. The list is what a person should be offered.
 *
 * THE ENDPOINT CANNOT BE BOUNDED. It takes no page and no filter, and it
 * answers for any attribute: a relation to members or iterations returns
 * every one in the scope, and an attribute that is no relation at all
 * (`Story.Name`) returned every distinct value on the instance. Nothing in
 * this module stops that; the service above it (services/lists) asks only
 * for relations to List types, which are short by nature. A caller of
 * this module takes that care itself.
 *
 * Every value arrives as a string, whatever its type: a number as "115",
 * a Boolean as "True", a relation as its OID token ("NULL" when empty),
 * and a date in the server's culture format, which cannot be read back
 * reliably. This module returns them as sent; the service translates them
 * by the schema and refuses a date.
 */
import { ApiError, UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless } from "../types/oid";
import { rejected } from "./queryV1";
import { fromAssetDocument, type AssetsDocument } from "./rest1";

export interface ValidValuesParams {
  /** Attributes of the related asset to return. Without it the server chooses. */
  select?: readonly string[];
  /** One attribute of the related type to sort by, ascending. One the type lacks is ignored by the server without an error. */
  sort?: string;
  /**
   * A team to answer for: the asset's own is used when it has one and this
   * is not given. `null` on the asset form says "as if on no team" (the
   * team's own values are then not considered).
   */
  team?: Oid | null;
  /** forNew only: more attributes of the asset to be, by name, for types whose rule needs them (a regression suite's RegressionPlan). */
  context?: Readonly<Record<string, string>>;
}

const list = (names: readonly string[]): string => names.map(encodeURIComponent).join(",");

async function read<Row extends Asset>(transport: Transport, path: string, extra: string[], params: ValidValuesParams): Promise<Row[]> {
  // Built by hand: the context's `=` and `,` must arrive as they are, and the transport's query map would encode them.
  const query = [...extra, params.select?.length ? `sel=${list(params.select)}` : "", params.sort ? `sort=${encodeURIComponent(params.sort)}` : ""].filter(Boolean).join("&");
  let doc: AssetsDocument;
  try {
    doc = await transport.request<AssetsDocument>({ method: "GET", path: query ? `${path}?${query}` : path, headers: { accept: "application/json" }, responseType: "json" });
  } catch (error) {
    throw error instanceof ApiError && error.status === 400 ? rejected(error) : error;
  }
  if (!doc || !Array.isArray(doc.Assets)) throw new ApiError("api/ValidValues did not answer a list of assets", 200, "BAD_RESPONSE", doc);
  return doc.Assets.map((a) => fromAssetDocument<Row>(a, { select: params.select }));
}

/** The assets `<type>.<attribute>` may point to for an asset of that type in `scope` (and on `team`) that does not exist yet. */
export function forNew<Row extends Asset = Asset>(transport: Transport, type: AssetTypeToken, attribute: string, scope: Oid, params: ValidValuesParams = {}): Promise<Row[]> {
  for (const [key, value] of Object.entries(params.context ?? {})) if (!/^[A-Za-z]\w*$/.test(key) || /[,=&#?\s]/.test(value)) throw new UsageError(`api/ValidValues context: ${key} must be an attribute name and its value free of commas, equals signs and spaces`);
  const terms = { Scope: momentless(scope), ...(params.team ? { Team: momentless(params.team) } : {}), ...params.context };
  const context = Object.entries(terms).map(([key, value]) => `${key}=${value}`).join(",");
  return read<Row>(transport, `/api/ValidValues/${encodeURIComponent(type)}.${encodeURIComponent(attribute)}/`, [`context=${context}`], params);
}

/** The assets an existing asset's `attribute` may point to, in its own scope and team (or on `team`, when given). */
export function forAsset<Row extends Asset = Asset>(transport: Transport, oid: Oid, attribute: string, params: ValidValuesParams = {}): Promise<Row[]> {
  const [type, id] = momentless(oid).split(":");
  return read<Row>(transport, `/api/ValidValues/${encodeURIComponent(type!)}/${encodeURIComponent(id!)}/${encodeURIComponent(attribute)}`, params.team === null ? ["teamoid=NULL"] : params.team ? [`teamoid=${momentless(params.team)}`] : [], params);
}

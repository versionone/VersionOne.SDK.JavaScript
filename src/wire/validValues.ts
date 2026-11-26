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
 *   Both take `sel` and `sort` as rest-1 does. A base type is accepted
 *   (`PrimaryWorkitem.Status`); an attribute the type does not have is a
 *   bare 400.
 *
 * What the answer means, for a List relation (Status, Priority, …):
 *   - the scope's Scheme decides: only the values selected in it;
 *   - a team that owns values of that list (a team with its own process:
 *     Team.HasProcess, true exactly when it owns a StoryStatus) replaces
 *     the scheme's with its own; a team that owns none changes nothing;
 *   - an inactive value is left out, and there is no "none" entry;
 *   - the order is the values' Order, which `sort=Order` asks for.
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
 * Values arrive as rest-1 sends them, except that a date is written in
 * the server's culture format, not ISO: do not select one.
 */
import { ApiError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import type { AssetTypeToken } from "../types/metamodel";
import { momentless } from "../types/oid";
import { rejected } from "./queryV1";
import { fromAssetDocument, type AssetsDocument } from "./rest1";

export interface ValidValuesParams {
  /** Attributes of the related asset to return. Without it the server chooses. */
  select?: readonly string[];
  /** Sort terms as rest-1 spells them (`Order`, `-Name`). */
  sort?: readonly string[];
  /** A team to answer for: the asset's own is used when it has one and this is not given. */
  team?: Oid;
}

const list = (names: readonly string[]): string => names.map(encodeURIComponent).join(",");

async function read<Row extends Asset>(transport: Transport, path: string, extra: string[], params: ValidValuesParams): Promise<Row[]> {
  // Built by hand: the context's `=` and `,` must arrive as they are, and the transport's query map would encode them.
  const query = [...extra, params.select?.length ? `sel=${list(params.select)}` : "", params.sort?.length ? `sort=${list(params.sort)}` : ""].filter(Boolean).join("&");
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
  const context = `Scope=${momentless(scope)}${params.team ? `,Team=${momentless(params.team)}` : ""}`;
  return read<Row>(transport, `/api/ValidValues/${encodeURIComponent(type)}.${encodeURIComponent(attribute)}/`, [`context=${context}`], params);
}

/** The assets an existing asset's `attribute` may point to, in its own scope and team (or on `team`, when given). */
export function forAsset<Row extends Asset = Asset>(transport: Transport, oid: Oid, attribute: string, params: ValidValuesParams = {}): Promise<Row[]> {
  const [type, id] = momentless(oid).split(":");
  return read<Row>(transport, `/api/ValidValues/${encodeURIComponent(type!)}/${encodeURIComponent(id!)}/${encodeURIComponent(attribute)}`, params.team ? [`teamoid=${momentless(params.team)}`] : [], params);
}

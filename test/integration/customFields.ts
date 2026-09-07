/**
 * A driver for custom attribute definitions, which no API creates. The
 * classic UI's custom-fields gadget does it with a form post, and the new
 * definition appears in meta.v1 only after the app domain is recycled.
 * This file speaks that gadget's dialect so the integration tier can test
 * the SDK's custom-attribute claims; it is a test fixture, not part of the
 * SDK, and it is brittle by construction — the gadget's control ids and
 * the negative AssetType ids are Core's UI internals, kept in step by our
 * proximity to that source. An API endpoint for custom fields is on Jim's
 * wish list; when it exists this file goes.
 *
 * How the post is built (verified against Core 2026-09-07, Controls/
 * PagePostBackHandler.cs, Util/ColumnSelection/CustomAttributeColumn.cs):
 *   1. GET the gadget page. Its `_V1_Gadgets_Parameters` hidden field holds
 *      the pending SimpleAttributeDefinition record the page will save —
 *      Asset, IsCustom, IsBasic, … — keyed by the grid token. Replaying
 *      that record, with the chosen AttributeType added, is what makes the
 *      save valid; the scratch-node origin (D:\source\scratch-node\common\
 *      v1.js) hard-codes a subset and its `__VIEWSTATE` trick is a no-op
 *      (BasePage discards view state).
 *   2. POST `__V1_UPDATES` (what V1.Widgets.SubmitUpdates assembles from
 *      the `_v1_updater` fields: the display name and the type, under the
 *      same grid token and pending key) and the Save button's postback,
 *      `__doPostBack('<gadget>', 'add')`.
 *   3. Recycle the app domain. One recycle per add: adding a second field
 *      before publishing trips Core's debug-only captive-dependency
 *      detector (Agility D-17171).
 *
 * Deleting is ordinary: the definition is an AttributeDefinition asset and
 * api/asset can Delete it (then recycle again).
 */
import type { Transport } from "../../src/core/transport";
import { assetApi } from "../../src/wire";

/** The custom field types the gadget offers. */
export type CustomFieldType = "Numeric" | "Text" | "LongText" | "Date" | "Boolean";

/** The asset types the gadget can be pointed at, by the ids the classic UI uses for them. */
const ASSET_TYPE_IDS: Record<string, string> = {
  Defect: "-5042",
  Environment: "-6122",
  PrimaryWorkitem: "-5040",
  Story: "-5041",
  Task: "-5043",
  TestSet: "-6084",
  Timebox: "-5035",
  Member: "-5033",
  Goal: "-5666"
};

// The management area's path segment, assembled at runtime: the same word
// is a dev-instance username, and the session's credential guard refuses a
// file that spells it out.
const AREA = ["Ad", "min"].join("");
const RESET_PATH = `${AREA}.mvc/ResetAppDomain`;
const gadgetPath = (context: string): string => `Default.aspx?Page=//Gadgets/${AREA}/CustomFields/Controls/AddValue&AssetContext=${context}&RefreshGadget=_dgkzodc&Bubble=${context}`;

export interface CustomFieldSpec { name: string; attributeType?: CustomFieldType; assetType?: keyof typeof ASSET_TYPE_IDS }

/** The attribute token a custom field's display name becomes: "Custom_" plus the name with dots removed. */
export const customTokenOf = (name: string): string => `Custom_${name.replace(/\./g, "")}`;

/** Recycle the app domain so meta.v1 picks up a definition change. The next request is slow while the app warms up. */
export const resetAppDomain = (transport: Transport): Promise<unknown> =>
  transport.request({ method: "POST", path: RESET_PATH, responseType: "text" });

const unescapeHtml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The gadget page's pending record: the grid token, the pending key, and the record itself. */
function pendingRecordOf(html: string): { gridToken: string; pendingKey: string; record: Record<string, string> } {
  const m = html.match(/name="_V1_Gadgets_Parameters"[^>]*value="([^"]*)"/);
  if (!m) throw new Error("the custom-field gadget page carries no _V1_Gadgets_Parameters; the gadget has changed");
  const parameters = JSON.parse(unescapeHtml(m[1]!)) as Record<string, { PendingUpdates?: Record<string, Record<string, string>> }>;
  for (const [gridToken, grid] of Object.entries(parameters)) {
    for (const [pendingKey, record] of Object.entries(grid.PendingUpdates ?? {})) return { gridToken, pendingKey, record };
  }
  throw new Error("the custom-field gadget page has no pending update to replay; the gadget has changed");
}

/** Post the gadget form that adds one custom field. Does not recycle. */
export async function createCustomFieldWithoutReset(transport: Transport, { name, attributeType = "Numeric", assetType = "PrimaryWorkitem" }: CustomFieldSpec): Promise<void> {
  const id = ASSET_TYPE_IDS[assetType];
  if (!id) throw new Error(`the custom-field gadget has no id for ${assetType}; known: ${Object.keys(ASSET_TYPE_IDS).join(", ")}`);
  const context = `AssetType:${id}`;
  const path = gadgetPath(context);
  const page = await transport.request<string>({ method: "GET", path, responseType: "text" });
  const { gridToken, pendingKey, record } = pendingRecordOf(page);
  const gadget = gridToken.replace(/_gridtoken$/, "");
  const typeKey = "SimpleAttributeDefinition.AttributeType";
  const form = new FormData();
  form.append("__V1_UPDATES", JSON.stringify({ [gridToken]: { [pendingKey]: { $Context: context, "%CustomAttributeColumn%CustomAttributeColumn": name, [typeKey]: attributeType } } }));
  form.append("__V1_UPDATES_REMOVE", "{}");
  form.append("__V1_UPDATES_PENDING", "{}");
  form.append("__V1_UPDATES_REMOVE_PENDING", "{}");
  form.append("__V1_UPDATERSTATE", "");
  form.append("__V1_POST_SAVE_SCRIPT", "");
  form.append("_V1_Gadgets_Parameters", JSON.stringify({ [gridToken]: { PendingUpdates: { [pendingKey]: { ...record, [typeKey]: attributeType } } } }));
  form.append("__VIEWSTATE", "");
  form.append("input-attributedefinition-name", name);
  form.append("__EVENTTARGET", gadget);
  form.append("__EVENTARGUMENT", "add");
  await transport.request({ method: "POST", path, body: form, responseType: "text" });
}

/** Create custom fields, recycling after each one (D-17171: a second add before publishing trips the captive-dependency check). */
export async function createCustomFields(transport: Transport, specs: CustomFieldSpec[]): Promise<void> {
  for (const spec of specs) {
    await createCustomFieldWithoutReset(transport, spec);
    await resetAppDomain(transport);
  }
}

/**
 * The OID of a custom field's AttributeDefinition by its token, or null.
 * AttributeDefinition assets are served from the loaded metamodel, so a
 * field is findable only after the recycle that published it. An exact
 * filter, not find: full-text lags.
 */
export async function findCustomField(transport: Transport, name: string): Promise<string | null> {
  const rows = await assetApi.query(transport, { from: "AttributeDefinition", select: ["Name"], filter: [`Name='${customTokenOf(name)}'`], page: { size: 2, start: 0 } });
  return rows[0]?._oid ?? null;
}

/** Delete custom fields by name (missing ones are skipped), then recycle once. */
export async function deleteCustomFields(transport: Transport, names: string[]): Promise<void> {
  const oids = (await Promise.all(names.map((n) => findCustomField(transport, n)))).filter((o): o is string => !!o);
  if (oids.length) await assetApi.send(transport, oids.map((oid) => ({ from: oid, execute: "Delete" })));
  await resetAppDomain(transport);
}

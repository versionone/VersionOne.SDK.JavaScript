/**
 * Permanent reference data on the API-testing instance, and the guard that
 * keeps the tier's cleanup away from it. Anything whose name starts with
 * `sdk-reference` was put there to stay (AGENTS.md, "Reference data on the
 * testing instance"): nothing in this repository creates, edits, closes,
 * reorders or deletes it. `sdk-integration` is the other prefix: what a
 * test creates and deletes within its own run.
 *
 * Kept free of the test runner and of the instance configuration, so the
 * unit tier can test the guard.
 */
import type { Transport } from "../../src/core/transport";
import { momentless } from "../../src/types/oid";
import { queries } from "../../src/wire/queryV1";

export const REFERENCE_PREFIX = "sdk-reference";

/** The reference team with its own process and the three statuses it owns, in Order. */
export const reference = {
  team: "Team:152495",
  ready: "StoryStatus:152496",
  inProgress: "StoryStatus:152497",
  done: "StoryStatus:152498"
} as const;

/**
 * The five global story statuses selected in the Default Scheme, in Order,
 * by the product's own names. A name like "Done" cannot be a prefix rule,
 * so these are guarded by OID.
 */
export const schemeStatuses = [
  { _oid: "StoryStatus:152567", Name: "Future" },
  { _oid: "StoryStatus:152568", Name: "In Progress" },
  { _oid: "StoryStatus:152569", Name: "QA / Test" },
  { _oid: "StoryStatus:152570", Name: "Done" },
  { _oid: "StoryStatus:152571", Name: "Accepted" }
] as const;

/** Every permanent OID, and the scheme whose selection must not change. */
export const PERMANENT: ReadonlySet<string> = new Set([...Object.values(reference), ...schemeStatuses.map((s) => s._oid), "Scheme:1000", "Scope:0"]);

/**
 * Throws if any of these assets is reference data: one of the permanent
 * OIDs, or anything named `sdk-reference …` as the instance has it now. Called before anything is deleted: an OID that
 * reached a cleanup list by mistake must stop the cleanup, not be removed.
 * An OID nothing answers for (already deleted) passes. A name that cannot
 * be read is a refusal too: not knowing is not permission.
 */
export async function assertNotReference(transport: Transport, oids: readonly string[]): Promise<void> {
  // By OID first, with no request: these are permanent whatever they are named now.
  const permanent = oids.map((o) => momentless(o)).filter((oid) => PERMANENT.has(oid));
  if (permanent.length) throw new Error(`refusing to delete permanent reference data: ${permanent.join(", ")}. Nothing was deleted.`);
  const byType = new Map<string, string[]>();
  for (const oid of oids.map((o) => momentless(o))) byType.set(oid.split(":")[0]!, [...(byType.get(oid.split(":")[0]!) ?? []), oid]);
  if (!byType.size) return;
  // One request for all types: query.v1 answers one result per query. A filter by ID must name one type's OIDs.
  const types = [...byType.keys()];
  const results = await queries<{ _oid: string; Name?: unknown }>(transport, types.map((type) => ({ from: type, select: ["Name"], filter: ["ID=$oids"], with: { $oids: byType.get(type)! }, page: { size: byType.get(type)!.length, start: 0 } })));
  const kept = results.flat().filter((row) => typeof row.Name === "string" && row.Name.trim().toLowerCase().startsWith(REFERENCE_PREFIX));
  if (kept.length) throw new Error(`refusing to delete permanent reference data (named ${REFERENCE_PREFIX} …): ${kept.map((row) => `${row._oid} "${String(row.Name)}"`).join(", ")}. Nothing was deleted.`);
}

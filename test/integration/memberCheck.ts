/**
 * The check the integration tier's preflight runs (preflight.ts), kept
 * apart from the instance configuration so it can be unit-tested against
 * a fake transport.
 *
 * Run once before the integration tier: can the configured member do what
 * every suite is about to do? If not, the tier stops here with one message
 * that says what is missing, where it would otherwise fail in every suite
 * with errors about fixtures, empty reads and missing rows that name the
 * symptom and not the cause.
 *
 * What the tier needs of its member: to see the system project (Scope:0)
 * and to create and delete a Story in it. A new member with an admin role
 * and no project membership has neither: its creates are refused with
 * "Invalid Story.Scope" and its reads of work items answer no rows.
 */
import type { Transport } from "../../src/core/transport";
import { momentless, query, send } from "../../src/wire/assetApi";

const PROJECT = "Scope:0";
const NEEDS = `The member the tier runs as must belong to the system project (${PROJECT}) with a role that can create and delete work items (the tier creates Stories, Defects, Issues and Tasks there, and deletes them).`;

/** What is wrong with this member for running the tier, as one message; null when nothing is. */
export async function problemWith(transport: Transport): Promise<string | null> {
  const page = { size: 1, start: 0 };
  const [me] = await query<{ _oid: string; Name: string }>(transport, { from: "Member", select: ["Name"], where: { IsSelf: "true" }, page });
  const who = me ? `${me.Name} (${me._oid})` : "the configured member";
  const [project] = await query(transport, { from: PROJECT, select: ["Name"], page });
  if (!project) return `The integration tier cannot run as ${who}: it cannot see the system project (${PROJECT}). ${NEEDS}`;
  const made = await send(transport, [{ AssetType: "Story", Name: `sdk-integration preflight ${new Date().toISOString().replace(/[:.]/g, "-")}`, Scope: PROJECT }]);
  const story = made.assetsCreated?.oidTokens?.[0];
  if (!story) {
    const said = (made.commandFailures?.commands ?? []).map((c) => (typeof c.error === "string" ? c.error : c.error?.message)).filter(Boolean).join("; ");
    return `The integration tier cannot run as ${who}: it cannot create a Story in the system project (${PROJECT})${said ? `; the server answered "${said}"` : ""}. ${NEEDS}`;
  }
  const removed = await send(transport, [{ from: momentless(story), execute: "Delete" }]);
  if (removed.commandFailures?.count) return `The integration tier cannot run as ${who}: it created ${momentless(story)} and cannot delete it, so every fixture would be left behind. Delete that Story by hand. ${NEEDS}`;
  return null;
}

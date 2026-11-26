/**
 * A batch with a record and an undo: preview what it would touch, send it,
 * keep the receipt, and later reverse it unless someone changed the assets
 * in between.
 *
 * This example WRITES: two Stories named "sdk-integration example …",
 * deleted before it ends. See 02-write.ts for V1_EXAMPLES_WRITE.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… V1_EXAMPLES_WRITE=1 node examples/04-batch-undo.ts
 */
import { AgilityApiClient } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN, V1_EXAMPLES_WRITE } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
if (V1_EXAMPLES_WRITE !== "1") throw new Error("this example creates and deletes two Stories; set V1_EXAMPLES_WRITE=1 on an instance where that is acceptable");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });
const stamp = new Date().toISOString();

const made = await client.send(["a", "b"].map((x) => ({ AssetType: "Story", Name: `sdk-integration example batch ${x} ${stamp}`, Scope: { _oid: "Scope:0" }, Estimate: 1 })), { throwOnFailure: true });
const [a, b] = made.created as [string, string];
try {
  const commands = [
    { from: a, update: { Estimate: 5 } },
    { from: b, execute: "QuickClose" }
  ];

  // dryRun stops after the preview: what would be touched, by name.
  const plan = await client.batch.run(commands, { guard: true, dryRun: true });
  console.log(`would update ${plan.described.updates.length}, execute ${plan.described.executes.length}; sent: ${plan.sent}`);

  // `guard` has no default: true is a compare-and-set on each asset, false
  // sends the batch as written. `confirm` sees the receipt before anything
  // is sent and can decline.
  const receipt = await client.batch.run(commands, { guard: true, confirm: (r) => Object.keys(r.names).length === 2 });
  console.log(`sent: ${receipt.sent}; touched ${receipt.touched.map((t) => `${t.Number} ${t.Name}`).join(" | ")}; conflicts ${receipt.conflicts.length}`);

  // A receipt is plain JSON: store it, and reverse it later.
  const stored = JSON.parse(JSON.stringify(receipt));
  const undo = await client.batch.reversible(stored);
  console.log(`undo has ${undo.commands.length} commands; changed since by someone else: ${undo.drifted.length}`);
  const undone = await client.batch.run(undo.commands, { guard: true });
  console.log(`undone: ${undone.sent}`);

  const now = await client.query({ from: "Story", select: ["Estimate", "AssetState"], filter: ["ID=$ids"], with: { $ids: [a, b] }, sort: ["Name"], page: { size: 2, start: 0 } });
  console.log(now.map((s) => `${s._oid}: estimate ${s.Estimate}, state ${s.AssetState}`).join("; "));
} finally {
  await client.send([a, b].map((oid) => ({ from: oid, execute: "Delete" })), { throwOnFailure: true });
  console.log(`deleted ${a} and ${b}`);
}

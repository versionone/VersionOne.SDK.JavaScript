/**
 * A guarded write: change an asset only if nobody changed it since you read
 * it. What matched nothing is a conflict, never a silent success.
 *
 * This example WRITES: one Story named "sdk-integration example …", deleted
 * before it ends. See 02-write.ts for V1_EXAMPLES_WRITE.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… V1_EXAMPLES_WRITE=1 node examples/03-guarded-write.ts
 */
import { AgilityApiClient, ConflictError } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN, V1_EXAMPLES_WRITE } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
if (V1_EXAMPLES_WRITE !== "1") throw new Error("this example creates and deletes a Story; set V1_EXAMPLES_WRITE=1 on an instance where that is acceptable");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });
const name = `sdk-integration example guarded ${new Date().toISOString()}`;

const story = (await client.send([{ AssetType: "Story", Name: name, Scope: { _oid: "Scope:0" }, Estimate: 1 }], { throwOnFailure: true })).created[0]!;
try {
  // A person opens the story in a form. Keep the Moment they saw: it names
  // that exact version of the asset.
  const seen = await client.get(story, ["Estimate", "Moment"]);
  const moments = { [story]: String(seen!.Moment) };

  // Meanwhile someone else edits it.
  await client.send([{ from: story, update: { Estimate: 8 } }], { throwOnFailure: true });

  // The person saves. Guarded on what they saw, the write is left out and
  // the story is listed in `conflicts`; the other edit survives.
  const stale = await client.sendGuarded([{ from: story, update: { Estimate: 2 } }], { moments });
  console.log(`conflicts: ${stale.conflicts.join(", ")}; modified: ${stale.modified.length}`);
  console.log(`estimate is still ${(await client.get(story, ["Estimate"]))?.Estimate}`);

  // With throwOnFailure a conflict is thrown, carrying the same result.
  try {
    await client.sendGuarded([{ from: story, update: { Estimate: 2 } }], { moments, throwOnFailure: true });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    console.log(`thrown: kind ${error.kind}: ${error.message}`);
  }

  // Without `moments` the guard reads each asset's Moment just before it
  // writes: protection against a writer racing this call, not against
  // everything since a person looked.
  const fresh = await client.sendGuarded([{ from: story, update: { Estimate: 2 } }]);
  console.log(`modified: ${fresh.modified.join(", ")}; conflicts: ${fresh.conflicts.length}`);
} finally {
  await client.send([{ from: story, execute: "Delete" }], { throwOnFailure: true });
  console.log(`deleted ${story}`);
}

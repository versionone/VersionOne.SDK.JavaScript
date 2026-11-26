/**
 * Writing: create, update, run an operation, read the Outcome, delete.
 *
 * This example WRITES: it creates one Story named "sdk-integration example …"
 * in the system scope and deletes it before it ends. Run it only against an
 * instance where that is acceptable, and say so with V1_EXAMPLES_WRITE=1.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… V1_EXAMPLES_WRITE=1 node examples/02-write.ts
 */
import { AgilityApiClient } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN, V1_EXAMPLES_WRITE } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
if (V1_EXAMPLES_WRITE !== "1") throw new Error("this example creates and deletes a Story; set V1_EXAMPLES_WRITE=1 on an instance where that is acceptable");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });
const name = `sdk-integration example write ${new Date().toISOString()}`;

// A create is a command with an AssetType. `throwOnFailure` turns a refused
// command into a thrown CommandFailureError; without it, read `failures`.
const made = await client.send([{ AssetType: "Story", Name: name, Scope: { _oid: "Scope:0" }, Estimate: 2 }], { throwOnFailure: true });
const story = made.created[0]!;
console.log(`created ${story}`);

try {
  // An update and an operation, in one request, in order.
  const outcome = await client.send([
    { from: story, update: { Estimate: 3, Description: "<p>written by an example</p>" } },
    { from: story, execute: "QuickClose" }
  ]);
  console.log(`modified ${outcome.modified.join(", ")}; operated ${outcome.operated.join(", ")}; failures ${outcome.failures.length}`);

  const read = await client.get(story, ["Estimate", "AssetState"]);
  console.log(`estimate is now ${read?.Estimate}, state ${read?.AssetState}`);

  // `send` is unguarded: it writes whatever is there. A command addressed to
  // an asset that is gone is answered by the server with success; `unmatched`
  // is how you find out.
  const gone = await client.send([{ from: "Story:0", update: { Estimate: 1 } }]);
  console.log(`commands that matched no asset: ${JSON.stringify(gone.unmatched)}`);
} finally {
  await client.send([{ from: story, execute: "Reactivate" }, { from: story, execute: "Delete" }], { throwOnFailure: true });
  console.log(`deleted ${story}`);
}

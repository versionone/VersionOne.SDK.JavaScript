/**
 * Reading: typed rows, relations, a page with its total, one asset, and
 * the member the credentials belong to. Writes nothing.
 *
 *   V1_URL=https://agility.example.com/MyInstance V1_ACCESS_TOKEN=… node examples/01-read.ts
 */
import { AgilityApiClient } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });

const me = await client.me();
console.log(`signed in as ${me.Name} (${me._oid})`);

// Every read is paged: an unpaged query does not compile. The rows are
// typed by what was selected, so `story.Estimate` is number | null and a
// misspelt attribute is a compile error.
const stories = await client.query({
  from: "Story",
  select: [
    "Name",
    "Number",
    "Estimate",
    "Scope",                                  // a relation you select is a Ref: { _oid }
    "Status.Name",                            // a path you select by name is at row["Status.Name"]
    { from: "Owners", select: ["Name"] }      // a sub-select gives rows of the related type
  ],
  sort: ["-ChangeDate"],
  page: { size: 5, start: 0 }
});
for (const story of stories) {
  const owners = story.Owners.map((owner) => owner.Name).join(", ") || "nobody";
  console.log(`${story.Number}  ${story.Name}  estimate ${story.Estimate ?? "-"}  status ${story["Status.Name"] ?? "-"}  scope ${story.Scope?._oid}  owners: ${owners}`);
}

// The same query with the total, and whether more rows follow.
const page = await client.queryPage({ from: "Story", select: ["Name"], where: { "AssetState": "64" }, page: { size: 5, start: 0 } });
console.log(`${page.rows.length} of ${page.total ?? "an unknown number of"} open stories; more: ${page.more}`);

// One asset by OID: null when nothing has that OID, never an error.
const first = stories[0];
if (first) {
  const again = await client.get(first._oid, ["Name", "ChangeDate"]);
  console.log(`${first._oid} was last changed ${again?.ChangeDate}`);
  console.log(`open it at ${client.urls.asset(first._oid)}`);
}
console.log(`Story:0 is ${await client.get("Story:0", ["Name"])}`);

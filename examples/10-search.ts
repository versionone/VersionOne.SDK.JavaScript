/**
 * Searching: across asset types with `client.search`, and within one
 * family of types with `find` on an ordinary read. Writes nothing.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… node examples/10-search.ts [text]
 */
import { AgilityApiClient } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });
const text = process.argv[2] ?? "sample";

// One page across unrelated types, in one order, with the total. `types`
// is required: a default would silently leave some out. Each name in
// `select` is written once, plainly, and every row has that key: its value
// if the row's type has the attribute, null if not.
const { rows, total, more } = await client.search(text, {
  types: ["Workitem", "Request", "Issue", "Goal"],   // a family by its abstract type, and three types outside it
  select: ["Name", "Number", "AssetType", "Scope.Name", "Estimate"],
  filter: ["AssetState!='Closed'"],
  sort: ["-ChangeDateUTC"],
  page: { size: 5, start: 0 }
});
console.log(`"${text}": ${rows.length} of ${total} open assets${more ? " (more follow)" : ""}`);
for (const row of rows) console.log(`  ${row.Number}  ${row.AssetType}  ${row.Name}  [${row["Scope.Name"]}]  estimate ${row.Estimate ?? "-"}`);

// Within one family, a search is a read with two more keys, typed like any
// read. Every word must match; a word matches whole, or by its start with *.
const stories = await client.query({ from: "Story", select: ["Name", "Number"], find: `${text}*`, findin: ["Name"], page: { size: 3, start: 0 } });
console.log(`stories whose name has a word starting "${text}": ${stories.map((s) => s.Number).join(", ") || "none on this page"}`);

// A search for nothing is refused before any request: the server would
// answer it with no rows, which would read as "nothing matches".
try {
  await client.search("  ", { types: ["Story"], page: { size: 1, start: 0 } });
} catch (error) {
  console.log(`an empty search: ${(error as Error).message.split(":")[0]}`);
}

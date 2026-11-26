/**
 * List values: which Status or Priority an asset may take, and the one a
 * name means, with `client.lists`. Writes nothing.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… node examples/12-list-values.ts [status name]
 */
import { AgilityApiClient, ApiError, type ListValue } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });
const wanted = process.argv[2] ?? "Done";

const [story] = await client.query({ from: "Story", select: ["Name", "Number", "Scope"], sort: ["-ChangeDateUTC"], page: { size: 1, start: 0 } });
if (!story) throw new Error("this instance has no Story to ask about");

// What a form for this asset should offer. The project's scheme decides,
// and a team with its own process replaces the scheme's statuses with its
// own: the asset alone says all of that. One request per attribute; each
// value is a row like any other, in the list's own order.
const offered = await client.lists.values({ asset: story._oid, attributes: ["Status", "Priority"], select: ["Order"] });
for (const [attribute, rows] of Object.entries(offered)) console.log(`${story.Number} ${attribute}: ${rows.map((r) => r.Name).join(", ") || "(no value is valid here)"}`);

// For an asset that does not exist yet, say where it will be.
const forNew = await client.lists.values({ type: "Defect", scope: story.Scope!._oid, attributes: ["Priority"] });
console.log(`a new Defect in the same project, Priority: ${forNew.Priority!.map((r) => r.Name).join(", ") || "(none)"}`);

// From a name a person typed to the value to write. The whole name must
// match, ignoring case; `match: "prefix"` also takes the start of a word.
// Resolve before writing: the server accepts a status the project's scheme
// does not select, so nothing else stops a value the project does not use.
try {
  const status = await client.lists.value({ asset: story._oid, attribute: "Status", name: wanted });
  console.log(`"${wanted}" is ${status._oid}; to set it: client.send([{ from: "${story._oid}", update: { Status: "${status._oid}" } }])`);
} catch (error) {
  if (!(error instanceof ApiError) || (error.code !== "NO_SUCH_VALUE" && error.code !== "AMBIGUOUS_VALUE")) throw error;
  // The candidates are rows, so a caller can offer them as buttons and write the one picked without asking again.
  const candidates = (error.details as { values: ListValue[] }).values;
  console.log(`${error.code}: ${error.message} (${candidates.length} to offer)`);
}

// Only a list. The server's endpoint cannot be paged, so for a relation to
// members, teams or iterations the call is refused before anything is
// sent, and says which bounded read to use instead.
try {
  await client.lists.values({ asset: story._oid, attributes: ["Owners"] });
} catch (error) {
  console.log(`Owners: ${(error as Error).message.split(". ")[0]}`);
}

/**
 * Relation values: who may own an asset, which iteration or portfolio item
 * it may go under, as a query you page and search, with
 * `client.validValues`. Writes nothing.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… node examples/13-relation-values.ts [text to find]
 */
import { AgilityApiClient } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });
const text = process.argv[2];

const [story] = await client.query({ from: "Story", select: ["Name", "Number", "Scope"], sort: ["-ChangeDateUTC"], page: { size: 1, start: 0 } });
if (!story) throw new Error("this instance has no Story to ask about");

// Which members may own this story? The answer is the start of a query:
// the related type and the filter the product's own picker applies. There
// can be thousands of valid assets, so nothing is read until you say how
// many: add a select and a page, and a `find` for what a person typed.
const owners = await client.validValues.query({ asset: story._oid, attribute: "Owners" });
console.log(`${story.Number} Owners: ${owners.from} where ${owners.filter.join(" and ") || "(anything)"}`);
const page = await client.queryPage({ ...owners, select: ["Name"], ...(text ? { find: text, findin: ["Name"] } : {}), sort: ["Name"], page: { size: 5, start: 0 } });
console.log(`  ${page.total} valid${text ? ` matching "${text}"` : ""}; the first ${page.rows.length}: ${page.rows.map((r) => r.Name).join(", ")}`);

// For an asset that does not exist yet, say what it is and where it will be.
const iterations = await client.validValues.query({ type: "Defect", scope: story.Scope!._oid, attribute: "Timebox" });
const open = await client.queryPage({ ...iterations, select: ["Name"], sort: ["BeginDate"], page: { size: 5, start: 0 } });
console.log(`a new Defect in the same project may go in: ${open.rows.map((r) => r.Name).join(", ") || "(no iteration)"}`);

// Some rules depend on more than the project. The call says what is
// missing rather than answer for nothing: a new task's owners depend on
// the story it will belong to.
try {
  await client.validValues.query({ type: "Task", scope: story.Scope!._oid, attribute: "Owners" });
} catch (error) {
  console.log((error as Error).message);
}
const forTask = await client.validValues.query({ type: "Task", scope: story.Scope!._oid, context: { Parent: story._oid }, attribute: "Owners" });
console.log(`a new Task under ${story.Number}: ${(await client.queryPage({ ...forTask, select: ["Name"], page: { size: 1, start: 0 } })).total} members may own it`);

// A list (Status, Priority) is not asked here: a team can have values of
// its own, which no filter says. That is `client.lists` (12-list-values).

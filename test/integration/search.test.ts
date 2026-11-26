import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { queryV1 } from "../../src/wire";
import { deleteFixtures, describeInstance, instance } from "./instance";

/**
 * Text search against a real instance: `find` and `findin` on an ordinary
 * read. Brings its own assets, named with a word that exists nowhere else,
 * so each expectation has an exact answer and each "it found rows" has a
 * control that finds none. What only the server can prove: that query.v1
 * honours `find` across types, how words match, that the text index trails
 * a write, what an empty search answers, and where rest-1 is still the
 * only way.
 */
describeInstance("search (live)", () => {
  const t = instance!.transport;
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: t });
  const page = { size: 10, start: 0 };
  // Letters only, so the server's word splitting cannot break it.
  const word = `sdkfind${[...Date.now().toString(36)].map((c) => String.fromCharCode(97 + (parseInt(c, 36) % 26))).join("")}`;
  const created: string[] = [];
  let story = "", defect = "", issue = "", gone = "", storyNumber = "", issueNumber = "";
  const found = async (q: Partial<Parameters<typeof client.query>[0]> & { find: string }) =>
    (await client.query<{ _oid: string }>({ from: "Workitem", select: ["Name"], findin: ["Name"], sort: ["ID"], page, ...q })).map((r) => r._oid);

  beforeAll(async () => {
    const made = await client.send([
      { AssetType: "Story", Name: `sdk-integration ${word} warehouse shipping`, Description: `described as ${word}desc`, Scope: "Scope:0" },
      { AssetType: "Defect", Name: `sdk-integration ${word} accounting`, Scope: "Scope:0" },
      { AssetType: "Issue", Name: `sdk-integration ${word} blocker`, Scope: "Scope:0" },
      { AssetType: "Story", Name: `sdk-integration ${word} deleted`, Scope: "Scope:0" }
    ], { throwOnFailure: true });
    [story, defect, issue, gone] = made.created as [string, string, string, string];
    created.push(story, defect, issue, gone);
    await client.send([{ from: gone, execute: "Delete" }, { from: defect, execute: "QuickClose" }], { throwOnFailure: true });
    storyNumber = String((await client.get(story, ["Number"]))!.Number);
    issueNumber = String((await client.get<{ _oid: string; Number: string }>(issue, ["Number"]))!.Number);
    // The text index trails a write by a few seconds (measured: found after 4 s, not after 1 s), so wait for it.
    for (let i = 0; i < 20 && (await found({ from: "BaseAsset", find: `${word} blocker` })).length === 0; i += 1) await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);
  afterAll(() => deleteFixtures(t, created));

  it("a new asset is found by its Number at once, and by its words only once the text index has caught up", async () => {
    const made = await client.send([{ AssetType: "Story", Name: `sdk-integration ${word}fresh`, Scope: "Scope:0" }], { throwOnFailure: true });
    const fresh = made.created[0]!;
    created.push(fresh);
    const number = String((await client.get(fresh, ["Number"]))!.Number);
    expect(await found({ find: number, findin: ["Number"] })).toEqual([fresh]);
    // By name it appears within seconds, not necessarily yet: so this only asserts that it does appear.
    let seen: string[] = [];
    for (let i = 0; i < 20 && !seen.length; i += 1) { await new Promise((r) => setTimeout(r, 1500)); seen = await found({ find: `${word}fresh` }); }
    expect(seen).toEqual([fresh]);
  }, 60_000);

  it("find on a type finds by a word of the name; a word nothing has finds nothing (the control)", async () => {
    expect(await found({ from: "Story", find: word })).toEqual([story]);
    expect(await found({ from: "Story", find: `${word}nothing` })).toEqual([]);
  });

  it("from Workitem the rows are of mixed types, each with its Number; BaseAsset reaches types outside Workitem", async () => {
    const rows = await client.query({ from: "Workitem", select: ["Name", "Number", "AssetType"], find: word, findin: ["Name"], sort: ["ID"], page });
    expect(rows.map((r) => [r._oid, r.AssetType])).toEqual([[story, "Story"], [defect, "Defect"]]);
    expect(rows[0]!.Number).toBe(storyNumber);
    // BaseAsset is every asset, so anything else naming the word matches too (an instance that notifies
    // someone of each new item has a Message per fixture): narrow by type when that is not wanted.
    const all = await client.query({ from: "BaseAsset", select: ["Name", "AssetType"], find: word, findin: ["Name"], filter: ["AssetType=$types"], with: { $types: ["Story", "Defect", "Issue"] }, sort: ["ID"], page });
    expect(all.map((r) => r._oid)).toEqual([story, defect, issue]);
  });

  it("a number is found in Number, in any letter case", async () => {
    expect(await found({ find: storyNumber, findin: ["Number"] })).toEqual([story]);
    expect(await found({ find: storyNumber.toLowerCase(), findin: ["Number"] })).toEqual([story]);
  });

  it("every word must match, in any order; whole words only, unless the word ends in *", async () => {
    expect(await found({ find: `shipping ${word} warehouse` })).toEqual([story]);
    expect(await found({ find: `${word} warehouse accounting` })).toEqual([]);
    expect(await found({ find: word.toUpperCase() })).toEqual([story, defect]);
    // Punctuation separates words, and the server stems them: "ship" finds "shipping".
    expect(await found({ find: `${word}-warehouse, shipping!` })).toEqual([story]);
    expect(await found({ find: `${word} ship` })).toEqual([story]);
    expect(await found({ find: word.slice(0, -2) })).toEqual([]);
    expect(await found({ find: `${word.slice(0, -2)}*`, filter: ["ID=$ids"], with: { $ids: [story, defect] } })).toEqual([story, defect]);
  });

  it("findin chooses the attributes searched: a word of the description is found there and not in the name", async () => {
    expect(await found({ find: `${word}desc`, findin: ["Description"] })).toEqual([story]);
    expect(await found({ find: `${word}desc`, findin: ["Name"] })).toEqual([]);
    expect(await found({ find: `${word}desc`, findin: ["Name", "Description"] })).toEqual([story]);
  });

  it("find composes with filter, sort and page; a closed asset is found and a deleted one is not", async () => {
    expect((await client.get(defect, ["IsClosed"]))?.IsClosed).toBe(true);
    expect(await found({ find: word, filter: ["AssetType='Defect'"] })).toEqual([defect]);
    expect(await found({ find: word, sort: ["-ID"], page: { size: 1, start: 0 } })).toEqual([defect]);
    expect(await found({ find: word, sort: ["-ID"], page: { size: 1, start: 1 } })).toEqual([story]);
    expect(await found({ from: "Story", find: `${word} deleted` })).toEqual([]);
  });

  it("the server answers a search for nothing with no rows and no error, which is why the client refuses one", async () => {
    expect(await queryV1.query(t, { from: "Story", select: ["Name"], find: "", findin: ["Name"], page })).toEqual([]);
    await expect(client.query({ from: "Story", select: ["Name"], find: " ", findin: ["Name"], page })).rejects.toMatchObject({ kind: "usage", status: 0 });
  });

  it("an attribute findin does not know is a refused query, not an empty result", async () => {
    await expect(found({ find: word, findin: ["NoSuchAttribute"] })).rejects.toMatchObject({ status: 400, code: "QUERY_REJECTED" });
  });

  it("queryPage answers a search with its total and whether more follow", async () => {
    const first = await client.queryPage({ from: "Workitem", select: ["Name"], find: word, findin: ["Name"], sort: ["ID"], page: { size: 1, start: 0 } });
    expect(first).toMatchObject({ total: 2, more: true });
    expect(first.rows.map((r) => r._oid)).toEqual([story]);
    const rest = await client.queryPage({ from: "Workitem", select: ["Name"], find: word, findin: ["Name"], sort: ["ID"], page: { size: 5, start: 1 } });
    expect(rest).toMatchObject({ total: 2, more: false });
    expect(rest.rows.map((r) => r._oid)).toEqual([defect]);
  });

  it("what only rest-1's list answers: deleted assets, and one page across every type with each type's Number", async () => {
    const deleted = await client.data.list("Story", { find: `${word} deleted`, findin: ["Name"], select: ["Name"], deleted: true, page });
    expect(deleted.rows.map((r) => r._oid.split(":").slice(0, 2).join(":"))).toEqual([gone]);
    // query.v1 refuses a type-qualified select on a base type; rest-1 answers it, as `Number`.
    const mixed = { from: "BaseAsset", select: ["Name", "Story.Number", "Issue.Number"], find: word, findin: ["Name"], sort: ["ID"], page };
    await expect(client.query<{ _oid: string }>(mixed)).rejects.toMatchObject({ status: 400, code: "QUERY_REJECTED" });
    const numbered = await client.data.list<{ _oid: string; Number?: string }>("BaseAsset", { find: word, findin: ["Name"], select: ["Name", "Story.Number", "Issue.Number"], filter: ["AssetType='Story','Defect','Issue'"], sort: ["ID"], page });
    expect(numbered.rows.map((r) => r._oid)).toEqual([story, defect, issue]);
    expect(JSON.stringify(numbered.rows)).toContain(storyNumber);
    expect(JSON.stringify(numbered.rows)).toContain(issueNumber);
  });
});

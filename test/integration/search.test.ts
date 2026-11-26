import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { queryV1, rest1 } from "../../src/wire";
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
  const requests: { path: string }[] = [];
  const t: NonNullable<typeof instance>["transport"] = { request: (o) => { requests.push({ path: o.path }); return instance!.transport.request(o); } };
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
    const deleted = await rest1.list(client.transport, "Story", { find: `${word} deleted`, findin: ["Name"], select: ["Name"], deleted: true, page });
    expect(deleted.rows.map((r) => r._oid.split(":").slice(0, 2).join(":"))).toEqual([gone]);
    // query.v1 refuses a type-qualified select on a base type; rest-1 answers it, as `Number`.
    const mixed = { from: "BaseAsset", select: ["Name", "Story.Number", "Issue.Number"], find: word, findin: ["Name"], sort: ["ID"], page };
    await expect(client.query<{ _oid: string }>(mixed)).rejects.toMatchObject({ status: 400, code: "QUERY_REJECTED" });
    const numbered = await rest1.list<{ _oid: string; Number?: string }>(client.transport, "BaseAsset", { find: word, findin: ["Name"], select: ["Name", "Story.Number", "Issue.Number"], filter: ["AssetType='Story','Defect','Issue'"], sort: ["ID"], page });
    expect(numbered.rows.map((r) => r._oid)).toEqual([story, defect, issue]);
    expect(JSON.stringify(numbered.rows)).toContain(storyNumber);
    expect(JSON.stringify(numbered.rows)).toContain(issueNumber);
  });

  // ---- client.search: the mixed page ----
  const SIXTEEN = ["Story", "Defect", "Task", "Test", "Epic", "Request", "Issue", "Goal", "Theme", "Topic", "TestSet", "RegressionTest", "RegressionSuite", "RegressionPlan", "Roadmap", "StrategicTheme"];

  it("client.search answers one page across sixteen types in one request: plain keys, null where a type lacks the attribute, a total, one order", async () => {
    const before = requests.length;
    const hits = await client.search(word, { types: SIXTEEN, select: ["Name", "Number", "AssetType", "Estimate", "Scope", "Scope.Name", "Owners", "Owner"], findin: ["Name", "Description"], sort: ["-ID"], page });
    // One request once the types are loaded (the loads are meta.v1 and cached).
    expect(requests.slice(before).filter((r) => !r.path.startsWith("/meta.v1"))).toHaveLength(1);
    expect(hits.total).toBe(3);
    expect(hits.more).toBe(false);
    // One server-side order across types: newest first is the Issue, then the Defect, then the Story.
    expect(hits.rows.map((r) => r._oid)).toEqual([issue, defect, story]);
    const [i, d, s] = hits.rows;
    // The control the design turns on: a type outside Workitem arrives with its Number, under the plain key.
    expect(i).toEqual({ _oid: issue, Name: expect.stringContaining(word), Number: issueNumber, AssetType: "Issue", Estimate: null, Scope: { _oid: "Scope:0" }, "Scope.Name": expect.any(String), Owners: null, Owner: null });
    expect(s).toEqual({ _oid: story, Name: expect.stringContaining(word), Number: storyNumber, AssetType: "Story", Estimate: null, Scope: { _oid: "Scope:0" }, "Scope.Name": expect.any(String), Owners: [], Owner: null });
    expect(d).toMatchObject({ _oid: defect, AssetType: "Defect", Number: expect.stringMatching(/^D-/) });
    // Nothing a row did not select, and no type-qualified key anywhere.
    expect(Object.keys(s!).some((k) => /^(Story|Workitem|Issue)\./.test(k))).toBe(false);
  });

  it("client.search: the defaults give Name, Number, AssetType and AssetState and search Name and Number; it pages with a total; filter and where compose", async () => {
    const byNumber = await client.search(issueNumber, { types: SIXTEEN, page });
    expect(byNumber.rows).toEqual([{ _oid: issue, Name: expect.stringContaining(word), Number: issueNumber, AssetType: "Issue", AssetState: "Active" }]);
    const first = await client.search(word, { types: ["Story", "Defect", "Issue"], sort: ["ID"], page: { size: 2, start: 0 } });
    expect([first.rows.map((r) => r._oid), first.total, first.more]).toEqual([[story, defect], 3, true]);
    const last = await client.search(word, { types: ["Story", "Defect", "Issue"], sort: ["ID"], page: { size: 2, start: 2 } });
    expect([last.rows.map((r) => r._oid), last.total, last.more]).toEqual([[issue], 3, false]);
    // The defect was closed in beforeAll: a filter as written, and a where carried as a variable.
    expect((await client.search(word, { types: SIXTEEN, filter: ["AssetState!='Closed'"], sort: ["ID"], page })).rows.map((r) => r._oid)).toEqual([story, issue]);
    expect((await client.search(word, { types: SIXTEEN, where: { AssetType: "Defect" }, page })).rows.map((r) => r._oid)).toEqual([defect]);
    // A term on an attribute only some types have is type-qualified by the caller, and an OR across two of them works.
    expect((await client.search(word, { types: SIXTEEN, filter: ["(Workitem.Number=$n|Issue.Number=$n)"], with: { $n: issueNumber }, page })).rows.map((r) => r._oid)).toEqual([issue]);
  });

  it("client.search with one type reads that type; a notification that names the word is never a row, because only the types asked for are", async () => {
    const one = await client.search(word, { types: ["Issue"], select: ["Name", "Number", "Owner"], page });
    expect(one.rows).toEqual([{ _oid: issue, Name: expect.stringContaining(word), Number: issueNumber, Owner: null }]);
    expect((await client.search(word, { types: SIXTEEN, findin: ["Name"], page })).rows.every((r) => !r._oid.startsWith("Message:"))).toBe(true);
  });

  it("client.search refuses, before any search is sent: no text, no types, an abstract type, an unknown type, a name no type defines", async () => {
    const refused = async (run: () => Promise<unknown>, message: RegExp) => {
      const before = requests.filter((r) => r.path.startsWith("/rest-1.v1")).length;
      await expect(run()).rejects.toMatchObject({ kind: "usage", status: 0, message: expect.stringMatching(message) });
      expect(requests.filter((r) => r.path.startsWith("/rest-1.v1")).length).toBe(before);
    };
    await refused(() => client.search(" ", { types: ["Story"], page }), /needs text/);
    await refused(() => client.search(word, { types: [], page }), /needs `types`/);
    await refused(() => client.search(word, { types: ["Workitem"], page }), /abstract type/);
    await refused(() => client.search(word, { types: ["NoSuchType"], page }), /no asset type "NoSuchType"/);
    await refused(() => client.search(word, { types: ["Story", "Issue"], select: ["Name", "Nmae"], page }), /"Nmae" is not an attribute of any type searched \(Story, Issue\)/);
  });

  it("client.deleted answers deleted assets only, each saying Deleted", async () => {
    const both = await client.deleted("Story", { filter: ["ID=$ids"], with: { $ids: [story, gone] }, select: ["Name", "AssetState"], page });
    expect(both.rows.map((r) => [r._oid, r.AssetState])).toEqual([[gone, "Deleted"]]);
    expect(both.total).toBe(1);
  });
});

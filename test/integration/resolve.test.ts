import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * resolve against a real instance. Brings its own data: a Story (resolved
 * through the Workitem root) and an Issue (a root of its own), deleted
 * afterwards by exact OID.
 */
describeInstance("resolve (live)", () => {
  const t = instance!.transport;
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: t });
  const created: string[] = [];
  let story = { oid: "", number: "" }, issue = { oid: "", number: "" };

  beforeAll(async () => {
    const res = await assetApi.send(t, [
      { "@s": { AssetType: "Story", Name: fixtureName("resolve story"), Scope: { _oid: "Scope:0" } } },
      { "@i": { AssetType: "Issue", Name: fixtureName("resolve issue"), Scope: { _oid: "Scope:0" } } },
      { from: "@s", select: ["Number"] },
      { from: "@i", select: ["Number"] }
    ], { throwOnFailure: true });
    created.push(...res.assetsCreated.oidTokens.map(assetApi.momentless));
    const [srows, irows] = res.queryResult.results as unknown as { _oid: string; Number: string }[][];
    const s = srows![0], i = irows![0];
    story = { oid: assetApi.momentless(s!._oid), number: s!.Number };
    issue = { oid: assetApi.momentless(i!._oid), number: i!.Number };
  });
  afterAll(async () => {
    for (const oid of created) await assetApi.send(t, [{ from: oid, execute: "Delete" }]);
  });

  it("one request resolves a workitem's number and another root's, case-insensitively, and reports the number nothing has as missing — the expect-zero control", async () => {
    const res = await client.resolve.numbers([story.number.toLowerCase(), issue.number, "S-999999999"]);
    expect(res.found).toEqual([
      { _oid: story.oid, AssetType: "Story", Number: story.number, Name: expect.stringContaining("resolve story"), AssetState: "Active" },
      { _oid: issue.oid, AssetType: "Issue", Number: issue.number, Name: expect.stringContaining("resolve issue"), AssetState: "Active" }
    ]);
    expect(res.missing).toEqual(["S-999999999"]);
  });

  it("ref resolves a number, and takes an OID token as given", async () => {
    expect(await client.resolve.ref(issue.number)).toMatchObject({ _oid: issue.oid, AssetType: "Issue" });
    expect(await client.resolve.ref(story.oid)).toMatchObject({ _oid: story.oid, Number: null });
    expect(await client.resolve.ref("I-999999999")).toBeNull();
  });

  it("refs reads numbers and OID tokens mixed, in the order first asked, in two requests; an asset named twice is found once; what names nothing is missing", async () => {
    const calls: string[] = [];
    const counting = new AgilityApiClient({ baseUrl: instance!.url }, { transport: { request: (o) => { if (!o.path.startsWith("/meta.v1")) calls.push(o.path); return t.request(o); } }, types: client.schema.cache });
    await counting.schema.load("Story"); await counting.schema.load("Issue"); await counting.schema.load("Member");
    const me = await client.me();
    calls.length = 0;
    const res = await counting.resolve.refs([issue.oid, story.number.toLowerCase(), me._oid, "Story:999999999", "S-999999999", `${story.oid}:1`]);
    expect(calls).toEqual(["/api/asset", "/api/asset"]);
    expect(res.found).toEqual([
      { _oid: issue.oid, AssetType: "Issue", Number: issue.number, Name: expect.stringContaining("resolve issue"), AssetState: "Active" },
      { _oid: story.oid, AssetType: "Story", Number: story.number, Name: expect.stringContaining("resolve story"), AssetState: "Active" },
      { _oid: me._oid, AssetType: "Member", Number: null, Name: me.Name, AssetState: "Active" } // a Member has no Number: not asked for, so the query is not refused
    ]); // the story was asked for twice, by its number and by its OID: one asset, found once
    expect(res.missing).toEqual(["Story:999999999", "S-999999999"]);
  });
});

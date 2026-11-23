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
      { number: story.number, oid: story.oid, type: "Story", name: expect.stringContaining("resolve story"), assetState: "Active" },
      { number: issue.number, oid: issue.oid, type: "Issue", name: expect.stringContaining("resolve issue"), assetState: "Active" }
    ]);
    expect(res.missing).toEqual(["S-999999999"]);
  });

  it("ref resolves a number, and takes an OID token as given", async () => {
    expect(await client.resolve.ref(issue.number)).toMatchObject({ oid: issue.oid, type: "Issue" });
    expect(await client.resolve.ref(story.oid)).toMatchObject({ oid: story.oid, number: null });
    expect(await client.resolve.ref("I-999999999")).toBeNull();
  });
});

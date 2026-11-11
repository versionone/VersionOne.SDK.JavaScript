import { afterAll, beforeAll, expect, it } from "vitest";
import { sendGuarded } from "../../src/services/guard";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * The guard against a real instance. Brings its own two Stories (deleted
 * afterwards by exact OID): one changed by "someone else" between the
 * preview and the send, one not. What only the server can prove: that the
 * projection's add/remove form for a scalar applies in a real update, that
 * a ChangeDate literal is a true compare-and-set (and a Moment is not, for a
 * query or for a write), and
 * that a stale guard writes nothing.
 */
describeInstance("guard (live)", () => {
  const t = instance!.transport;
  const created: string[] = [];
  let a = "", b = "";
  const estimate = async (oid: string) => (await assetApi.query<{ _oid: string; Estimate: string }>(t, { from: oid, select: ["Estimate"], page: { size: 1, start: 0 } }))[0]!.Estimate;

  beforeAll(async () => {
    const res = await assetApi.send(t, [
      { AssetType: "Story", Name: fixtureName("guard a"), Scope: { _oid: "Scope:0" }, Estimate: 1 },
      { AssetType: "Story", Name: fixtureName("guard b"), Scope: { _oid: "Scope:0" }, Estimate: 1 }
    ], { throwOnFailure: true });
    [a, b] = res.assetsCreated.oidTokens.map(assetApi.momentless) as [string, string];
    created.push(a, b);
  });
  afterAll(async () => { for (const oid of created) await assetApi.send(t, [{ from: oid, execute: "Delete" }]); });

  it("an unchanged asset is updated; one changed after it was read is skipped and keeps the other writer's change", async () => {
    // Simulate the race: wrap the transport so "someone else" edits b right after the Moments are read.
    let reads = 0;
    const racing = { request: async <T,>(o: Parameters<typeof t.request>[0]) => {
      const r = await t.request<T>(o);
      const body = o.body as { select?: string[] }[] | undefined;
      if (Array.isArray(body) && body[0]?.select?.[0] === "ChangeDate" && reads++ === 0) await assetApi.send(t, [{ from: b, update: { Estimate: 7 } }], { throwOnFailure: true });
      return r;
    } };
    const res = await sendGuarded(racing, [{ from: "Story", filter: ["ID=$ids"], with: { $ids: [a, b] }, update: { Estimate: 5 } }]);
    expect(res.touched.sort()).toEqual([a, b].sort());
    expect(res.skipped).toEqual([b]);
    expect(res.outcome.modified).toEqual([a]);
    expect(await estimate(a)).toBe("5");
    expect(await estimate(b)).toBe("7");
  });

  it("sending the same guarded batch twice applies once: the first send advances the ChangeDate the second was stamped with", async () => {
    const first = await sendGuarded(t, [{ from: a, update: { Estimate: 8 } }]);
    const second = await assetApi.send(t, first.sent);
    expect(first.outcome.modified).toEqual([a]);
    expect(second.assetsModified.count).toBe(0);
    expect(await estimate(a)).toBe("8");
  });

  it("why not Moment: a filter on an earlier Moment of the asset selects it as it was then, so it cannot tell stale from current", async () => {
    const [then] = await assetApi.query<{ _oid: string; Moment: string }>(t, { from: a, select: ["Moment"], page: { size: 1, start: 0 } });
    await assetApi.send(t, [{ from: a, update: { Estimate: 9 } }], { throwOnFailure: true });
    const asOf = await assetApi.query<{ _oid: string; Estimate: string }>(t, { from: "Story", select: ["Estimate"], filter: ["ID=$oid", "Moment=$m"], with: { $oid: a, $m: then!.Moment }, page: { size: 1, start: 0 } });
    expect(asOf).toHaveLength(1); // stale, yet it matches —
    expect(asOf[0]!.Estimate).toBe("8"); // — as the asset was at that moment
  });

  it("why not Moment, on a write: an update filtered on a stale Moment previews as one command and applies, while a stale ChangeDate literal applies nothing", async () => {
    // Its own Story, so the result doesn't depend on what the tests above did to a and b.
    const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName("guard moment write"), Scope: { _oid: "Scope:0" }, Estimate: 1 }], { throwOnFailure: true });
    const s = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
    created.push(s);
    const [before] = await assetApi.query<{ _oid: string; Moment: string; ChangeDate: string }>(t, { from: s, select: ["Moment", "ChangeDate"], page: { size: 1, start: 0 } });
    await assetApi.send(t, [{ from: s, update: { Estimate: 2 } }], { throwOnFailure: true }); // "someone else" changes it
    expect(await estimate(s)).toBe("2");

    // Stale Moment, as a literal: the projection still has the asset, and the write lands on the current one.
    const staleMoment = [{ from: "Story", filter: ["ID=$oid", `Moment='${before!.Moment}'`], with: { $oid: s }, update: { Estimate: 7 } }];
    expect(await assetApi.preview(t, staleMoment)).toHaveLength(1);
    const sent = await assetApi.send(t, staleMoment);
    expect(sent.assetsModified.oidTokens.map(assetApi.momentless)).toEqual([s]);
    expect(await estimate(s)).toBe("7"); // the other writer's 2 is overwritten: Moment guards nothing

    // Stale ChangeDate, as a literal (what guard.ts sends): matches nothing, so nothing is applied.
    const staleStamp = [{ from: "Story", filter: ["ID=$oid", `ChangeDate='${before!.ChangeDate}'`], with: { $oid: s }, update: { Estimate: 9 } }];
    expect(await assetApi.preview(t, staleStamp)).toEqual([]);
    expect((await assetApi.send(t, staleStamp)).assetsModified.count).toBe(0);
    expect(await estimate(s)).toBe("7");
  });
});

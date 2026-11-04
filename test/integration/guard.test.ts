import { afterAll, beforeAll, expect, it } from "vitest";
import { sendGuarded } from "../../src/services/guard";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * The guard against a real instance. Brings its own two Stories (deleted
 * afterwards by exact OID): one changed by "someone else" between the
 * preview and the send, one not. What only the server can prove: that the
 * projection's add/remove form for a scalar applies in a real update, that
 * a ChangeDate literal is a true compare-and-set (and a Moment is not), and
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
});

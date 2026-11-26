import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, sendGuarded } from "../../src/services/guard";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * The guard against a real instance. Brings its own Stories (deleted
 * afterwards by exact OID). What only the server can prove: that an
 * asset's Moment together with RetireDateUTC='' is a true compare-and-set
 * (and a Moment alone is not), that a stale guard writes nothing while a
 * no-op that matched is a success, that a moment the caller read earlier
 * guards against everything since, and what the guard cannot see.
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

  it("an unchanged asset is updated; one changed after it was read is a conflict and keeps the other writer's change", async () => {
    // Simulate the race: wrap the transport so "someone else" edits b right after the Moments are read.
    let reads = 0;
    const racing = { request: async <T,>(o: Parameters<typeof t.request>[0]) => {
      const r = await t.request<T>(o);
      const body = o.body as { select?: string[] }[] | undefined;
      if (Array.isArray(body) && body[0]?.select?.[0] === "Moment" && reads++ === 0) await assetApi.send(t, [{ from: b, update: { Estimate: 7 } }], { throwOnFailure: true });
      return r;
    } };
    const res = await sendGuarded(racing, [{ from: "Story", filter: ["ID=$ids"], with: { $ids: [a, b] }, update: { Estimate: 5 } }]);
    expect(res.touched.sort()).toEqual([a, b].sort());
    expect(res.conflicts).toEqual([b]);
    expect(res.modified).toEqual([a]);
    expect(res.failures).toEqual([]);
    expect(await estimate(a)).toBe("5");
    expect(await estimate(b)).toBe("7");
  });

  it("sending the same guarded batch twice applies once: the first send advances the Moment the second was stamped with", async () => {
    const first = await sendGuarded(t, [{ from: a, update: { Estimate: 8 } }]);
    const second = await assetApi.send(t, first.details.sent);
    expect(first.modified).toEqual([a]);
    expect(first.conflicts).toEqual([]);
    expect(first.requestId).toEqual(expect.any(String));
    expect(second.assetsModified.count).toBe(0);
    expect(await estimate(a)).toBe("8");
  });

  it("a guarded update that changes nothing matched, so it is a success and not a conflict; sent again it is still a success", async () => {
    const same = await estimate(a);
    for (let i = 0; i < 2; i += 1) {
      const res = await sendGuarded(t, [{ from: a, update: { Estimate: Number(same) } }]);
      expect(res.modified).toEqual([a]);
      expect(res.conflicts).toEqual([]);
    }
    expect(await estimate(a)).toBe(same);
  });

  it("a moment the caller read earlier guards against everything since: stale is a conflict (thrown when asked), current applies", async () => {
    const [seen] = await assetApi.query<{ _oid: string; Moment: string }>(t, { from: b, select: ["Moment"], page: { size: 1, start: 0 } });
    await assetApi.send(t, [{ from: b, update: { Estimate: 11 } }], { throwOnFailure: true }); // someone else, after the row was shown
    const stale = await sendGuarded(t, [{ from: b, update: { Estimate: 12 } }], { moments: { [b]: seen!.Moment } });
    expect(stale).toMatchObject({ modified: [], conflicts: [b], details: { stamps: { [b]: seen!.Moment } } });
    expect(await estimate(b)).toBe("11");
    const thrown = (await sendGuarded(t, [{ from: b, update: { Estimate: 12 } }], { moments: { [b]: seen!.Moment }, throwOnFailure: true }).catch((e: unknown) => e)) as ConflictError;
    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown).toMatchObject({ kind: "conflict", conflicts: [b] });
    const [now] = await assetApi.query<{ _oid: string; Moment: string }>(t, { from: b, select: ["Moment"], page: { size: 1, start: 0 } });
    const fresh = await sendGuarded(t, [{ from: b, update: { Estimate: 12 } }], { moments: { [b]: now!.Moment }, throwOnFailure: true });
    expect(fresh).toMatchObject({ modified: [b], conflicts: [] });
    expect(await estimate(b)).toBe("12");
  });

  it("operations are guarded the same way, a closed asset included; a deleted asset is a conflict", async () => {
    const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName("guard ops"), Scope: { _oid: "Scope:0" } }], { throwOnFailure: true });
    const s = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
    created.push(s);
    const [open] = await assetApi.query<{ _oid: string; Moment: string }>(t, { from: s, select: ["Moment"], page: { size: 1, start: 0 } });
    expect(await sendGuarded(t, [{ from: s, execute: "QuickClose" }])).toMatchObject({ operated: [s], conflicts: [] });
    // The moment from before the close is stale now: reactivating on it does nothing.
    expect(await sendGuarded(t, [{ from: s, execute: "Reactivate" }], { moments: { [s]: open!.Moment } })).toMatchObject({ operated: [], conflicts: [s] });
    expect(await sendGuarded(t, [{ from: s, execute: "Reactivate" }])).toMatchObject({ operated: [s], conflicts: [] });
    const [last] = await assetApi.query<{ _oid: string; Moment: string }>(t, { from: s, select: ["Moment"], page: { size: 1, start: 0 } });
    await assetApi.send(t, [{ from: s, execute: "Delete" }], { throwOnFailure: true });
    // Guarded on its last moment before the delete, by a command that still names it: nothing matches.
    const gone = await assetApi.send(t, [{ from: "Story", where: { ID: "$oid", Moment: "$moment" }, filter: ["RetireDateUTC=''"], with: { $oid: s, $moment: last!.Moment }, update: { Name: "x" } }]);
    expect(gone.assetsModified.count).toBe(0);
    expect(gone.commandFailures.count).toBe(0);
  });

  it("why both terms: a Moment alone selects the asset as it was, and a write scoped by it lands on the current asset; with RetireDateUTC='' a stale moment matches nothing", async () => {
    // Its own Story, so the result doesn't depend on what the tests above did to a and b.
    const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName("guard moment write"), Scope: { _oid: "Scope:0" }, Estimate: 1 }], { throwOnFailure: true });
    const s = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
    created.push(s);
    const [before] = await assetApi.query<{ _oid: string; Moment: string }>(t, { from: s, select: ["Moment"], page: { size: 1, start: 0 } });
    await assetApi.send(t, [{ from: s, update: { Estimate: 2 } }], { throwOnFailure: true }); // "someone else" changes it
    const at = { from: "Story", where: { ID: "$oid", Moment: "$moment" }, with: { $oid: s, $moment: before!.Moment } };

    // The control: the stale moment alone still selects a row — the old version — and its RetireDateUTC is set.
    const asOf = await assetApi.query<{ _oid: string; Estimate: string; RetireDateUTC: string | null }>(t, { ...at, select: ["Estimate", "RetireDateUTC"], page: { size: 2, start: 0 } });
    expect(asOf).toHaveLength(1);
    expect(asOf[0]!.Estimate).toBe("1");
    expect(asOf[0]!.RetireDateUTC).toEqual(expect.any(String));
    // With the filter: zero rows, an empty projection, nothing written.
    const guarded = { ...at, filter: ["RetireDateUTC=''"] };
    expect(await assetApi.query(t, { ...guarded, select: ["Estimate"], page: { size: 2, start: 0 } })).toEqual([]);
    expect(await assetApi.preview(t, [{ ...guarded, update: { Estimate: 9 } }])).toEqual([]);
    expect((await assetApi.send(t, [{ ...guarded, update: { Estimate: 9 } }])).assetsModified.count).toBe(0);
    expect(await estimate(s)).toBe("2");
    // Without it, the same stale moment previews as one command and overwrites the other writer's change.
    expect(await assetApi.preview(t, [{ ...at, update: { Estimate: 7 } }])).toHaveLength(1);
    expect((await assetApi.send(t, [{ ...at, update: { Estimate: 7 } }])).assetsModified.oidTokens.map(assetApi.momentless)).toEqual([s]);
    expect(await estimate(s)).toBe("7");
  });

  it("the blind spot: a child added to an asset makes no new version of it, so a guard on the earlier moment still applies", async () => {
    const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName("guard blind spot"), Scope: { _oid: "Scope:0" }, Estimate: 1 }], { throwOnFailure: true });
    const s = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
    created.push(s);
    const read = async () => (await assetApi.query<{ _oid: string; Moment: string; "Children.@Count": string }>(t, { from: s, select: ["Moment", "Children.@Count"], page: { size: 1, start: 0 } }))[0]!;
    const before = await read();
    const task = await assetApi.send(t, [{ AssetType: "Task", Name: fixtureName("guard blind spot task"), Parent: s }], { throwOnFailure: true });
    created.unshift(assetApi.momentless(task.assetsCreated.oidTokens[0]!)); // deleted before its Story
    const after = await read();
    expect([before["Children.@Count"], after["Children.@Count"]]).toEqual(["0", "1"]);
    expect(after.Moment).toBe(before.Moment);
    expect(await sendGuarded(t, [{ from: s, update: { Estimate: 2 } }], { moments: { [s]: before.Moment } })).toMatchObject({ modified: [s], conflicts: [] });
  });
});

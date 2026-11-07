import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * batch against a real instance, round trip: a batch that updates two
 * Stories (a scalar and a multi-value relation) and creates a Task, its
 * receipt, and its reverse sent back through the same pipeline — after
 * which the Stories are as they were and the Task is gone. Brings its own
 * Stories; deletes everything it made by exact OID.
 */
describeInstance("batch (live)", () => {
  const t = instance!.transport;
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: t });
  const created: string[] = [];
  let a = "", b = "", me = "";
  const read = async (oid: string) => (await assetApi.query<{ _oid: string; Estimate: string | null; Owners: { _oid: string }[] }>(t, { from: oid, select: ["Estimate", "Owners"], page: { size: 1, start: 0 } }))[0]!;

  beforeAll(async () => {
    me = (await assetApi.query(t, { from: "Member", select: ["Name"], where: { IsSelf: "true" }, page: { size: 1, start: 0 } }))[0]!._oid;
    const res = await assetApi.send(t, [
      { AssetType: "Story", Name: fixtureName("batch a"), Scope: { _oid: "Scope:0" }, Estimate: 1 },
      { AssetType: "Story", Name: fixtureName("batch b"), Scope: { _oid: "Scope:0" } }
    ], { throwOnFailure: true });
    [a, b] = res.assetsCreated.oidTokens.map(assetApi.momentless) as [string, string];
    created.push(a, b);
  });
  afterAll(async () => {
    for (const oid of created) await assetApi.send(t, [{ from: oid, execute: "Delete" }]);
  });

  it("a guarded batch's receipt names what it created and touched, and its reverse puts everything back", async () => {
    const receipt = await client.batch.run([
      { from: "Story", filter: ["ID=$ids"], with: { $ids: [a, b] }, update: { Estimate: 5, Owners: { add: [{ _oid: me }] } } },
      { "@t": { AssetType: "Task", Name: fixtureName("batch task"), Parent: { _oid: a } } }
    ]);
    const task = receipt.created[0]!;
    created.push(task.oid);
    expect(receipt.sent && receipt.guarded).toBe(true);
    expect(receipt.outcome!.failures).toEqual([]);
    expect(receipt.skipped).toEqual([]);
    expect(task).toMatchObject({ alias: "@t", type: "Task", number: expect.stringMatching(/-\d+$/) });
    expect(receipt.touched.map((x) => x.oid).sort()).toEqual([a, b].sort());
    expect(receipt.before[a]).toMatchObject({ Estimate: "1", Owners: [] });
    expect(receipt.before[b]).toMatchObject({ Estimate: null, Owners: [] });
    expect(Object.keys(receipt.after).sort()).toEqual([a, b, task.oid].sort());
    expect((await read(a)).Estimate).toBe("5");

    const { commands, drifted } = await client.batch.reversible(receipt);
    expect(drifted).toEqual([]);
    const undone = await client.batch.run(commands);
    expect(undone.outcome!.failures).toEqual([]);
    expect(await read(a)).toMatchObject({ Estimate: "1", Owners: [] });
    expect(await read(b)).toMatchObject({ Estimate: null, Owners: [] });
    const [gone] = await assetApi.query<{ _oid: string; AssetState: string }>(t, { from: task.oid, select: ["AssetState"], page: { size: 1, start: 0 } });
    expect(gone?.AssetState ?? "Deleted").toMatch(/Dead|Deleted/);
  });

  it("a reverse skips an asset someone changed since the batch, unless forced", async () => {
    const receipt = await client.batch.run([{ from: b, update: { Estimate: 2 } }]);
    await assetApi.send(t, [{ from: b, update: { Estimate: 3 } }], { throwOnFailure: true }); // someone else
    const { commands, drifted } = await client.batch.reversible(receipt);
    expect(drifted.map((d) => d.oid)).toEqual([b]);
    expect(commands).toEqual([]);
    expect((await client.batch.reversible(receipt, { force: true })).commands).toEqual([{ from: b, update: { Estimate: null } }]);
  });
  it("a batch of only an aliased execute, sent with guard off, really runs, and its receipt names the asset (gh-v1 apply's case)", async () => {
    // Its own Story, so the round trip leaves a and b alone.
    const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName("batch aliased"), Scope: { _oid: "Scope:0" } }], { throwOnFailure: true });
    const story = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
    created.push(story);
    const receipt = await client.batch.run([{ "@close": { from: story, execute: "QuickClose" } }], { guard: false });
    expect(receipt.sent).toBe(true);
    expect(receipt.outcome!.failures).toEqual([]);
    expect(receipt.described.deferred).toEqual([{ index: 0, alias: "@close", from: story, kind: "execute" }]);
    expect(receipt.touched).toEqual([expect.objectContaining({ oid: story, name: expect.stringContaining("batch aliased") })]);
    expect(receipt.after[story]).toMatch(/^\d{4}-/);
    const [row] = await assetApi.query<{ _oid: string; AssetState: string }>(t, { from: story, select: ["AssetState"], page: { size: 1, start: 0 } });
    expect(row!.AssetState).toBe("Closed");
  });
  it("undoing a batch whose created asset was closed since reactivates it first, then deletes it (Agility refuses to delete a closed asset)", async () => {
    const receipt = await client.batch.run([{ "@s": { AssetType: "Story", Name: fixtureName("batch undo closed"), Scope: { _oid: "Scope:0" } } }]);
    const story = receipt.created[0]!.oid;
    created.push(story);
    await assetApi.send(t, [{ from: story, execute: "QuickClose" }], { throwOnFailure: true });
    // Closing it changed it since the batch, so the reverse is forced.
    const undo = await client.batch.reversible(receipt, { force: true });
    expect(undo.reactivated).toEqual([story]);
    expect(undo.commands).toEqual([{ from: story, execute: "Reactivate" }, { from: story, execute: "Delete" }]);
    const reversed = await client.batch.run(undo.commands);
    expect(reversed.outcome!.failures).toEqual([]);
    expect(reversed.skipped).toEqual([]);
    expect(await assetApi.query(t, { from: "Story", select: ["Name"], filter: ["ID=$s"], with: { $s: story }, page: { size: 1, start: 0 } })).toEqual([]);
  });
});

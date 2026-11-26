import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { assetApi } from "../../src/wire";
import { deleteFixtures, describeInstance, fixtureName, instance, sendFixtures } from "./instance";

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
    const res = await sendFixtures(t, [
      { AssetType: "Story", Name: fixtureName("batch a"), Scope: { _oid: "Scope:0" }, Estimate: 1 },
      { AssetType: "Story", Name: fixtureName("batch b"), Scope: { _oid: "Scope:0" } }
    ]);
    [a, b] = res.assetsCreated.oidTokens.map(assetApi.momentless) as [string, string];
    created.push(a, b);
  });
  afterAll(async () => {
    await deleteFixtures(t, created);
  });

  it("a guarded batch's receipt names what it created and touched, and its reverse puts everything back", async () => {
    const receipt = await client.batch.run([
      { from: "Story", filter: ["ID=$ids"], with: { $ids: [a, b] }, update: { Estimate: 5, Owners: { add: [{ _oid: me }] } } },
      { "@t": { AssetType: "Task", Name: fixtureName("batch task"), Parent: { _oid: a } } }
    ], { guard: true });
    const task = receipt.created[0]!;
    created.push(task._oid);
    expect(receipt.sent && receipt.guarded).toBe(true);
    expect(receipt.outcome!.failures).toEqual([]);
    expect(receipt.conflicts).toEqual([]);
    expect(task).toMatchObject({ alias: "@t", AssetType: "Task", Number: expect.stringMatching(/-\d+$/) });
    expect(receipt.touched.map((x) => x._oid).sort()).toEqual([a, b].sort());
    expect(receipt.before[a]).toMatchObject({ Estimate: "1", Owners: [] });
    expect(receipt.before[b]).toMatchObject({ Estimate: null, Owners: [] });
    expect(Object.keys(receipt.after).sort()).toEqual([a, b, task._oid].sort());
    // Stamps are Moments: digits, guarded on the snapshot's, advanced by the batch; the readable time rides beside.
    expect(receipt).toMatchObject({ receipt: 2, stopped: null });
    for (const oid of [a, b]) {
      expect(receipt.stamps[oid]).toMatch(/^\d+$/);
      expect(Number(receipt.after[oid])).toBeGreaterThan(Number(receipt.stamps[oid]));
      expect(receipt.changedAt[oid]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(receipt.outcome!.requestId).toEqual(expect.any(String));
    expect((await read(a)).Estimate).toBe("5");

    const { commands, drifted } = await client.batch.reversible(receipt);
    expect(drifted).toEqual([]);
    const undone = await client.batch.run(commands, { guard: true });
    expect(undone.outcome!.failures).toEqual([]);
    expect(await read(a)).toMatchObject({ Estimate: "1", Owners: [] });
    expect(await read(b)).toMatchObject({ Estimate: null, Owners: [] });
    const [gone] = await assetApi.query<{ _oid: string; AssetState: string }>(t, { from: task._oid, select: ["AssetState"], page: { size: 1, start: 0 } });
    expect(gone?.AssetState ?? "Deleted").toMatch(/Dead|Deleted/);
  });

  it("a reverse skips an asset someone changed since the batch, unless forced", async () => {
    const receipt = await client.batch.run([{ from: b, update: { Estimate: 2 } }], { guard: true });
    await assetApi.send(t, [{ from: b, update: { Estimate: 3 } }], { throwOnFailure: true }); // someone else
    const { commands, drifted } = await client.batch.reversible(receipt);
    expect(drifted.map((d) => d.oid)).toEqual([b]);
    expect(commands).toEqual([]);
    expect((await client.batch.reversible(receipt, { force: true })).commands).toEqual([{ from: b, update: { Estimate: null } }]);
  });
  it("a batch of only an aliased execute, sent with guard off, really runs, and its receipt names the asset (the CLI consumer's apply case)", async () => {
    // Its own Story, so the round trip leaves a and b alone.
    const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName("batch aliased"), Scope: { _oid: "Scope:0" } }], { throwOnFailure: true });
    const story = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
    created.push(story);
    const receipt = await client.batch.run([{ "@close": { from: story, execute: "QuickClose" } }], { guard: false });
    expect(receipt.sent).toBe(true);
    expect(receipt.outcome!.failures).toEqual([]);
    expect(receipt.described.deferred).toEqual([{ index: 0, alias: "@close", from: story, kind: "execute" }]);
    expect(receipt.touched).toEqual([expect.objectContaining({ _oid: story, AssetType: "Story", Name: expect.stringContaining("batch aliased") })]);
    expect(receipt.after[story]).toMatch(/^\d+$/);
    expect(receipt.changedAt[story]).toMatch(/^\d{4}-/);
    const [row] = await assetApi.query<{ _oid: string; AssetState: string }>(t, { from: story, select: ["AssetState"], page: { size: 1, start: 0 } });
    expect(row!.AssetState).toBe("Closed");
  });
  it("undoing a batch whose created asset was closed since reactivates it first, then deletes it (Agility refuses to delete a closed asset)", async () => {
    const receipt = await client.batch.run([{ "@s": { AssetType: "Story", Name: fixtureName("batch undo closed"), Scope: { _oid: "Scope:0" } } }], { guard: true });
    const story = receipt.created[0]!._oid;
    created.push(story);
    await assetApi.send(t, [{ from: story, execute: "QuickClose" }], { throwOnFailure: true });
    // Closing it changed it since the batch, so the reverse is forced.
    const undo = await client.batch.reversible(receipt, { force: true });
    expect(undo.reactivated).toEqual([story]);
    expect(undo.commands).toEqual([{ from: story, execute: "Reactivate" }, { from: story, execute: "Delete" }]);
    const reversed = await client.batch.run(undo.commands, { guard: true });
    expect(reversed.outcome!.failures).toEqual([]);
    expect(reversed.conflicts).toEqual([]);
    expect(await assetApi.query(t, { from: "Story", select: ["Name"], filter: ["ID=$s"], with: { $s: story }, page: { size: 1, start: 0 } })).toEqual([]);
  });

  const stateOf = async (oid: string) => (await assetApi.query<{ _oid: string; AssetState: string }>(t, { from: oid, select: ["AssetState"], page: { size: 1, start: 0 } }))[0]?.AssetState;

  for (const op of ["Inactivate", "QuickClose"] as const) {
    it(`undoing ${op} on a Story reopens the Story and the open Tasks its close cascaded to, and leaves a Task that was closed before alone (a CLI consumer finding)`, async () => {
      const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName(`cascade ${op}`), Scope: { _oid: "Scope:0" } }], { throwOnFailure: true });
      const story = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
      created.push(story);
      const tasks = await sendFixtures(t, [
        { AssetType: "Task", Name: fixtureName("cascade open"), Parent: { _oid: story } },
        { AssetType: "Task", Name: fixtureName("cascade closed before"), Parent: { _oid: story } }
      ]);
      const [open, closedBefore] = tasks.assetsCreated.oidTokens.map(assetApi.momentless) as [string, string];
      created.push(open, closedBefore);
      await assetApi.send(t, [{ from: closedBefore, execute: "QuickClose" }], { throwOnFailure: true });

      const receipt = await client.batch.run([{ from: story, execute: op }], { guard: true });
      expect(receipt.outcome!.failures).toEqual([]);
      expect(receipt.openDescendants).toEqual({ [story]: [open] });
      expect(await stateOf(open)).toBe("Closed"); // the server's cascade, which the receipt must undo
      expect(receipt.cascaded).toEqual({ [story]: [open] });
      expect(receipt.reverse.commands).toEqual([{ from: story, execute: "Reactivate" }, { from: open, execute: "Reactivate" }]);

      const { commands, drifted } = await client.batch.reversible(receipt);
      expect(drifted).toEqual([]);
      const undone = await client.batch.run(commands, { guard: true });
      expect(undone.outcome!.failures).toEqual([]);
      expect(undone.conflicts).toEqual([]);
      expect(await stateOf(story)).toBe("Active");
      expect(await stateOf(open)).toBe("Active");
      expect(await stateOf(closedBefore)).toBe("Closed");
    });
  }

  it("a created Conversation is left out of the reverse with a note, and undoing the batch deletes its Expression without a failure (a CLI consumer finding)", async () => {
    const receipt = await client.batch.run([
      { "@c": { AssetType: "Conversation" } },
      { "@e": { AssetType: "Expression", BelongsTo: "@c", Content: fixtureName("reverse conversation") } }
    ], { guard: true });
    expect(receipt.outcome!.failures).toEqual([]);
    const [conversation, expression] = [receipt.created[0]!._oid, receipt.created[1]!._oid];
    expect(conversation).toMatch(/^Conversation:/);
    expect(receipt.reverse.commands).toEqual([{ from: expression, execute: "Delete" }]);
    expect(receipt.reverse.notes.join("\n")).toMatch(new RegExp(`${conversation}: Conversation has no Delete operation`));
    const undone = await client.batch.run((await client.batch.reversible(receipt)).commands, { guard: true });
    expect(undone.outcome!.failures).toEqual([]);
    expect(undone.failed).toEqual([]);
    expect(await assetApi.query(t, { from: "Expression", select: ["Content"], filter: ["ID=$e"], with: { $e: expression }, page: { size: 1, start: 0 } })).toEqual([]);
  });
});

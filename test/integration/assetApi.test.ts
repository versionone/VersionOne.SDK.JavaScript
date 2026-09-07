import { afterAll, expect, it } from "vitest";
import type { Member } from "../../src/types/assets/Member";
import type { Story } from "../../src/types/assets/Story";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * The api/asset wire module against a real instance: what the fakes cannot
 * prove. Creates its own Story under Scope:0, reads it back, and deletes it.
 */
describeInstance("assetApi (live)", () => {
  const t = instance!.transport;
  const name = fixtureName("story");
  const created: string[] = [];
  afterAll(async () => {
    if (!created.length) return;
    await assetApi.send(t, created.map((oid) => ({ from: oid, execute: "Delete" })));
  });

  it("a create with a Ref relation is written as an OID token, the read-back speaks the model's shape, and results are positional", async () => {
    // Scope as a Ref in the model; the wire writes "Scope:0". Owners as a Ref list.
    const [me] = await assetApi.query<Member>(t, { from: "Member", select: ["Name"], filter: ["IsSelf='true'"], page: { size: 1, start: 0 } });
    expect(me?._oid).toMatch(/^Member:\d+$/);
    const res = await assetApi.send<Story>(t, [
      { "@story": { AssetType: "Story", Name: name, Scope: { _oid: "Scope:0" }, Owners: [{ _oid: me!._oid }] } },
      { "@check": { from: "@story", select: ["Name", "Number", "Scope", "Owners", "Owners.Name", "AssetState", "Estimate"] } }
    ]);
    created.push(...res.assetsCreated.oidTokens.map(assetApi.momentless));
    expect(res.commandFailures.count).toBe(0);
    expect(res.assetsCreated.oidTokens).toHaveLength(1);
    const [row] = res.queryResult.results[0]!;
    expect(row).toBeDefined();
    expect(row!._oid).toBe(assetApi.momentless(res.assetsCreated.oidTokens[0]!));
    expect(row!.Name).toBe(name);
    expect(row!.Number).toMatch(/^S-\d+$/);
    expect(row!.Scope).toEqual({ _oid: "Scope:0" });
    expect(row!.Owners).toEqual([{ _oid: me!._oid }]);
    expect((row as unknown as Record<string, unknown>)["Owners.Name"]).toEqual([me!.Name]);
    expect(row!.Estimate).toBeNull(); // an unset scalar reads back as null, which is why the model types it | null
  });

  it("several queries in one request come back one array per query, in order, with [] for an empty match — the expect-zero control", async () => {
    const [mine, none] = await assetApi.queries<Story>(t, [
      { from: "Story", select: ["Name"], filter: [`Name='${name.replace(/'/g, "\\'")}'`], page: { size: 2, start: 0 } },
      { from: "Story", select: ["Name"], filter: ["Name='zzqqxx-no-such-story'"], page: { size: 2, start: 0 } }
    ]);
    expect(mine!.map((r) => r.Name)).toEqual([name]);
    expect(none).toEqual([]);
  });

  it("preview returns the projection without writing, and a per-command failure is reported by index while the rest of the batch stands", async () => {
    const before = (await assetApi.queries<Story>(t, [{ from: "Story", select: ["Name"], filter: [`Name='${name.replace(/'/g, "\\'")} preview'`], page: { size: 1, start: 0 } }]))[0]!;
    const projection = await assetApi.preview(t, [{ "@p": { AssetType: "Story", Name: `${name} preview`, Scope: { _oid: "Scope:0" } } }]);
    expect(projection).toEqual([{ "@p": { AssetType: "Story", Name: `${name} preview`, Scope: "Scope:0" } }]);
    const after = (await assetApi.queries<Story>(t, [{ from: "Story", select: ["Name"], filter: [`Name='${name.replace(/'/g, "\\'")} preview'`], page: { size: 1, start: 0 } }]))[0]!;
    expect(after).toEqual(before);
    // A bad Link (no such parent) fails alone; the Story create beside it succeeds.
    const res = await assetApi.send(t, [
      { "@ok": { AssetType: "Story", Name: `${name} beside a failure`, Scope: { _oid: "Scope:0" } } },
      { "@bad": { AssetType: "Link", Name: "x", URL: "https://example.test", OnMenu: true, Asset: { _oid: "Story:999999999" } } }
    ]);
    created.push(...res.assetsCreated.oidTokens.map(assetApi.momentless));
    expect(res.assetsCreated.count).toBe(1);
    const failures = assetApi.failuresOf(res);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.index).toBe(1);
    expect(failures[0]!.message).toMatch(/Link\.Asset|Invalid/);
  });
});

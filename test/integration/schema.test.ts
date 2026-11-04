import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { Schema } from "../../src/services/schema";
import type { Story } from "../../src/types/assets/Story";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * The schema service and schema-driven translation against a real
 * instance: the one thing the fakes cannot prove is that the server still
 * spells rows the way the fakes were copied from. Brings its own data, so
 * it holds on an empty instance: a StoryStatus, a Story on Scope:0 with an
 * Estimate, that Status and the caller as owner, and one child Task — all
 * deleted afterwards.
 */
describeInstance("schema (live)", () => {
  const t = instance!.transport;
  let story = "";
  const created: string[] = [];

  beforeAll(async () => {
    const [me] = await assetApi.query(t, { from: "Member", select: ["Name"], where: { IsSelf: "true" }, page: { size: 1, start: 0 } });
    const res = await assetApi.send(t, [
      { "@status": { AssetType: "StoryStatus", Name: fixtureName("status"), RollupState: "Active" } },
      { "@story": { AssetType: "Story", Name: fixtureName("schema story"), Scope: { _oid: "Scope:0" }, Estimate: 3, Status: "@status", Owners: [{ _oid: me!._oid }] } },
      { "@task": { AssetType: "Task", Name: fixtureName("schema task"), Parent: "@story" } }
    ], { throwOnFailure: true });
    created.push(...res.assetsCreated.oidTokens.map(assetApi.momentless));
    story = created.find((oid) => oid.startsWith("Story:"))!;
  });

  afterAll(async () => {
    // Children before parents; the status last, once nothing points at it.
    const order = (oid: string) => (oid.startsWith("Task:") ? 0 : oid.startsWith("Story:") ? 1 : 2);
    for (const oid of [...created].sort((a, b) => order(a) - order(b))) await assetApi.send(t, [{ from: oid, execute: "Delete" }]);
  });

  it("loads a type from meta.v1 once, and a type the instance does not have is null — the expect-zero control", async () => {
    const schema = new Schema(t);
    const story = await schema.load("Story");
    expect(story?.Token).toBe("Story");
    expect(schema.attribute("Story", "Estimate")?.AttributeType).toBe("Numeric");
    expect(schema.attribute("Story", "Owners")).toMatchObject({ AttributeType: "Relation", IsMultivalue: true, RelatedAsset: "Member" });
    expect(await schema.load("ZzqqxxNoSuchType")).toBeNull();
    expect(schema.assetType("ZzqqxxNoSuchType")).toBeNull();
  });

  it("through the client, api/asset rows arrive in the model's shape: numbers, booleans, one Ref for a sub-selected single relation, numbers for aggregates", async () => {
    const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: t });
    const rows = await client.assets.query<Story>({
      from: "Story",
      select: ["Name", "Estimate", "IsClosed", "IsReadOnly", "AssetState", { from: "Status", select: ["Name"] }, { from: "Owners", select: ["Name", "IsInactive"] }, "Scope", "Owners.@Count", "Children:Task.@Count"],
      filter: ["ID=$story"],
      with: { $story: story },
      page: { size: 1, start: 0 }
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.Owners).toHaveLength(1);
    expect((rows[0] as unknown as Record<string, unknown>)["Children:Task.@Count"]).toBe(1);
    expect(client.schema.loaded.sort()).toEqual(["Member", "Story", "StoryStatus"]); // the types the select touches, and only those
    for (const r of rows) {
      const raw = r as unknown as Record<string, unknown>;
      expect(typeof r.Estimate).toBe("number");
      expect(typeof r.IsClosed).toBe("boolean");
      expect(typeof r.IsReadOnly).toBe("boolean");
      expect(["Future", "Active", "Closed", "Dead", "OldBrokenDownStory", "Deprecated", "Deleted"]).toContain(r.AssetState);
      expect(Array.isArray(r.Status)).toBe(false);
      expect(r.Status).toMatchObject({ _oid: expect.stringMatching(/^StoryStatus:\d+$/), Name: expect.any(String) });
      expect(r.Scope).toMatchObject({ _oid: expect.stringMatching(/^Scope:\d+$/) });
      expect(Array.isArray(r.Owners)).toBe(true);
      for (const o of r.Owners) { expect(o._oid).toMatch(/^Member:\d+$/); expect(typeof o.IsInactive).toBe("boolean"); }
      expect(typeof raw["Owners.@Count"]).toBe("number");
      expect(raw["Owners.@Count"]).toBe(r.Owners.length);
      expect(typeof raw["Children:Task.@Count"]).toBe("number");
    }
    // The same query, untranslated, still comes back as strings — the fakes' premise, re-verified.
    const { assetApi } = await import("../../src/wire");
    const [plain] = await assetApi.query(t, { from: "Story", select: ["Estimate", "IsClosed", { from: "Status", select: ["Name"] }], filter: ["ID=$story"], with: { $story: story }, page: { size: 1, start: 0 } });
    const p = plain as unknown as Record<string, unknown>;
    expect(typeof p.Estimate).toBe("string");
    expect(["True", "False"]).toContain(p.IsClosed);
    expect(Array.isArray(p.Status)).toBe(true);
  });
});

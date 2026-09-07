import { expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { Schema } from "../../src/services/schema";
import type { Story } from "../../src/types/assets/Story";
import { describeInstance, instance } from "./instance";

/**
 * The schema service and schema-driven translation against a real
 * instance: the one thing the fakes cannot prove is that the server still
 * spells rows the way the fakes were copied from. Read-only.
 */
describeInstance("schema (live)", () => {
  const t = instance!.transport;

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
      filter: ["Status!='';Estimate!=''"],
      sort: ["-ChangeDateUTC"],
      page: { size: 3, start: 0 }
    });
    expect(rows.length).toBeGreaterThan(0);
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
    const [plain] = await assetApi.query(t, { from: "Story", select: ["Estimate", "IsClosed", { from: "Status", select: ["Name"] }], filter: ["Status!='';Estimate!=''"], page: { size: 1, start: 0 } });
    const p = plain as unknown as Record<string, unknown>;
    expect(typeof p.Estimate).toBe("string");
    expect(["True", "False"]).toContain(p.IsClosed);
    expect(Array.isArray(p.Status)).toBe(true);
  });
});

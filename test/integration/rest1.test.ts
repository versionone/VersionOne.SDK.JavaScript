import { expect, it } from "vitest";
import type { Story } from "../../src/types/assets/Story";
import { rest1 } from "../../src/wire";
import { describeInstance, instance } from "./instance";

/**
 * The rest-1 wire module against a real instance: the shapes a fake cannot
 * prove. Read-only — nothing is created.
 */
describeInstance("rest1 (live)", () => {
  const t = instance!.transport;

  it("a cross-type BaseAsset read with type-qualified Number sels comes back keyed by the plain name, with the real total, AssetState by name, and relation display columns folded onto Refs", async () => {
    const { rows, total } = await rest1.list<Story>(t, "BaseAsset", {
      where: ["AssetType='Story','Defect'"],
      sel: ["AssetType", "Name", "AssetState", "Story.Number", "Defect.Number", "Workitem.Owners", "PrimaryWorkitem.Status"],
      sort: ["-ChangeDateUTC"],
      page: { size: 3, start: 0 },
      deleted: false,
      needTotal: true
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(rows.length);
    for (const r of rows) {
      expect(r._oid).toMatch(/^(Story|Defect):\d+$/);
      expect(r.Number).toMatch(/^[A-Z]+-\d+$/);
      expect(["Future", "Active", "Closed", "Dead", "OldBrokenDownStory", "Deprecated", "Deleted"]).toContain(r.AssetState);
      expect(Array.isArray(r.Owners)).toBe(true);
      for (const o of r.Owners ?? []) { expect(o._oid).toMatch(/^Member:\d+$/); expect(typeof o.Name).toBe("string"); }
      if (r.Status) { expect(r.Status._oid).toMatch(/^(Story|Defect)Status:\d+$/); expect(typeof r.Status.Name).toBe("string"); }
    }
  });

  it("find narrows to names and descriptions; a nonexistent term returns nothing — the expect-zero control", async () => {
    const hit = await rest1.list(t, "Story", { sel: ["Name"], find: "order", findin: ["Name", "Description"], page: { size: 2, start: 0 }, needTotal: true });
    expect(hit.rows.length).toBeGreaterThan(0);
    expect(hit.total).toBeGreaterThan(0);
    const none = await rest1.list(t, "Story", { sel: ["Name"], find: "zzqqxxnothing", findin: ["Name", "Description"], page: { size: 2, start: 0 }, needTotal: true });
    expect(none.rows).toEqual([]);
    expect(none.total).toBe(0);
  });

  it("get reads one asset with its relations as Refs, and history reads the same asset one moment per row", async () => {
    const { rows: [any] } = await rest1.list<Story>(t, "Story", { sel: ["Name"], page: { size: 1, start: 0 } });
    expect(any).toBeDefined();
    const one = await rest1.get<Story>(t, any!._oid, ["Name", "Scope", "Owners", "Super"]);
    expect(one._oid).toBe(any!._oid);
    expect(one.Name).toBe(any!.Name);
    expect(one.Scope).toMatchObject({ _oid: expect.stringMatching(/^Scope:\d+$/) });
    expect(typeof one.Scope?.Name).toBe("string"); // rest-1 adds Scope.Name beside a selected Scope; folded onto the Ref
    const moments = await rest1.history<Story>(t, any!._oid, { sel: ["Name", "ChangeDate"], page: { size: 3, start: 0 } });
    expect(moments.rows.length).toBeGreaterThan(0);
    for (const m of moments.rows) expect(m._oid).toMatch(new RegExp(`^${any!._oid}:\\d+$`));
  });
});

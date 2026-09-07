import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "../../src/services/schema";
import type { AttributeLookup } from "../../src/types/metamodel";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";
import { fromTypeOf, resolvePath, segmentsOf, typesNeeded } from "../../src/wire/select";

// The committed metamodel, complete: every path below resolves without a fetch.
const metamodel = toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument);
const schema = Schema.fromMetamodel(metamodel);

describe("select: segments", () => {
  it("splits on dots outside brackets and quotes, reads a downcast and an aggregate, and drops a trailing filter", () => {
    expect(segmentsOf("Estimate")).toEqual([{ name: "Estimate", downcast: null, aggregate: null }]);
    expect(segmentsOf("Status.Name")).toEqual([{ name: "Status", downcast: null, aggregate: null }, { name: "Name", downcast: null, aggregate: null }]);
    expect(segmentsOf("Children:Task.@Count")).toEqual([{ name: "Children", downcast: "Task", aggregate: null }, { name: "@Count", downcast: null, aggregate: "Count" }]);
    expect(segmentsOf("BlockingIssues[AssetState!='Deleted';AssetState!='Closed'].@Count")).toEqual([{ name: "BlockingIssues", downcast: null, aggregate: null }, { name: "@Count", downcast: null, aggregate: "Count" }]);
    expect(segmentsOf("History[AssetState!='Closed';Status.Now.PrimaryWorkitems=$].Days.@Sum").map((s) => s.name)).toEqual(["History", "Days", "@Sum"]);
  });
});

describe("select: resolvePath against the committed metamodel", () => {
  it("resolves a scalar to its attribute, with the type that carries it", () => {
    const r = resolvePath(schema, "Story", "Estimate");
    expect(r).toMatchObject({ kind: "resolved", valueType: "Story", multi: false, aggregate: null });
    expect(r.kind === "resolved" && r.definition?.AttributeType).toBe("Numeric");
    expect(resolvePath(schema, "Story", "IsClosed")).toMatchObject({ kind: "resolved", definition: { AttributeType: "Boolean" }, multi: false });
    expect(resolvePath(schema, "Story", "AssetState")).toMatchObject({ kind: "resolved", definition: { AttributeType: "State" } });
  });

  it("follows relations: a single one is not multi, a multi one makes the value a list, and a scalar at the end keeps the last hop's type", () => {
    expect(resolvePath(schema, "Story", "Status")).toMatchObject({ kind: "resolved", definition: { AttributeType: "Relation", IsMultivalue: false }, valueType: "StoryStatus", multi: false });
    expect(resolvePath(schema, "Story", "Owners")).toMatchObject({ kind: "resolved", definition: { IsMultivalue: true }, valueType: "Member", multi: true });
    expect(resolvePath(schema, "Story", "Status.Name")).toMatchObject({ kind: "resolved", definition: { AttributeType: "Text" }, valueType: "StoryStatus", multi: false });
    expect(resolvePath(schema, "Story", "Owners.Name")).toMatchObject({ kind: "resolved", definition: { AttributeType: "Text" }, valueType: "Member", multi: true });
    expect(resolvePath(schema, "Story", "Scope.Parent.Name")).toMatchObject({ kind: "resolved", valueType: "Scope", multi: false });
  });

  it("handles a downcast, a filter and an aggregate", () => {
    expect(resolvePath(schema, "Story", "Children:Task")).toMatchObject({ kind: "resolved", valueType: "Task", multi: true });
    expect(resolvePath(schema, "Story", "Children:Task.Number")).toMatchObject({ kind: "resolved", definition: { AttributeType: "Text" }, valueType: "Task", multi: true });
    expect(resolvePath(schema, "Story", "Owners.@Count")).toMatchObject({ kind: "resolved", definition: null, aggregate: "Count" });
    expect(resolvePath(schema, "Story", "BlockingIssues[AssetState!='Closed'].@Count")).toMatchObject({ kind: "resolved", aggregate: "Count" });
  });

  it("says what it does not know rather than guessing: a missing attribute, a scalar mid-path, an aggregate mid-path", () => {
    expect(resolvePath(schema, "Story", "NoSuchAttribute")).toEqual({ kind: "unknown", at: "Story.NoSuchAttribute" });
    expect(resolvePath(schema, "Story", "Name.Length")).toEqual({ kind: "unknown", at: "Name.Length" });
    expect(resolvePath(schema, "Story", "Owners.@Count.Name")).toEqual({ kind: "unknown", at: "Owners.@Count.Name" });
    expect(resolvePath(schema, "NoSuchType", "Name")).toEqual({ kind: "needs", type: "NoSuchType" });
  });

  it("with a partial lookup, names the type it needs at the first unloaded hop", () => {
    const partial: AttributeLookup = { assetType: (t) => (t === "Story" ? metamodel.AssetTypes.Story! : undefined) };
    expect(resolvePath(partial, "Story", "Estimate").kind).toBe("resolved");
    expect(resolvePath(partial, "Story", "Status.Name")).toEqual({ kind: "needs", type: "StoryStatus" });
    expect(resolvePath(partial, "Story", "Scope.Parent.Name")).toEqual({ kind: "needs", type: "Scope" });
  });
});

describe("select: fromTypeOf and typesNeeded", () => {
  it("reads a query's type from a token, an OID, or the aliased create it refers to", () => {
    expect(fromTypeOf("Story")).toBe("Story");
    expect(fromTypeOf("Story:123")).toBe("Story");
    expect(fromTypeOf("@s", [{ "@s": { AssetType: "Defect", Name: "x" } }, { from: "@s", select: ["Number"] }])).toBe("Defect");
    expect(fromTypeOf("@nowhere", [{ from: "Story", select: [] }])).toBeNull();
  });

  it("lists the types a partial lookup still needs for a query, sub-selects included, and nothing for a complete one", () => {
    const query = { from: "Story", select: ["Name", "Status.Name", { from: "Owners", select: ["Name", { from: "OwnedWorkitems", select: ["Number"] }] }, "Children:Task.@Count"] };
    expect(typesNeeded(schema, query, "Story").size).toBe(0);
    const loaded = new Set(["Story"]);
    const partial: AttributeLookup = { assetType: (t) => (loaded.has(t) ? metamodel.AssetTypes[t] : undefined) };
    expect([...typesNeeded(partial, query, "Story")].sort()).toEqual(["Member", "StoryStatus"]);
    loaded.add("Member"); loaded.add("StoryStatus");
    expect([...typesNeeded(partial, query, "Story")]).toEqual(["Workitem"]); // OwnedWorkitems -> Workitem, only reachable once Member is loaded
    loaded.add("Workitem");
    expect(typesNeeded(partial, query, "Story").size).toBe(0);
    expect([...typesNeeded({ assetType: () => undefined }, query, "Story")]).toEqual(["Story"]);
  });
});

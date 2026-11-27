import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import { termsOf } from "../../src/services/validValuesQuery";
import { FakeAgilityClient } from "../../src/testing";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";

const types = () => Schema.fromMetamodel(toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument)).cache;

// The metamodel's own rows as an instance answers them through api/asset (the API-testing instance, 2026-11-27), trimmed to the relations used here.
const DEFINITIONS = [
  { _oid: "ManyToManyRelationDefinition:-1", Name: "Owners", "Asset.Name": "Workitem", ValidValuesFilter: "Member.Scopes,=,$Scope|Member.AssetState,!=,Closed", NewValidValuesFilter: null },
  { _oid: "OneToManyRelationDefinition:-2", Name: "Customer", "Asset.Name": "Story", ValidValuesFilter: "Member.Scopes.Workitems,=,$|Member.AssetState,!=,Closed", NewValidValuesFilter: "Member.Scopes,=,$Scope|Member.AssetState,!=,Closed" },
  { _oid: "HierarchyRelationDefinition:-3", Name: "Parent", "Asset.Name": "Workitem", ValidValuesFilter: null, NewValidValuesFilter: null },
  { _oid: "ManyToManyRelationDefinition:-4", Name: "Requests", "Asset.Name": "PrimaryWorkitem", ValidValuesFilter: null, NewValidValuesFilter: null }
];
const OVERRIDES = [
  { _oid: "Override:-10", Name: "Owners", "Asset.Name": "Task", ValidValuesFilter: "Member.Scopes.Workitems,=,$Parent|Member.AssetState,!=,Closed" },
  { _oid: "Override:-11", Name: "Parent", "Asset.Name": "PrimaryWorkitem", ValidValuesFilter: "Theme.Scope.ChildrenMeAndDown,=,$Scope|Theme.AssetState,!=,Closed" },
  { _oid: "Override:-12", Name: "Parent", "Asset.Name": "Test", ValidValuesFilter: "Workitem.AssetState,!=,Closed|Workitem.AssetType,=,Story,Defect,TestSet,Epic" },
  // An override that changes something else has no filter and changes no rule.
  { _oid: "Override:-13", Name: "Owners", "Asset.Name": "Story", ValidValuesFilter: null }
];
type Query = { from: string; filter?: string[]; with?: Record<string, string | string[]>; select?: string[] };

function instance(asset: Record<string, unknown> | null = null) {
  const calls: RequestOptions[] = [];
  const answer = (q: Query): unknown[] => {
    const names = [q.with?.$name].flat(), among = [q.with?.$types].flat();
    if (q.from === "RelationDefinition" && q.filter?.[0] === "Name=$name") return DEFINITIONS.filter((r) => names.includes(r.Name) && among.includes(r["Asset.Name"]));
    if (q.from === "RelationDefinition") return [];
    if (q.from === "Override") return OVERRIDES.filter((r) => names.includes(r.Name) && among.includes(r["Asset.Name"]));
    return asset ? [asset] : [];
  };
  const transport: Transport = { request: vi.fn(async (o: RequestOptions) => { calls.push(o); return { requestId: "r", queryResult: { results: (o.body as Query[]).map(answer), resultMetaData: [], count: 1 } }; }) as Transport["request"] };
  return { client: new AgilityApiClient({ baseUrl: "https://x" }, { transport, types: types() }), calls };
}

describe("validValues.query", () => {
  it("reads a rule's terms; one it cannot read is an error, never a term left out", () => {
    expect(termsOf("Workitem.AssetState,!=,Closed|Workitem.AssetType,=,Story,Defect|Workitem.Timebox.State.Code,!=,CLSD|Member.Scopes,=,$Scope|Epic.SuperMeAndUp,!=,$")).toEqual([
      { path: "AssetState", op: "!=", values: ["Closed"] }, { path: "AssetType", op: "=", values: ["Story", "Defect"] }, { path: "Timebox.State.Code", op: "!=", values: ["CLSD"] },
      { path: "Scopes", op: "=", values: ["$Scope"] }, { path: "SuperMeAndUp", op: "!=", values: ["$"] }
    ]);
    for (const bad of ["AssetState,!=,Closed", "Member.Scopes,~,$Scope", "Member.Scopes,=", "Member.,=,x"]) expect(() => termsOf(bad)).toThrow(/cannot read/);
  });

  it("an existing asset: the definition's rule from the ancestor that defines the relation, its $Name read from the asset", async () => {
    const { client, calls } = instance({ _oid: "Story:7", Scope: [{ _oid: "Scope:5" }] });
    expect(await client.validValues.query({ asset: "Story:7:99", attribute: "Owners" })).toEqual({ from: "Member", filter: ["Scopes=$valid0", "AssetState!=$valid1"], with: { $valid0: "Scope:5", $valid1: "Closed" } });
    // One request for the rule (the definition from either end, and the overrides), one for the asset's Scope.
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body as Query[]).map((q) => q.from)).toEqual(["RelationDefinition", "RelationDefinition", "Override"]);
    expect((calls[0]!.body as Query[])[0]!.with).toEqual({ $name: "Owners", $types: ["Story", "PrimaryWorkitem", "Workitem", "BaseAsset"] });
    expect((calls[1]!.body as Query[])[0]).toMatchObject({ from: "Story:7", select: ["Scope"] });
    // The rule is metamodel: asked once per relation.
    await client.validValues.query({ asset: "Story:8", attribute: "Owners" });
    expect(calls.filter((c) => (c.body as Query[])[0]!.from === "RelationDefinition")).toHaveLength(1);
  });

  it("a bare $ is the asset itself, and for a new asset the definition's own rule for a new one is used", async () => {
    const { client, calls } = instance();
    expect(await client.validValues.query({ asset: "Story:7", attribute: "Customer" })).toMatchObject({ filter: ["Scopes.Workitems=$valid0", "AssetState!=$valid1"], with: { $valid0: "Story:7", $valid1: "Closed" } });
    expect(calls).toHaveLength(1);
    expect(await client.validValues.query({ type: "Story", scope: "Scope:5:12", attribute: "Customer" })).toMatchObject({ filter: ["Scopes=$valid0", "AssetState!=$valid1"], with: { $valid0: "Scope:5", $valid1: "Closed" } });
  });

  it("an override on the type or its nearest ancestor replaces the definition's rule; one without a filter does not", async () => {
    const { client } = instance({ _oid: "Task:3", Parent: [{ _oid: "Story:7" }] });
    expect((await client.validValues.query({ asset: "Task:3", attribute: "Owners" })).with).toEqual({ $valid0: "Story:7", $valid1: "Closed" });
    expect((await client.validValues.query({ type: "Story", scope: "Scope:5", attribute: "Parent" })).filter).toEqual(["Scope.ChildrenMeAndDown=$valid0", "AssetState!=$valid1"]);
    expect((await client.validValues.query({ type: "Story", scope: "Scope:5", attribute: "Owners" })).filter).toEqual(["Scopes=$valid0", "AssetState!=$valid1"]);
    // Several values in a term are one variable, which reads as any of them.
    expect(await client.validValues.query({ type: "Test", scope: "Scope:5", attribute: "Parent" })).toMatchObject({ filter: ["AssetState!=$valid0", "AssetType=$valid1"], with: { $valid0: "Closed", $valid1: ["Story", "Defect", "TestSet", "Epic"] } });
  });

  it("a relation with no rule may point to anything of its type", async () => {
    expect(await instance().client.validValues.query({ type: "Story", scope: "Scope:5", attribute: "Requests" })).toEqual({ from: "Request", filter: [], with: {} });
  });

  it("says what a rule needs when it is missing, where the server would answer nothing", async () => {
    await expect(instance().client.validValues.query({ type: "Task", scope: "Scope:5", attribute: "Owners" })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining('depends on its Parent. Give it as context: { Parent: "<oid>" }') });
    expect((await instance().client.validValues.query({ type: "Task", scope: "Scope:5", context: { Parent: "Story:7:3" }, attribute: "Owners" })).with.$valid0).toBe("Story:7");
    await expect(instance({ _oid: "Task:3", Parent: [] }).client.validValues.query({ asset: "Task:3", attribute: "Owners" })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("Task:3 has none") });
    await expect(instance(null).client.validValues.query({ asset: "Task:3", attribute: "Owners" })).rejects.toMatchObject({ kind: "notFound" });
  });

  it("refuses before sending anything: a list type (client.lists), no relation, no such attribute or type, no target", async () => {
    const { client, calls } = instance();
    await expect(client.validValues.query({ asset: "Story:7", attribute: "Status" })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("ask client.lists.values") });
    await expect(client.validValues.query({ asset: "Story:7", attribute: "Name" })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining("not a relation") });
    await expect(client.validValues.query({ asset: "Story:7", attribute: "Nope" })).rejects.toMatchObject({ kind: "usage" });
    await expect(client.validValues.query({ type: "Story", scope: "", attribute: "Owners" })).rejects.toMatchObject({ kind: "usage" });
    expect(calls).toHaveLength(0);
  });
});

describe("FakeAgilityClient.onValidValuesQuery", () => {
  it("answers what was scripted, records what was asked, and says how to script what was not", async () => {
    const fake = new FakeAgilityClient().onValidValuesQuery((asked) => (asked.attribute === "Owners" ? { from: "Member", filter: ["Scopes=$valid0"], with: { $valid0: "Scope:5" } } : undefined));
    expect((await fake.validValues.query({ asset: "Story:7", attribute: "Owners" })).from).toBe("Member");
    expect(fake.validValuesAsked).toEqual([{ asset: "Story:7", attribute: "Owners" }]);
    await expect(fake.validValues.query({ asset: "Story:7", attribute: "Team" })).rejects.toThrow(/onValidValuesQuery/);
  });
});

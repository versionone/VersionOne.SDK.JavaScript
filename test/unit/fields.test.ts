import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema } from "../../src/services/schema";
import { describe as describeFields, importantName } from "../../src/services/fields";
import { visibleFields, visibleFieldsByAsset } from "../../src/wire/fields";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";

const schema = () => Schema.fromMetamodel(toMetamodel(JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument));
function fake(answer: (o: RequestOptions) => unknown): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  return { request: vi.fn(async (o: RequestOptions) => { calls.push(o); return answer(o); }) as Transport["request"], calls };
}
// As api/visibleFields answered on v1sdktesting (2026-11-14), trimmed.
const visibleAnswer = [{ assetType: "Story", fields: ["Custom_Demo_List", "Estimate", "Name", "Number", "Owners", "Scope", "Status"] }, { assetType: "Defect", fields: ["Name", "Number", "Resolution"] }];

describe("fields wire", () => {
  it("visibleFields repeats both keys on the query string and answers a map by type", async () => {
    const t = fake(() => visibleAnswer);
    const map = await visibleFields(t, ["Story", "Defect"], ["Scope:0", "Scope:5:99"]);
    expect(t.calls[0]!.path).toBe("/api/visibleFields?scopeOid=Scope%3A0&scopeOid=Scope%3A5&assetTypeToken=Story&assetTypeToken=Defect");
    expect(map.Story).toContain("Custom_Demo_List");
    expect(map.Defect).toEqual(["Name", "Number", "Resolution"]);
    expect(await visibleFields(t, [], ["Scope:0"])).toEqual({});
    await expect(visibleFields(fake(() => ({ nope: 1 })), ["Story"], ["Scope:0"])).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("visibleFieldsByAsset asks by oidToken and answers the flat list", async () => {
    const t = fake(() => ["Name", "Number"]);
    expect(await visibleFieldsByAsset(t, "Story:1:2")).toEqual(["Name", "Number"]);
    expect(t.calls[0]).toMatchObject({ path: "/api/visibleFieldsByAsset", query: { oidToken: "Story:1" } });
  });
});

describe("fields service", () => {
  it("importantName reduces a scheme's token to the attribute when it belongs to the type or an ancestor", () => {
    expect(importantName("Story.Owners", ["Story", "PrimaryWorkitem", "Workitem"])).toBe("Owners");
    expect(importantName("Workitem.Owners", ["Story", "PrimaryWorkitem", "Workitem"])).toBe("Owners");
    expect(importantName("Defect.Resolution", ["Story", "PrimaryWorkitem"])).toBeNull();
    expect(importantName("Owners", ["Story"])).toBe("Owners");
  });

  it("describe joins meta's required, visibleFields and the scope's scheme into one answer", async () => {
    const t = fake((o) => (o.path.startsWith("/api/visibleFields") ? visibleAnswer : { requestId: "r", queryResult: { results: [[{ _oid: "Scope:0", Scheme: [{ _oid: "Scheme:1000", ImportantFields: ["Story.Owners", "Defect.Resolution", "Workitem.Estimate"], IsRequiredAtClose: "True" }] }]], resultMetaData: [], count: 1 } }));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t, schema: schema() });
    const f = await client.fields.describe("Story", "Scope:0:7");
    expect(f).toEqual({ type: "Story", scope: "Scope:0", scheme: "Scheme:1000", required: ["Name", "Scope"], visible: visibleAnswer[0]!.fields, important: ["Estimate", "Owners"], requiredAtClose: true });
    const body = (t.calls.find((c) => c.path === "/api/asset")!.body as unknown[])[0];
    expect(body).toMatchObject({ from: "Scope", with: { $scope: "Scope:0" }, page: { size: 1, start: 0 } });
  });

  it("describe answers an empty scheme and no visible entry without guessing", async () => {
    const t = fake((o) => (o.path.startsWith("/api/visibleFields") ? [] : { queryResult: { results: [[{ _oid: "Scope:9", Scheme: [] }]], resultMetaData: [], count: 1 } }));
    const f = await describeFields(t, schema(), "Story", "Scope:9");
    expect(f).toMatchObject({ scheme: null, visible: [], important: [], requiredAtClose: false, required: ["Name", "Scope"] });
  });
});

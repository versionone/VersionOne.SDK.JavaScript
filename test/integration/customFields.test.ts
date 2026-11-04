import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { Schema } from "../../src/services/schema";
import type { Story } from "../../src/types/assets/Story";
import { assetApi } from "../../src/wire";
import { createCustomFields, customTokenOf, deleteCustomFields, findCustomField } from "./customFields";
import { describeLocalInstance, fixtureName, instance } from "./instance";

/**
 * Custom attributes end to end: definitions created through the classic
 * UI's gadget (no API exists), the app domain recycled, the live schema
 * seeing them, and rows translated by their type — the claim the canned
 * metamodel cannot make, since an instance's own custom attributes are not
 * in it. Slow: two app-domain recycles. Creates two definitions and one
 * Story on Scope:0, and deletes all three.
 */
describeLocalInstance("custom fields (live, via the classic UI gadget)", () => {
  const t = instance!.transport;
  const SLOW = 180_000;
  const stamp = Date.now().toString(36);
  const numeric = `SdkItNum${stamp}`, flag = `SdkItFlag${stamp}`;
  const created: string[] = [];

  beforeAll(async () => {
    await createCustomFields(t, [{ name: numeric, attributeType: "Numeric", assetType: "Story" }, { name: flag, attributeType: "Boolean", assetType: "Story" }]);
  }, SLOW);

  afterAll(async () => {
    if (created.length) await assetApi.send(t, created.map((oid) => ({ from: oid, execute: "Delete" })));
    await deleteCustomFields(t, [numeric, flag]);
    expect(await findCustomField(t, numeric)).toBeNull();
  }, SLOW);

  it("after the recycle, meta.v1 carries the new definitions with their types, and a fresh schema loads them", async () => {
    const schema = new Schema(t);
    await schema.load("Story");
    expect(schema.attribute("Story", customTokenOf(numeric))).toMatchObject({ AttributeType: "Numeric", IsCustom: true });
    expect(schema.attribute("Story", customTokenOf(flag))).toMatchObject({ AttributeType: "Boolean", IsCustom: true });
    expect(schema.attribute("Story", "Custom_ZzqqxxNoSuch")).toBeNull(); // the expect-zero control
  }, SLOW);

  it("a Story's custom values, written through api/asset, read back as number and boolean through the client — and as strings without the schema", async () => {
    const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: t });
    const numToken = customTokenOf(numeric), flagToken = customTokenOf(flag);
    const res = await client.assets.send<Story>([
      { "@s": { AssetType: "Story", Name: fixtureName("custom fields"), Scope: { _oid: "Scope:0" }, [numToken]: 7, [flagToken]: true } },
      { from: "@s", select: ["Name", numToken, flagToken] }
    ]);
    created.push(...res.assetsCreated.oidTokens.map(assetApi.momentless));
    expect(res.commandFailures.count).toBe(0);
    const [row] = res.queryResult.results[0]! as unknown as Record<string, unknown>[];
    expect(row![numToken]).toBe(7);
    expect(row![flagToken]).toBe(true);
    const [plain] = await assetApi.query(t, { from: created[0]!, select: [numToken, flagToken], page: { size: 1, start: 0 } });
    const p = plain as unknown as Record<string, unknown>;
    expect(p[numToken]).toBe("7");
    expect(p[flagToken]).toBe("True");
  }, SLOW);
});

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { getAssetType, getAttributeDefinition, getMetamodel, isMetamodelDocument, toAssetType, toAttributeDefinition, type AssetTypeDocument, type MetamodelDocument } from "../../src/wire/meta";

// A real slice of what meta.v1 delivers: the committed metamodel's Story type.
const metamodel = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;
const storyDoc = metamodel.AssetTypes.Story!;

function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => { calls.push(options); return answers.shift(); });
  return { request: request as Transport["request"], calls };
}

describe("meta: translation", () => {
  it("an asset type keeps tokens for its references, its Base when it has one, and translates every attribute", () => {
    const story = toAssetType(storyDoc);
    expect(story._type).toBe("AssetType");
    expect(story.Token).toBe("Story");
    expect(story.Name).toBe("Story");
    expect(story.Base).toBe("PrimaryWorkitem");
    expect(story.Abstract).toBe(false);
    expect(story.ShortName).toBe("Story.Number");
    expect(story.DefaultOrderBy).toBe("Story.Order");
    expect(Object.keys(story.Attributes).length).toBe(Object.keys(storyDoc.Attributes).length);
    const root = toAssetType(metamodel.AssetTypes.BaseAsset!);
    expect(root.Base).toBeUndefined();
    expect(root.Abstract).toBe(true);
  });

  it("an attribute keeps its Base only when inherited, and its relation target and reciprocal as tokens", () => {
    const name = toAttributeDefinition(storyDoc.Attributes["Story.Name"]!);
    expect(name).toMatchObject({ _type: "AttributeDefinition", Name: "Name", Token: "Story.Name", AttributeType: "Text", IsRequired: true, IsMultivalue: false, Base: "BaseAsset.Name" });
    expect(name.RelatedAsset).toBeUndefined();
    const owners = toAttributeDefinition(storyDoc.Attributes["Story.Owners"]!);
    expect(owners).toMatchObject({ AttributeType: "Relation", IsMultivalue: true, RelatedAsset: "Member", ReciprocalRelation: "Member.OwnedWorkitems", Base: "Workitem.Owners" });
    // An attribute the type defines itself has no Base at all — the generator's "own attribute" rule.
    const own = Object.values(storyDoc.Attributes).find((a) => !a.Base)!;
    expect(toAttributeDefinition(own).Base).toBeUndefined();
    expect("Base" in toAttributeDefinition(own)).toBe(false);
  });

  it("recognises a delivered metamodel document", () => {
    expect(isMetamodelDocument(metamodel)).toBe(true);
    expect(isMetamodelDocument({ AssetTypes: {} })).toBe(false);
    expect(isMetamodelDocument(null)).toBe(false);
  });
});

describe("meta: calls", () => {
  it("reads the whole metamodel, one type, and one attribute from their meta.v1 paths, and refuses a malformed attribute token", async () => {
    const t = fakeTransport({ Version: "1", AssetTypes: { Story: storyDoc } }, storyDoc, storyDoc.Attributes["Story.Owners"]);
    const all = await getMetamodel(t);
    expect(all.Version).toBe("1");
    expect(all.AssetTypes.Story!.Base).toBe("PrimaryWorkitem");
    const story = await getAssetType(t, "Story");
    expect(story.Token).toBe("Story");
    const owners = await getAttributeDefinition(t, "Story.Owners");
    expect(owners.RelatedAsset).toBe("Member");
    expect(t.calls.map((c) => [c.method, c.path])).toEqual([["GET", "/meta.v1"], ["GET", "/meta.v1/Story"], ["GET", "/meta.v1/Story/Owners"]]);
    await expect(getAttributeDefinition(t, "Story" as `${string}.${string}`)).rejects.toThrow(/is not an attribute token/);
  });
});

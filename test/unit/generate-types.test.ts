import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — a plain ES module script, imported for its exports.
import { META_TYPES, checkHandwritten, generate, model } from "../../scripts/generate-types.mjs";
// @ts-expect-error — the same, for the metamodel pull.
import { canned } from "../../scripts/download-metamodel.mjs";

const root = join(__dirname, "..", "..");

describe("generate-types: the meta-describing types", () => {
  it("are not generated — src/types/metamodel.ts models them by hand — and a relation to one is a bare Ref", async () => {
    const metamodel = JSON.parse(await readFile(join(root, "metamodel.json"), "utf8"));
    const { files } = model(metamodel) as { files: { token: string; text: string }[] };
    const emitted = new Set(files.map((f) => f.token));
    for (const t of META_TYPES as Set<string>) expect(emitted.has(t), t).toBe(false);
    // The metamodel's own AssetType asset type is referenced by relations elsewhere; those come out untyped.
    const referencing = files.filter((f) => /Ref<(AssetType|AttributeDefinition|Operation)>/.test(f.text));
    expect(referencing.map((f) => f.token)).toEqual([]);
  });

  it("the hand-written metamodel types have no field meta.v1 never delivers (the divergence check)", async () => {
    const [metamodel, source] = await Promise.all([readFile(join(root, "metamodel.json"), "utf8").then(JSON.parse), readFile(join(root, "src", "types", "metamodel.ts"), "utf8")]);
    const report = checkHandwritten(metamodel, source) as Record<string, { phantoms: string[]; unmodelled: string[] }>;
    expect(report.AssetType!.phantoms).toEqual([]);
    expect(report.AttributeDefinition!.phantoms).toEqual([]);
    // Delivered keys the hand-written types leave out are allowed, but named, so a new one is noticed here first.
    expect(report.AssetType!.unmodelled).toEqual([]);
    expect(report.AttributeDefinition!.unmodelled).toEqual([]);
  });
});

describe("generate-types", () => {
  it("the committed src/types/assets is exactly what the committed metamodel generates (regenerate with npm run generate:types)", async () => {
    const out = await mkdtemp(join(tmpdir(), "sdk-types-"));
    try {
      await generate(join(root, "metamodel.json"), out);
      const committed = join(root, "src", "types", "assets");
      const [fresh, kept] = await Promise.all([readdir(out), readdir(committed)]);
      expect(kept.sort()).toEqual(fresh.sort());
      for (const name of fresh) {
        const [a, b] = await Promise.all([readFile(join(out, name), "utf8"), readFile(join(committed, name), "utf8")]);
        expect(b.replace(/\r\n/g, "\n"), name).toBe(a.replace(/\r\n/g, "\n"));
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("emits own attributes only, the extends chain, Refs for relations, nullability from IsRequired, and the concrete-descendant union for AssetType", () => {
    const metamodel = {
      Version: "test",
      AssetTypes: {
        BaseAsset: { Token: "BaseAsset", Abstract: true, Attributes: {
          "BaseAsset.Name": { Name: "Name", Token: "BaseAsset.Name", AttributeType: "Text", IsReadOnly: false, IsRequired: true, IsMultivalue: false, IsCustom: false },
          "BaseAsset.AssetType": { Name: "AssetType", Token: "BaseAsset.AssetType", AttributeType: "AssetType", IsReadOnly: true, IsRequired: false, IsMultivalue: false, IsCustom: false },
          "BaseAsset.Custom_Thing": { Name: "Custom_Thing", Token: "BaseAsset.Custom_Thing", AttributeType: "Text", IsReadOnly: false, IsRequired: false, IsMultivalue: false, IsCanned: false, IsCustom: true },
          "BaseAsset.Reference": { Name: "Reference", Token: "BaseAsset.Reference", AttributeType: "Text", IsReadOnly: false, IsRequired: false, IsMultivalue: false, IsCanned: true, IsCustom: true }
        } },
        Story: { Token: "Story", Abstract: false, Base: { nameref: "BaseAsset" }, Attributes: {
          "Story.Name": { Name: "Name", Token: "Story.Name", Base: { tokenref: "BaseAsset.Name" }, AttributeType: "Text", IsReadOnly: false, IsRequired: true, IsMultivalue: false, IsCustom: false },
          "Story.Owners": { Name: "Owners", Token: "Story.Owners", AttributeType: "Relation", IsReadOnly: false, IsRequired: false, IsMultivalue: true, IsCustom: false, RelatedAsset: { nameref: "Member" } },
          "Story.Super": { Name: "Super", Token: "Story.Super", AttributeType: "Relation", IsReadOnly: false, IsRequired: false, IsMultivalue: false, IsCustom: false, RelatedAsset: { nameref: "Story" } },
          "Story.Number": { Name: "Number", Token: "Story.Number", AttributeType: "Text", IsReadOnly: true, IsRequired: false, IsMultivalue: false, IsCustom: false },
          "Story.Super.Name": { Name: "Super.Name", Token: "Story.Super.Name", AttributeType: "Text", IsReadOnly: true, IsRequired: false, IsMultivalue: false, IsCustom: false },
          "Story.Picture": { Name: "Picture", Token: "Story.Picture", AttributeType: "Blob", IsReadOnly: false, IsRequired: false, IsMultivalue: false, IsCustom: false }
        } },
        Member: { Token: "Member", Abstract: false, Base: { nameref: "BaseAsset" }, Attributes: {} }
      }
    };
    const { files, index } = model(metamodel);
    type Generated = { token: string; text: string };
    const story = (files as Generated[]).find((f) => f.token === "Story")!.text;
    expect(story).toContain(`import type { Member } from "./Member";`);
    expect(story).toContain(`export interface Story extends BaseAsset {`);
    expect(story).toContain(`  readonly Number?: string | null; // read-only`);
    expect(story).toContain(`  Owners: Ref<Member>[];`);
    expect(story).toContain(`  Super?: Ref<Story> | null;`);
    expect(story).not.toContain("Name:"); // inherited from BaseAsset
    expect(story).not.toContain("Super.Name"); // a joined attribute, not a field
    expect(story).not.toContain("Picture"); // Blob is not a model value
    const base = (files as Generated[]).find((f) => f.token === "BaseAsset")!.text;
    expect(base).toContain(`export interface BaseAsset extends Asset {`);
    expect(base).toContain(`  Name: string; // required`);
    expect(base).toContain(`  readonly AssetType: "Member" | "Story"; // read-only`);
    expect(base).not.toContain("Custom_Thing"); // an instance's custom attribute rides on the Asset root's index signature
    expect(base).toContain(`  Reference?: string | null;`); // a canned "custom" attribute ships everywhere and is generated
    expect(index).toContain(`export type AssetTypeName =\n  "BaseAsset"\n  | "Member"\n  | "Story"`);
    expect(index).toContain(`export type ConcreteAssetTypeName =\n  "Member"\n  | "Story"`);
  });
});

describe("download-metamodel: the committed metamodel is the product's", () => {
  it("strips an instance's custom list types, its custom and reciprocal attributes, and whatever still points at them; keeps canned ones", async () => {
    const delivered = { Version: "26.3.1.13", AssetTypes: {
      List: { Token: "List", Abstract: true, Attributes: { "List.Name": { Token: "List.Name", Name: "Name", IsCustom: false, IsCanned: false } } },
      Custom_Demo_List: { Token: "Custom_Demo_List", Base: { nameref: "List" }, Attributes: { "Custom_Demo_List.ReciprocalOf_Story_Custom_Demo_Single_List": { Token: "Custom_Demo_List.ReciprocalOf_Story_Custom_Demo_Single_List", Name: "ReciprocalOf_Story_Custom_Demo_Single_List", IsCustom: true, IsCanned: false } } },
      Story: { Token: "Story", Attributes: {
        "Story.Name": { Token: "Story.Name", Name: "Name", IsCustom: false, IsCanned: false },
        "Story.Reference": { Token: "Story.Reference", Name: "Reference", IsCustom: true, IsCanned: true },
        "Story.Custom_Points": { Token: "Story.Custom_Points", Name: "Custom_Points", IsCustom: true, IsCanned: false },
        "Story.Custom_Demo_List": { Token: "Story.Custom_Demo_List", Name: "Custom_Demo_List", IsCustom: true, IsCanned: false, RelatedAsset: { nameref: "Custom_Demo_List" } },
        "Story.Dangling": { Token: "Story.Dangling", Name: "Dangling", IsCustom: false, IsCanned: false, RelatedAsset: { nameref: "Custom_Demo_List" } }
      } }
    } };
    const { metamodel, removed } = canned(structuredClone(delivered)) as { metamodel: typeof delivered; removed: { types: string[]; attributes: string[]; dangling: string[] } };
    expect(Object.keys(metamodel.AssetTypes)).toEqual(["List", "Story"]);
    expect(Object.keys(metamodel.AssetTypes.Story.Attributes)).toEqual(["Story.Name", "Story.Reference"]);
    expect(removed.types).toEqual(["Custom_Demo_List"]);
    expect(removed.attributes).toEqual(["Story.Custom_Points", "Story.Custom_Demo_List"]);
    expect(removed.dangling).toEqual(["Story.Dangling (RelatedAsset Custom_Demo_List)"]);
    expect(delivered.AssetTypes.Story.Attributes["Story.Custom_Points"]).toBeDefined(); // the input was cloned, not edited
  });
});

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../../src/core/errors";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { queryOf, Schema } from "../../src/services/schema";
import type { MetamodelDocument } from "../../src/wire/meta";

// Per-type documents as meta.v1/<Type> delivers them, cut from the committed metamodel.
const metamodel = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;
const doc = (token: string) => metamodel.AssetTypes[token]!;

/** A meta.v1 that answers /meta.v1/<Type> from the committed document, 404s the rest, and counts requests. */
function fakeMeta(): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => {
    calls.push(options);
    const token = decodeURIComponent(options.path.replace(/^\/meta\.v1\//, ""));
    await new Promise((r) => setTimeout(r, 1)); // let concurrent callers pile up on one in-flight request
    if (!metamodel.AssetTypes[token]) throw new ApiError("no such type", 404);
    return doc(token);
  });
  return { request: request as Transport["request"], calls };
}

describe("schema", () => {
  it("loads a type once from meta.v1, shares an in-flight request, and answers undefined before and the type after", async () => {
    const t = fakeMeta();
    const s = new Schema(t);
    expect(s.assetType("Story")).toBeUndefined();
    const [a, b] = await Promise.all([s.load("Story"), s.load("Story")]);
    expect(a).toBe(b);
    expect(a?.Token).toBe("Story");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/meta.v1/Story" });
    await s.load("Story");
    expect(t.calls).toHaveLength(1);
    expect(s.assetType("Story")?.Token).toBe("Story");
    expect(s.attribute("Story", "Estimate")?.AttributeType).toBe("Numeric");
    expect(s.attribute("Story", "NoSuch")).toBeNull();
    expect(s.attribute("Epic", "Name")).toBeUndefined();
    expect(s.loaded).toEqual(["Story"]);
  });

  it("remembers a type the instance does not have as null (one request, never again) and lets any other failure through", async () => {
    const t = fakeMeta();
    const s = new Schema(t);
    expect(await s.load("NoSuchType")).toBeNull();
    expect(await s.load("NoSuchType")).toBeNull();
    expect(s.assetType("NoSuchType")).toBeNull();
    expect(t.calls).toHaveLength(1);
    const broken: Transport = { request: async () => { throw new ApiError("unauthorized", 401); } };
    await expect(new Schema(broken).load("Story")).rejects.toMatchObject({ status: 401 });
  });

  it("ensureFor loads exactly the types a batch's queries touch — from types, relation hops, sub-selects, aliased creates — and skips writes", async () => {
    const t = fakeMeta();
    const s = new Schema(t);
    await s.ensureFor([
      { "@e": { AssetType: "Epic", Name: "x", Scope: "Scope:0" } },
      { from: "@e", select: ["Name", "Category.Name"] },
      { from: "Story:12", select: ["Estimate", { from: "Owners", select: ["Name"] }, "Status.Name", "Children:Task.@Count"] },
      { from: "Story", update: { Name: "y" } },
      { from: "Defect:1", execute: "Delete" }
    ]);
    // Children:Task.@Count needs no Task: a count is a number whatever it counts.
    expect(s.loaded.sort()).toEqual(["Epic", "EpicCategory", "Member", "Story", "StoryStatus"]);
    expect(t.calls.map((c) => c.path).sort()).toEqual(["/meta.v1/Epic", "/meta.v1/EpicCategory", "/meta.v1/Member", "/meta.v1/Story", "/meta.v1/StoryStatus"]);
    // Again: nothing to fetch.
    await s.ensureFor([{ from: "Story", select: ["Estimate", "Owners.Name"], page: { size: 1, start: 0 } }]);
    expect(t.calls).toHaveLength(5);
  });

  it("a schema seeded from a metamodel fetches nothing, and a seeded lazy schema fetches only what the seed lacks", async () => {
    const seeded = Schema.fromMetamodel({ Version: "x", AssetTypes: { Story: { _type: "AssetType", Name: "Story", Token: "Story", DisplayName: "Story", Abstract: false, Attributes: {} } } });
    expect(await seeded.load("Story")).not.toBeNull();
    expect(await seeded.load("Epic")).toBeNull(); // no transport: unknown stays unknown, and is not asked for again
    const t = fakeMeta();
    const lazy = new Schema(t, { Version: "x", AssetTypes: { Story: { _type: "AssetType", Name: "Story", Token: "Story", DisplayName: "Story", Abstract: false, Attributes: {} } } });
    await lazy.load("Story");
    await lazy.load("Epic");
    expect(t.calls.map((c) => c.path)).toEqual(["/meta.v1/Epic"]);
  });

  it("queryOf picks the query commands out of a batch, bare or aliased, and nothing else", () => {
    expect(queryOf({ from: "Story", select: ["Name"] })).toEqual({ from: "Story", select: ["Name"] });
    expect(queryOf({ "@q": { from: "Story" } })).toEqual({ from: "Story" });
    expect(queryOf({ from: "Story", update: {} })).toBeNull();
    expect(queryOf({ from: "Story:1", execute: "Delete" })).toBeNull();
    expect(queryOf({ "@s": { AssetType: "Story" } })).toBeNull();
    expect(queryOf("nope")).toBeNull();
  });
});

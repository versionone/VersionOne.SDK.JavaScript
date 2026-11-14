import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { createFetchTransport } from "../../src/core/fetchTransport";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema, TypeCache } from "../../src/services/schema";
import { etag, readAssetType, readMetamodel, type MetamodelDocument } from "../../src/wire/meta";

/**
 * meta.v1's one strong ETag for the whole schema, and what the SDK does
 * with it: a conditional read answers null on 304, the type cache keeps
 * the tag its types came with, and revalidate drops them when it moves.
 * Shapes as v1sdktesting sent them (2026-11-14).
 */
const document = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;
const TAG = '"26.3.1.13.636764259167912911"', NEXT = '"26.3.1.13.636764259170000000"';

/** A fake meta.v1 that honours If-None-Match against `current` and counts bodies sent. */
function metaServer(current = TAG) {
  const state = { current, bodies: 0 };
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const url = String(_url);
    if (headers["if-none-match"] === state.current) return new Response(null, { status: 304, headers: { etag: state.current } });
    state.bodies += 1;
    const path = url.slice(url.indexOf("/meta.v1") + "/meta.v1".length);
    const body = path === "" ? document : path.startsWith("/BaseAsset/Name") ? document.AssetTypes.BaseAsset!.Attributes["BaseAsset.Name"] : document.AssetTypes[path.slice(1)];
    return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { "content-type": "application/json", etag: state.current } });
  });
  return { state, transport: createFetchTransport({ baseUrl: "https://x", fetchImpl: fetchImpl as unknown as typeof fetch }) };
}

describe("conditional meta reads", () => {
  it("readMetamodel answers the document with its tag, and null without a download when the tag still matches", async () => {
    const { state, transport } = metaServer();
    const first = await readMetamodel(transport);
    expect(first?.etag).toBe(TAG);
    expect(Object.keys(first!.value.AssetTypes).length).toBeGreaterThan(100);
    expect(await readMetamodel(transport, { ifNoneMatch: TAG })).toBeNull();
    expect(state.bodies).toBe(1);
    state.current = NEXT;
    expect((await readMetamodel(transport, { ifNoneMatch: TAG }))?.etag).toBe(NEXT);
  });

  it("readAssetType and etag do the same with one type and with the smallest resource", async () => {
    const { state, transport } = metaServer();
    expect((await readAssetType(transport, "Story"))?.value.Token).toBe("Story");
    expect(await readAssetType(transport, "Story", { ifNoneMatch: TAG })).toBeNull();
    expect(await etag(transport)).toBe(TAG);
    expect(await etag(transport, { ifNoneMatch: TAG })).toBe(TAG);
    expect(state.bodies).toBe(2);
  });

  it("a 304 without acceptNotModified is still an error, as for any other status", async () => {
    const { transport } = metaServer();
    await expect(transport.request({ method: "GET", path: "/meta.v1/Story", headers: { "if-none-match": TAG }, responseType: "json" })).rejects.toMatchObject({ status: 304 });
  });
});

describe("TypeCache tag and Schema.revalidate", () => {
  it("a load records the tag; revalidate keeps the types while the tag holds and drops them when it moves", async () => {
    const { state, transport } = metaServer();
    const types = new TypeCache();
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport, types });
    await client.schema.load("Story");
    expect(types.etag).toBe(TAG);
    expect(client.schema.assetType("Story")?.Token).toBe("Story");
    expect(await client.schema.revalidate()).toEqual({ changed: false, etag: TAG });
    expect(client.schema.assetType("Story")?.Token).toBe("Story");
    state.current = NEXT;
    expect(await client.schema.revalidate()).toEqual({ changed: true, etag: NEXT });
    expect(client.schema.assetType("Story")).toBeUndefined();
    expect(types.etag).toBe(NEXT);
    await client.schema.load("Story");
    expect(state.bodies).toBe(3); // Story, the probe that saw the new tag, Story again
  });

  it("a seeded schema never changes; a cache with no tag yet is treated as stale once", async () => {
    const seeded = Schema.fromMetamodel({ Version: "0", AssetTypes: {} });
    expect(await seeded.revalidate()).toEqual({ changed: false, etag: null });
    const { transport } = metaServer();
    const fresh = new Schema(transport);
    expect(await fresh.revalidate()).toEqual({ changed: true, etag: TAG });
    expect(await fresh.revalidate()).toEqual({ changed: false, etag: TAG });
  });

  it("a transport that hides headers leaves the tag null, and revalidate reloads rather than guessing", async () => {
    const calls: RequestOptions[] = [];
    const blind: Transport = { request: vi.fn(async (o: RequestOptions) => { calls.push(o); return document.AssetTypes.Story; }) as Transport["request"] };
    const schema = new Schema(blind);
    await schema.load("Story");
    expect(schema.cache.etag).toBeNull();
    expect(await schema.revalidate()).toEqual({ changed: true, etag: null });
    expect(schema.assetType("Story")).toBeUndefined();
  });
});

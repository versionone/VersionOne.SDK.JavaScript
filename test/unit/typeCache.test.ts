import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { Schema, TypeCache } from "../../src/services/schema";
import { toMetamodel, type MetamodelDocument } from "../../src/wire/meta";

const metamodel = JSON.parse(readFileSync(join(__dirname, "..", "..", "metamodel.json"), "utf8")) as MetamodelDocument;

/** A transport per user: answers meta.v1 and records who asked. */
function userTransport(user: string, log: string[]): Transport {
  const request = vi.fn(async (o: RequestOptions) => {
    log.push(`${user} ${o.path}`);
    if (o.path.startsWith("/meta.v1/")) {
      // A real server takes a moment; concurrent loads must share one request.
      await new Promise((r) => setTimeout(r, 5));
      return metamodel.AssetTypes[o.path.slice("/meta.v1/".length)];
    }
    return { requestId: "r", assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 }, commandFailures: { commands: [], count: 0 }, queryResult: { results: [[]], resultMetaData: [], count: -1 } };
  });
  return { request: request as Transport["request"] };
}

describe("TypeCache: one instance's types shared across clients with different credentials", () => {
  it("each type is fetched once, by whichever client needed it first; later clients load only what is missing", async () => {
    const log: string[] = [];
    const types = new TypeCache();
    const alice = new AgilityApiClient({ baseUrl: "https://x" }, { transport: userTransport("alice", log), types });
    const bob = new AgilityApiClient({ baseUrl: "https://x" }, { transport: userTransport("bob", log), types });
    await alice.assets.query({ from: "Story", select: ["Estimate"], page: { size: 1, start: 0 } });
    await bob.assets.query({ from: "Story", select: ["Estimate", { from: "Status", select: ["Name"] }], page: { size: 1, start: 0 } });
    expect(log.filter((l) => l.includes("meta.v1"))).toEqual(["alice /meta.v1/Story", "bob /meta.v1/StoryStatus"]);
    expect(alice.schema.cache).toBe(types);
    expect(bob.schema.assetType("StoryStatus")).toBeDefined();
  });

  it("concurrent loads of one type share a request, and withTransport keeps the cache", async () => {
    const log: string[] = [];
    const a = new Schema(userTransport("alice", log));
    const b = a.withTransport(userTransport("bob", log));
    await Promise.all([a.load("Defect"), b.load("Defect")]);
    expect(log).toEqual(["alice /meta.v1/Defect"]);
    expect(b.cache).toBe(a.cache);
    expect(b.loaded).toContain("Defect");
  });

  it("a cache seeded from a metamodel fetches nothing", async () => {
    const log: string[] = [];
    const types = TypeCache.fromMetamodel(toMetamodel(metamodel));
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: userTransport("carol", log), types });
    await client.assets.query({ from: "Story", select: ["Estimate", { from: "Status", select: ["Name"] }], page: { size: 1, start: 0 } });
    expect(log).toEqual(["carol /api/asset"]);
  });
});

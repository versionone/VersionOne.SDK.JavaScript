import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * CommonJS consumers (the CLI consumer is `require`-based) load the package through
 * the "require" condition of its exports map. This builds the CJS bundle
 * the way the package does, installs it under node_modules/@versionone/agility-sdk
 * in a temp directory with the real package.json, and has a plain .cjs
 * script `require("@versionone/agility-sdk")` and use it — so a bundle that only
 * works as ESM (top-level await, import.meta, an ESM-only dependency) or an
 * exports map that points nowhere fails here, not in a consumer.
 */
const root = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, Record<string, Record<string, string>>> };
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sdk-cjs-"));
  const installed = join(dir, "node_modules", "@versionone", "agility-sdk");
  // tsup reads entries as glob patterns, where "\\" is an escape: on Windows an
  // absolute path (D:\\source\\…) matches nothing. Forward slashes work everywhere.
  const entry = (...parts: string[]) => join(root, "src", ...parts).replace(/\\/g, "/");
  // The package's own entries and splitting (tsup.config.ts): shared code in chunks, so the three import paths share one copy of every class.
  await build({ config: false, entry: { index: entry("index.ts"), wire: entry("wire", "index.ts"), services: entry("services", "index.ts"), testing: entry("testing", "index.ts") }, format: ["cjs"], splitting: true, outDir: join(installed, "dist"), target: "node22", dts: false, sourcemap: false, silent: true });
  copyFileSync(join(root, "package.json"), join(installed, "package.json"));
}, 30_000);
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// The consumer: CommonJS, no transpiler, a fake fetch standing in for the server.
const CONSUMER = String.raw`
const assert = require("node:assert/strict");
const sdk = require("@versionone/agility-sdk");
for (const name of ["AgilityApiClient", "createFetchTransport", "ApiError", "CommandFailureError", "TypeCache", "parseOid", "momentless", "normalizeQuery"]) {
  assert.ok(sdk[name], "missing export " + name);
}
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const seen = [];
const fetchImpl = async (url) => {
  seen.push(String(url));
  if (String(url).includes("/loc-2.v1")) return json({ "Plural'Story": "Backlog Items" });
  return json({ assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
    commandFailures: { count: 1, commands: [{ "@x": { AssetType: "Story" }, error: { message: "Violation'Required'Scope", sourceCommandIndex: 0 } }] },
    queryResult: { results: [], resultMetaData: [], count: -1 } });
};
(async () => {
  const transport = sdk.createFetchTransport({ baseUrl: "https://v1.example/inst", accessToken: "t", fetchImpl });
  const client = new sdk.AgilityApiClient({ baseUrl: "https://v1.example/inst" }, { transport });
  assert.deepEqual(await client.localize(["Plural'Story"]), { "Plural'Story": "Backlog Items" });
  const err = await client.send([{ AssetType: "Story", Name: "x" }], { throwOnFailure: true }).catch((e) => e);
  assert.ok(err instanceof sdk.CommandFailureError && err instanceof sdk.ApiError && err instanceof Error);
  assert.equal(err.failures[0].index, 0);
  assert.equal(sdk.momentless("Story:1:99"), "Story:1");
  // The other import paths resolve, and share the root's classes: one ApiError, one client.
  const wire = require("@versionone/agility-sdk/wire");
  const { FakeAgilityClient } = require("@versionone/agility-sdk/testing");
  for (const name of ["assetApi", "queryV1", "rest1", "meta", "loc2", "attachment", "fields", "select"]) {
    assert.ok(wire[name], "missing wire module " + name);
    assert.equal(sdk[name], undefined, "the root no longer exports the wire module " + name);
  }
  assert.equal(wire.assetApi.CommandFailureError, sdk.CommandFailureError);
  const services = require("@versionone/agility-sdk/services");
  for (const name of ["attachments", "batch", "fields", "guard", "resolve", "schema"]) assert.ok(services[name], "missing service module " + name);
  for (const name of ["sendGuarded", "runBatch", "resolveNumbers", "NUMBER_ROOTS", "stampsOf"]) assert.equal(sdk[name], undefined, "the root no longer exports the free function " + name);
  assert.equal(services.guard.unguardable, sdk.unguardable);
  assert.equal(services.guard.ConflictError, sdk.ConflictError);
  assert.equal(services.schema.TypeCache, sdk.TypeCache);
  assert.equal(sdk.toBase64(new Uint8Array([104, 105])), "aGk=");
  // The package's own manifest is reachable, for tools that read a dependency's version: by require and by import.
  assert.equal(require("@versionone/agility-sdk/package.json").name, "@versionone/agility-sdk");
  const manifest = await import("@versionone/agility-sdk/package.json", { with: { type: "json" } });
  assert.equal(manifest.default.version, require("@versionone/agility-sdk/package.json").version);
  const fake = new FakeAgilityClient().onQuery("Story", [{ _oid: "Story:1", Name: "n" }]);
  assert.ok(fake instanceof sdk.AgilityApiClient);
  assert.deepEqual(await fake.query({ from: "Story", select: ["Name"], page: { size: 5, start: 0 } }), [{ _oid: "Story:1", Name: "n" }]);
  const unscripted = await fake.query({ from: "Epic", page: { size: 1, start: 0 } }).catch((e) => e);
  assert.ok(unscripted instanceof sdk.UsageError);
  process.stdout.write("ok " + seen.length);
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
`;

describe("CommonJS consumers", () => {
  it("require('@versionone/agility-sdk') resolves through the exports map and the bundle works with no ESM in sight", () => {
    const script = join(dir, "consumer.cjs");
    writeFileSync(script, CONSUMER);
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("ok 2");
    expect(r.status).toBe(0);
  });

  it("each condition of the exports map carries its own types: .d.cts for require, .d.ts for import — one shared .d.ts would type CJS callers as ESM", () => {
    const entry = pkg.exports["."]!;
    expect(entry.require).toEqual({ types: "./dist/index.d.cts", default: "./dist/index.cjs" });
    expect(entry.import).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect((pkg.exports as unknown as Record<string, unknown>)["./package.json"]).toBe("./package.json");
    for (const path of ["wire", "services", "testing"]) {
      expect(pkg.exports[`./${path}`]).toEqual({ import: { types: `./dist/${path}.d.ts`, default: `./dist/${path}.js` }, require: { types: `./dist/${path}.d.cts`, default: `./dist/${path}.cjs` } });
    }
  });
});

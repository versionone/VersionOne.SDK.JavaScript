import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * CommonJS consumers (gh-v1 is `require`-based) load the package through
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
  await build({ config: false, entry: [join(root, "src", "index.ts")], format: ["cjs"], outDir: join(installed, "dist"), target: "node18", dts: false, sourcemap: false, silent: true });
  copyFileSync(join(root, "package.json"), join(installed, "package.json"));
}, 30_000);
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// The consumer: CommonJS, no transpiler, a fake fetch standing in for the server.
const CONSUMER = String.raw`
const assert = require("node:assert/strict");
const sdk = require("@versionone/agility-sdk");
for (const name of ["AgilityApiClient", "createFetchTransport", "ApiError", "CommandFailureError", "assetApi", "rest1", "meta", "loc2", "Schema", "parseOid", "momentless"]) {
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
  const err = await client.assets.send([{ AssetType: "Story", Name: "x" }], { throwOnFailure: true }).catch((e) => e);
  assert.ok(err instanceof sdk.CommandFailureError && err instanceof sdk.ApiError && err instanceof Error);
  assert.equal(err.failures[0].index, 0);
  assert.equal(sdk.momentless("Story:1:99"), "Story:1");
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
  });
});

import { cpSync, existsSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A TypeScript consumer finds the types of all four import paths, whatever
 * its `moduleResolution`. The older "node" (node10) resolution ignores the
 * package's `exports` map, so the subpaths resolve there only through
 * `typesVersions`: without it, `@versionone/agility-sdk/testing` runs (the
 * bundlers and test runners read `exports`) and does not compile.
 *
 * Installs the built package (dist/ and the real package.json) under
 * node_modules in a temp directory and compiles a consumer file against it.
 * It needs the declarations in dist/, which `npm run verify` builds before
 * the tests; without them it says so and skips.
 */
const root = join(__dirname, "..", "..");
const built = ["index", "wire", "services", "testing"].every((entry) => existsSync(join(root, "dist", `${entry}.d.ts`)) && existsSync(join(root, "dist", `${entry}.d.cts`)));
let dir = "";

beforeAll(() => {
  if (!built) return;
  dir = mkdtempSync(join(tmpdir(), "sdk-types-"));
  const installed = join(dir, "node_modules", "@versionone", "agility-sdk");
  mkdirSync(installed, { recursive: true });
  cpSync(join(root, "dist"), join(installed, "dist"), { recursive: true });
  copyFileSync(join(root, "package.json"), join(installed, "package.json"));
  writeFileSync(join(dir, "consumer.ts"), [
    `import { AgilityApiClient, type Outcome } from "@versionone/agility-sdk";`,
    `import { rest1 } from "@versionone/agility-sdk/wire";`,
    `import { search } from "@versionone/agility-sdk/services";`,
    `import { FakeAgilityClient, transportConformance } from "@versionone/agility-sdk/testing";`,
    `export const fake: AgilityApiClient = new FakeAgilityClient();`,
    `export const used = [rest1.list, search.search, transportConformance];`,
    `export type O = Outcome;`,
    ``
  ].join("\n"));
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const RESOLUTIONS: [string, ts.CompilerOptions][] = [
  ["node (node10)", { module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 }],
  ["node16", { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 }],
  ["bundler", { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }]
];

describe("the package's types, as a consumer's compiler resolves them", () => {
  for (const [name, options] of RESOLUTIONS) {
    it.skipIf(!built)(`all four import paths compile under moduleResolution ${name}${built ? "" : " [skipped: run `npm run build` first]"}`, () => {
      const program = ts.createProgram([join(dir, "consumer.ts")], { ...options, target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: true, types: [] });
      const problems = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(problems).toEqual([]);
    }, 60_000);
  }
});

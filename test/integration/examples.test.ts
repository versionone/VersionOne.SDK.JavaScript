import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { describeInstance, instance } from "./instance";

/**
 * Every file in examples/ runs as a consumer would run it (plain `node`,
 * importing the built package by name), exits 0, and takes well under a
 * minute. This is what keeps the examples true: an API change that breaks
 * one fails here, and `npm run typecheck` compiles them on every push.
 *
 * The examples read V1_URL and V1_ACCESS_TOKEN, so the suite needs the
 * instance as a URL and a token (it skips for a profile with a password),
 * a build in dist/, and a Node that runs TypeScript files directly.
 */
const root = join(import.meta.dirname, "..", "..");
const examples = readdirSync(join(root, "examples")).filter((f) => /^\d\d-.*\.ts$/.test(f)).sort();
const token = process.env.SDK_TEST_URL ? process.env.SDK_TEST_ACCESS_TOKEN : process.env.V1_ACCESS_TOKEN;
const built = existsSync(join(root, "dist", "index.js")) && existsSync(join(root, "dist", "testing.js"));
const runsTypeScript = Boolean((process.features as { typescript?: unknown }).typescript);
const why = !token ? "needs the instance as SDK_TEST_URL + SDK_TEST_ACCESS_TOKEN or V1_URL + V1_ACCESS_TOKEN" : !built ? "run `npm run build` first" : !runsTypeScript ? "this Node does not run .ts files" : null;

describeInstance("examples (live)", () => {
  it("there are examples to run", () => expect(examples.length).toBeGreaterThan(0));

  for (const file of examples) {
    it.skipIf(why !== null)(`${file} runs to the end${why ? ` [skipped: ${why}]` : ""}`, () => {
      const started = Date.now();
      const run = spawnSync(process.execPath, [join("examples", file)], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, V1_URL: instance!.url, V1_ACCESS_TOKEN: token!, V1_EXAMPLES_WRITE: "1" }
      });
      // The output goes into the failure message, minus where it ran.
      const output = `${run.stdout}\n${run.stderr}`.split(instance!.url).join("<instance>");
      expect(run.status, output).toBe(0);
      expect(Date.now() - started).toBeLessThan(30_000);
    }, 65_000);
  }
});

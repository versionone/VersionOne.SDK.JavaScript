import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * specs/000-layers.md, section 8, enforced: this repository is public, so
 * nothing in the tree names a Claude session, another GitHub repository
 * under the product's organisations, or a hosted instance. The patterns
 * are shapes, not a list of names — a list would be the very thing this
 * test keeps out.
 */
const root = join(__dirname, "..", "..");
/** Not scanned: tooling output, dependencies, and `plans/` while it is on its way out of the tree. */
const SKIPPED = new Set([".git", "node_modules", "dist", "coverage", "plans"]);
/** The one hosted URL the tree may carry: the product documentation's own example. */
const EXAMPLE_INSTANCE = "www7.v1host.com/V1Production";

const SHAPES: { what: string; pattern: RegExp }[] = [
  { what: "a Claude session id", pattern: /\bsession_[A-Za-z0-9]{20,}\b/g },
  { what: "a GitHub repository other than this one", pattern: /(?<![@\w-])(?:versionone|digital-ai)\/(?!VersionOne\.SDK\.JavaScript\b)[A-Za-z0-9._-]+/gi },
  { what: "a hosted instance URL", pattern: /\bwww\d*\.v1host\.com\/[A-Za-z0-9._-]+/gi }
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIPPED.has(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("public tree", () => {
  it("names no session, no other repository and no hosted instance (spec 000 §8)", () => {
    const found: string[] = [];
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      for (const { what, pattern } of SHAPES) {
        for (const m of text.matchAll(pattern)) {
          if (what === "a hosted instance URL" && m[0].toLowerCase() === EXAMPLE_INSTANCE.toLowerCase()) continue;
          found.push(`${relative(root, file)}: ${what}: ${m[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

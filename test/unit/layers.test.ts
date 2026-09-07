import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * specs/000-layers.md, section 1, enforced: imports point down the table
 * and never up. Not taste — a dependency in the wrong direction is what
 * lets an envelope leak into the model.
 */
const src = join(__dirname, "..", "..", "src");

/** The layer a src file belongs to, from its first path segment. */
const layerOf = (file: string): string => relative(src, file).split(/[\\/]/)[0]!;

/** What each layer may import. `core` and `types` import nothing above them. */
const ALLOWED: Record<string, string[]> = {
  core: ["core"],
  types: ["types"],
  wire: ["wire", "types", "core"],
  services: ["services", "wire", "types", "core"]
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
}

/** Relative imports of a file, resolved to the layer they land in. */
function importedLayers(file: string): { spec: string; layer: string }[] {
  const text = readFileSync(file, "utf8");
  const specs = [...text.matchAll(/from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]!);
  return specs.map((spec) => ({ spec, layer: layerOf(join(file, "..", spec)) }));
}

describe("layers", () => {
  it("every src file imports only from its own layer or the layers below it", () => {
    const files = walk(src).filter((f) => relative(src, f).includes("\\") || relative(src, f).includes("/")); // files inside a layer directory
    const violations: string[] = [];
    for (const file of files) {
      const layer = layerOf(file);
      const allowed = ALLOWED[layer];
      if (!allowed) { violations.push(`${relative(src, file)}: unknown layer "${layer}" — add it to specs/000-layers.md and to this test`); continue; }
      for (const { spec, layer: target } of importedLayers(file)) {
        if (!allowed.includes(target)) violations.push(`${relative(src, file)} imports ${spec} (${target}); ${layer} may import only ${allowed.join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("envelope types live in the wire module that owns them, never in types", () => {
    const leaks: string[] = [];
    for (const file of walk(join(src, "types"))) {
      const text = readFileSync(file, "utf8");
      // rest-1's per-value wrapper announces itself as _type "Attribute"; the
      // bare word Attributes is meta.v1's own name for a type's attribute map
      // and belongs in the metamodel types.
      for (const word of ["oidTokens", "commandFailures", "queryResult", "previewOnly", "\"Attribute\"", "resultMetaData", "pageStart"]) {
        if (text.includes(word)) leaks.push(`${relative(src, file)} mentions ${word}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

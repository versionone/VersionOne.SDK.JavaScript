#!/usr/bin/env node
/**
 * Pull an instance's metamodel (meta.v1) into metamodel.json, the source
 * src/types/assets is generated from (npm run generate:types).
 *
 *   npm run download:metamodel -- <baseAgilityUrl> [output-file] [--raw]
 *
 * The committed metamodel is the PRODUCT's: what every instance of a
 * release has. meta.v1 also describes the instance's own definitions, so by
 * default they are stripped (spec 000 §4):
 *   - its custom list types (Token `Custom_<Name>`, the one custom asset
 *     type Agility allows, Base List);
 *   - its custom attributes (IsCustom and not IsCanned: `Custom_…`, and the
 *     `ReciprocalOf_…` reverse side the server adds on a custom relation's
 *     target) — the product's canned "custom" attributes (IsCanned too)
 *     stay;
 *   - anything left that still points at a stripped type or attribute.
 * Every `href` is also rewritten to start at `/meta.v1/`: meta.v1 spells
 * them from the instance's own path (`/<instance>/meta.v1/Story`), which
 * is the instance's name, not the product's. Nothing in the SDK reads an
 * href (`src/wire/meta.ts` follows `tokenref` and `nameref`).
 * `--raw` keeps everything, for looking at one instance.
 *
 * The cleanest source is a dev instance on a blank database (the product's dev
 * tooling has a task for that), where nothing needs stripping; a hosted
 * instance on the current release gives the same product definitions once stripped, and
 * the script reports what it removed so the pull can be reviewed. meta.v1
 * needs no authentication; `V1_ACCESS_TOKEN` is sent when set. Behind a
 * proxy, run with NODE_USE_ENV_PROXY=1.
 *
 * The output is JSON.stringify'd (2 spaces), so two pulls of the same
 * release diff cleanly whatever the server's own formatting.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function printUsage() {
  process.stderr.write(
    "Usage: npm run download:metamodel -- <baseAgilityUrl> [output-file] [--raw]\n" +
      "Example: npm run download:metamodel -- https://agility.example.com/MyInstance metamodel.json\n"
  );
}

/** The instance's own definitions removed; what was removed, for the report. */
export function canned(metamodel) {
  const removed = { types: [], attributes: [], dangling: [] };
  const types = {};
  for (const [token, type] of Object.entries(metamodel.AssetTypes)) {
    if (token.startsWith("Custom_")) { removed.types.push(token); continue; }
    types[token] = type;
  }
  const droppedAttribute = new Set();
  for (const type of Object.values(types)) {
    for (const [key, a] of Object.entries(type.Attributes ?? {})) {
      if (a.IsCustom && !a.IsCanned) { removed.attributes.push(a.Token); droppedAttribute.add(a.Token); delete type.Attributes[key]; }
    }
  }
  // A second pass for what still points into the removed set: a relation
  // to a custom list type, a Base or reciprocal on a removed attribute.
  for (const type of Object.values(types)) {
    for (const [key, a] of Object.entries(type.Attributes ?? {})) {
      const refs = [a.RelatedAsset?.nameref && !types[a.RelatedAsset.nameref] ? `RelatedAsset ${a.RelatedAsset.nameref}` : null,
        a.Base?.tokenref && droppedAttribute.has(a.Base.tokenref) ? `Base ${a.Base.tokenref}` : null,
        a.ReciprocalRelation?.tokenref && droppedAttribute.has(a.ReciprocalRelation.tokenref) ? `ReciprocalRelation ${a.ReciprocalRelation.tokenref}` : null].filter(Boolean);
      if (refs.length) { removed.dangling.push(`${a.Token} (${refs.join(", ")})`); delete type.Attributes[key]; }
    }
    if (type.Base?.nameref && !types[type.Base.nameref]) throw new Error(`${type.Token} extends ${type.Base.nameref}, which was removed`);
  }
  return { metamodel: { ...metamodel, AssetTypes: types }, removed };
}

/** Every href spelled from `/meta.v1/`, whatever instance path the server put in front of it. */
export function neutralise(value) {
  if (Array.isArray(value)) return value.map(neutralise);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = (key === "href" || key === "HREF") && typeof v === "string" ? v.replace(/^.*?(\/meta\.v1(?=\/|$))/, "$1") : neutralise(v);
    }
    return out;
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const raw = args.includes("--raw");
  const [baseAgilityUrl, outputFile] = args.filter((a) => !a.startsWith("--"));
  const targetOutputFile = outputFile || "metamodel.json";
  if (!baseAgilityUrl) { printUsage(); process.exitCode = 1; return; }

  let metamodelUrl;
  try {
    const parsedUrl = new URL(baseAgilityUrl);
    if (!parsedUrl.pathname.endsWith("/")) parsedUrl.pathname += "/";
    metamodelUrl = new URL("meta.v1", parsedUrl);
  } catch {
    process.stderr.write(`Invalid URL: ${baseAgilityUrl}\n`);
    process.exitCode = 1;
    return;
  }

  const headers = { Accept: "application/json" };
  if (process.env.V1_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.V1_ACCESS_TOKEN}`;
  const response = await fetch(metamodelUrl, { method: "GET", headers });
  if (!response.ok) {
    process.stderr.write(`Request to ${metamodelUrl} failed: ${response.status} ${response.statusText}\n`);
    process.exitCode = 1;
    return;
  }
  const delivered = await response.json();
  if (!delivered?.AssetTypes || typeof delivered.Version !== "string") throw new Error(`${metamodelUrl} did not answer a metamodel`);

  let out = delivered;
  if (!raw) {
    const { metamodel, removed } = canned(delivered);
    out = neutralise(metamodel);
    const list = (what, items) => items.length ? `  ${what} (${items.length}): ${items.join(", ")}\n` : `  ${what}: none\n`;
    process.stderr.write(`meta.v1 ${delivered.Version}: ${Object.keys(delivered.AssetTypes).length} types delivered, ${Object.keys(metamodel.AssetTypes).length} kept. Instance-specific definitions removed:\n${list("custom list types", removed.types)}${list("custom attributes", removed.attributes)}${list("left pointing at those", removed.dangling)}`);
  }

  const targetPath = resolve(process.cwd(), targetOutputFile);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  process.stdout.write(`Saved meta.v1 ${out.Version} (${Object.keys(out.AssetTypes).length} types${raw ? ", raw" : ""}) to ${targetPath}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((error) => {
    process.stderr.write(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

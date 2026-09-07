#!/usr/bin/env node
/* eslint-disable no-undef */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function printUsage() {
  process.stderr.write(
    "Usage: npm run download:metamodel -- <baseAgilityUrl> <output-file>\n" +
      "Example: npm run download:metamodel -- https://example.com/instancename metamodel.json\n",
  );
}

async function main() {
  const [, , baseAgilityUrl, outputFile] = process.argv;
  const targetOutputFile = outputFile || "metamodel.json";
  if (!baseAgilityUrl) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  let parsedUrl;
  let metamodelUrl;

  try {
    parsedUrl = new URL(baseAgilityUrl);
    if (!parsedUrl.pathname.endsWith("/")) {
      parsedUrl.pathname += "/";
    }
    metamodelUrl = new URL("meta.v1", parsedUrl);
  } catch {
    process.stderr.write(`Invalid URL: ${baseAgilityUrl}\n`);
    process.exitCode = 1;
    return;
  }

  const response = await fetch(metamodelUrl, {
    method: "GET",
    headers: {
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    process.stderr.write(`Request to ${metamodelUrl} failed: ${response.status} ${response.statusText}\n`);
    process.exitCode = 1;
    return;
  }

  const body = await response.text();
  const targetPath = resolve(process.cwd(), targetOutputFile);

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, body, "utf8");

  process.stdout.write(`Saved response body to ${targetPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
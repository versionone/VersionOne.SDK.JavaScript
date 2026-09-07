/**
 * The dev instance the integration tier runs against.
 *
 * Resolution, in order: SDK_TEST_URL + SDK_TEST_AUTHORIZATION (a ready
 * Authorization header value) or SDK_TEST_ACCESS_TOKEN; else the profile
 * named by SDK_TEST_INSTANCE (default "local") in ~/.v1config/v1api/
 * config.json, the file gh-v1 and Core's gulp v1api helper share. The
 * credential is read in-process and handed to the transport; it is never
 * logged. No instance configured: every integration suite skips with a
 * message. A profile whose URL looks like production is refused — the
 * integration tier writes fixtures, and never to V1Production.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { createFetchTransport } from "../../src/core/fetchTransport";
import type { Transport } from "../../src/core/transport";

export interface Instance { name: string; url: string; transport: Transport }

function fromProfile(): Instance | null {
  const name = process.env.SDK_TEST_INSTANCE ?? "local";
  const file = process.env.V1_CONFIG_FILE ?? join(homedir(), ".v1config", "v1api", "config.json");
  let all: Record<string, { v1Url?: string; v1AccessToken?: string; v1Username?: string; v1Password?: string }>;
  try { all = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const p = all[name];
  if (!p?.v1Url) return null;
  const authorization = p.v1AccessToken ? `Bearer ${p.v1AccessToken}` : p.v1Username && p.v1Password ? `Basic ${Buffer.from(`${p.v1Username}:${p.v1Password}`).toString("base64")}` : null;
  if (!authorization) return null;
  return { name, url: p.v1Url.replace(/\/+$/, ""), transport: createFetchTransport({ baseUrl: p.v1Url, authorization }) };
}

function fromEnv(): Instance | null {
  const url = process.env.SDK_TEST_URL;
  if (!url) return null;
  const authorization = process.env.SDK_TEST_AUTHORIZATION ?? (process.env.SDK_TEST_ACCESS_TOKEN ? `Bearer ${process.env.SDK_TEST_ACCESS_TOKEN}` : undefined);
  if (!authorization) return null;
  return { name: "env", url: url.replace(/\/+$/, ""), transport: createFetchTransport({ baseUrl: url, authorization }) };
}

const PRODUCTION = /v1host\.com|V1Production/i;

export const instance: Instance | null = (() => {
  const i = fromEnv() ?? fromProfile();
  if (i && PRODUCTION.test(i.url)) throw new Error(`integration tests write fixtures and must not run against ${i.url}; point SDK_TEST_INSTANCE at a dev instance`);
  return i;
})();

/** describe() that runs only when an instance is configured, and says why when it is not. */
export const describeInstance: typeof describe = ((name: string, fn: () => void) =>
  instance ? describe(`${name} [${instance.name}: ${instance.url}]`, fn) : describe.skip(`${name} [no dev instance: set SDK_TEST_INSTANCE to a ~/.v1config profile, or SDK_TEST_URL + SDK_TEST_AUTHORIZATION]`, fn)) as typeof describe;

/** A fixture name nobody will mistake for real data, unique per run. */
export const fixtureName = (what: string): string => `sdk-integration ${what} ${new Date().toISOString().replace(/[:.]/g, "-")}`;

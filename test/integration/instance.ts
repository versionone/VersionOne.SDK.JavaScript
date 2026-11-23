/**
 * The dev instance the integration tier runs against.
 *
 * Resolution, in order: SDK_TEST_URL + SDK_TEST_AUTHORIZATION (a ready
 * Authorization header value) or SDK_TEST_ACCESS_TOKEN; else V1_URL +
 * V1_ACCESS_TOKEN (the names the CLI consumer and the cloud environment
 * use); else the profile named by SDK_TEST_INSTANCE (default "local") in
 * ~/.v1config/v1api/config.json, the file the CLI consumer and the
 * product's dev tooling share. The credential is read in-process and
 * handed to the transport; it is never logged. No instance configured:
 * every integration suite skips with a message.
 *
 * The integration tier writes fixtures, so where it may run is a list, not
 * a guess: a local dev instance, or a hosted instance set aside for API
 * testing and named in SDK_TEST_ALLOWED_INSTANCES (comma-separated base
 * URLs). Any other hosted URL (v1host.com), and anything named
 * V1Production, is refused. The list is not committed: a hosted instance's
 * URL is the instance's name, and this repository is public. Whoever runs
 * the tier against a hosted instance sets the variable beside the
 * credential (a local profile needs nothing).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { createFetchTransport } from "../../src/core/fetchTransport";
import type { Transport } from "../../src/core/transport";
import { apiTestInstances, isHosted, permitted, trim } from "./instanceGuard";

export interface Instance {
  name: string;
  url: string;
  transport: Transport;
  /** "hosted" for an allowed API-testing instance on v1host.com: shared, so no suite may recycle its app domain. */
  kind: "local" | "hosted";
}

function fromProfile(): Instance | null {
  const name = process.env.SDK_TEST_INSTANCE ?? "local";
  const file = process.env.V1_CONFIG_FILE ?? join(homedir(), ".v1config", "v1api", "config.json");
  let all: Record<string, { v1Url?: string; v1AccessToken?: string; v1Username?: string; v1Password?: string }>;
  try { all = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const p = all[name];
  if (!p?.v1Url) return null;
  const authorization = p.v1AccessToken ? `Bearer ${p.v1AccessToken}` : p.v1Username && p.v1Password ? `Basic ${Buffer.from(`${p.v1Username}:${p.v1Password}`).toString("base64")}` : null;
  if (!authorization) return null;
  return make(name, p.v1Url, authorization);
}

function fromEnv(): Instance | null {
  const sdk = process.env.SDK_TEST_URL;
  if (sdk) {
    const authorization = process.env.SDK_TEST_AUTHORIZATION ?? (process.env.SDK_TEST_ACCESS_TOKEN ? `Bearer ${process.env.SDK_TEST_ACCESS_TOKEN}` : undefined);
    if (authorization) return make("env", sdk, authorization);
  }
  const v1 = process.env.V1_URL;
  if (v1 && process.env.V1_ACCESS_TOKEN) return make("V1_URL", v1, `Bearer ${process.env.V1_ACCESS_TOKEN}`);
  return null;
}

function make(name: string, url: string, authorization: string): Instance {
  return { name, url: trim(url), kind: isHosted(url) ? "hosted" : "local", transport: createFetchTransport({ baseUrl: url, authorization }) };
}

export const instance: Instance | null = (() => {
  const i = fromEnv() ?? fromProfile();
  if (!i) return null;
  if (!permitted(i.url, apiTestInstances())) {
    throw new Error(`integration tests write fixtures and must not run against ${i.url}; use a local dev instance, or a hosted instance set aside for API testing and named in SDK_TEST_ALLOWED_INSTANCES`);
  }
  return i;
})();

/** describe() that runs only when an instance is configured, and says why when it is not. */
export const describeInstance: typeof describe = ((name: string, fn: () => void) =>
  instance ? describe(`${name} [${instance.name}: ${instance.url}]`, fn) : describe.skip(`${name} [no dev instance: set SDK_TEST_INSTANCE to a ~/.v1config profile, or SDK_TEST_URL + SDK_TEST_AUTHORIZATION]`, fn)) as typeof describe;

/**
 * describeInstance for suites that recycle the app domain (custom fields):
 * local instances only. A hosted testing instance is shared, and a recycle
 * stalls everyone using it.
 */
export const describeLocalInstance: typeof describe = ((name: string, fn: () => void) =>
  instance?.kind === "local" ? describe(`${name} [${instance.name}: ${instance.url}]`, fn) : describe.skip(`${name} [${instance ? `skipped on hosted ${instance.url}: recycles the app domain` : "no dev instance"}]`, fn)) as typeof describe;

/** A fixture name nobody will mistake for real data, unique per run. */
export const fixtureName = (what: string): string => `sdk-integration ${what} ${new Date().toISOString().replace(/[:.]/g, "-")}`;

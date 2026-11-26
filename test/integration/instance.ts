/**
 * What the integration suites share: `describe` wrappers that skip with a
 * reason when no instance is configured, fixture names, and the creation
 * and removal of fixtures. Which instance, and where the tier may run, is
 * decided in instanceConfig.ts (kept free of the test runner, so the
 * preflight can use it too).
 */
import { describe } from "vitest";
import type { Transport } from "../../src/core/transport";
import { CommandFailureError, momentless, send, type AssetApiResponse } from "../../src/wire/assetApi";
import type { Command } from "../../src/types/command";
import { instance, type Instance } from "./instanceConfig";
import { assertNotReference } from "./referenceData";

export { instance, type Instance };

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

/**
 * Deletes a suite's fixtures by exact OID, in the order given, and throws
 * if any is still there: a fixture left behind is a failure, not a shrug.
 * Agility refuses to delete a closed asset, so one that would not delete
 * is reactivated and deleted again. An asset already gone is fine (the
 * server answers a command for it with success). Before anything is
 * deleted the names are read: permanent reference data (named
 * `sdk-reference …`) in the list stops the whole cleanup with an error.
 */
export async function deleteFixtures(transport: Transport, oids: readonly string[]): Promise<void> {
  await assertNotReference(transport, oids);
  const left: string[] = [];
  for (const oid of oids) {
    const first = await send(transport, [{ from: oid, execute: "Delete" }]);
    if (!first.commandFailures?.count) continue;
    const second = await send(transport, [{ from: oid, execute: "Reactivate" }, { from: oid, execute: "Delete" }]);
    const failed = second.commandFailures?.commands ?? [];
    if (failed.some((c) => JSON.stringify(c).includes("Delete"))) left.push(`${oid}: ${JSON.stringify(failed.at(-1)?.error)}`);
  }
  if (left.length) throw new Error(`fixtures left behind:\n${left.join("\n")}`);
}

/**
 * Creates a suite's fixtures in one batch. A batch can partly succeed (the
 * server applies the commands it accepts and reports the rest), and a
 * setup that threw on the failures used to leave what was created with
 * nobody holding its OID. This removes whatever was created before it
 * throws, so a failed setup leaves nothing behind.
 */
export async function sendFixtures(transport: Transport, commands: Command[]): Promise<AssetApiResponse> {
  const response = await send(transport, commands);
  if (!response.commandFailures?.count) return response;
  const made = (response.assetsCreated?.oidTokens ?? []).map(momentless);
  // Newest first: what was created later may point at what was created earlier.
  await deleteFixtures(transport, [...made].reverse()).catch((error: unknown) => { throw new Error(`a fixture batch partly failed AND its cleanup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: new CommandFailureError(response) }); });
  throw new CommandFailureError(response);
}

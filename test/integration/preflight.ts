/**
 * vitest's globalSetup for the integration tier: before any suite, check
 * that the configured member can do what the suites need (memberCheck.ts),
 * and stop with that one message if it cannot. No instance configured:
 * nothing to check, and the suites skip themselves.
 */
import { instance } from "./instanceConfig";
import { problemWith } from "./memberCheck";

export default async function preflight(): Promise<void> {
  if (!instance) return;
  const problem = await problemWith(instance.transport);
  if (problem) throw new Error(problem);
}

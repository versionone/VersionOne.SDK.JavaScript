/**
 * Errors: everything thrown is an ApiError with a `kind` to branch on, and
 * `client.explain` says a failure to a person in the instance's own words.
 * Creates nothing: every write here is one the server refuses.
 *
 *   V1_URL=… V1_ACCESS_TOKEN=… node examples/05-errors.ts
 */
import { AgilityApiClient, ApiError } from "@versionone/agility-sdk";

const { V1_URL, V1_ACCESS_TOKEN } = process.env;
if (!V1_URL || !V1_ACCESS_TOKEN) throw new Error("set V1_URL and V1_ACCESS_TOKEN");
const client = new AgilityApiClient({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN });

const attempt = async (what: string, run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
    console.log(`${what}: no error`);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // `kind` is what to branch on; `code` and `status` are detail.
    console.log(`${what}: kind ${error.kind}, code ${error.code}, status ${error.status}`);
    for (const e of await client.explain(error)) console.log(`   for the ${e.audience}: ${e.sentence}`);
  }
};

// A mistake in the call is caught before any request: kind "usage", status 0.
await attempt("an empty batch", () => client.batch.run([], { guard: true }));

// A query the server refuses throws; it never reads as an empty result.
// (The cast is what it takes to get a misspelt attribute past the compiler.)
await attempt("an attribute that does not exist", () => client.query({ from: "Story", select: ["Nmae" as "Name"], page: { size: 1, start: 0 } }));

// A command the server refuses: a Story needs a Name and a Scope.
await attempt("a create missing what is required", () => client.send([{ AssetType: "Story", Estimate: 1 }], { throwOnFailure: true }));

// Without throwOnFailure the same refusal is data, on the Outcome.
const outcome = await client.send([{ AssetType: "Story", Estimate: 1 }]);
console.log(`failures: ${outcome.failures.length}; created: ${outcome.created.length}`);

/**
 * A Transport of your own: here, the SDK's fetch transport wrapped to time
 * every request, the way an app adds tracing or metrics. The conformance
 * suite says whether a transport does everything the SDK expects of one;
 * run it in your tests.
 *
 * The checks need no instance. With V1_URL and V1_ACCESS_TOKEN set, the
 * example also makes one live read through the transport. Writes nothing.
 *
 *   node examples/08-custom-transport.ts
 */
import { AgilityApiClient, createFetchTransport } from "@versionone/agility-sdk";
import type { Transport } from "@versionone/agility-sdk";
import { CONFORMANCE_BASE_URL, fetchFrom, transportConformance } from "@versionone/agility-sdk/testing";

const timings: { path: string; ms: number; failed: boolean }[] = [];

// A Transport is one method. This one hands the work to the fetch transport
// and records how long each request took, whether it resolved or threw.
function timed(inner: Transport): Transport {
  return {
    async request(options) {
      const started = performance.now();
      let failed = false;
      try {
        return await inner.request(options);
      } catch (error) {
        failed = true;
        throw error;      // rethrown untouched: everything a transport throws is an ApiError
      } finally {
        timings.push({ path: options.path, ms: Math.round(performance.now() - started), failed });
      }
    }
  };
}

// In a test file this is `for (const check of …) it(check.name, check.run)`.
// The suite hands your factory a stand-in for the network; `fetchFrom`
// turns it into a fetch. A transport built on another HTTP client passes
// the server to that client instead.
const checks = transportConformance((server) => timed(createFetchTransport({ baseUrl: CONFORMANCE_BASE_URL, fetchImpl: fetchFrom(server) })));
let broken = 0;
for (const check of checks) {
  try {
    await check.run();
  } catch (error) {
    broken += 1;
    console.log(`BROKEN: ${check.name}: ${(error as Error).message}`);
  }
}
console.log(`${checks.length - broken} of ${checks.length} conformance checks pass`);
if (broken) process.exitCode = 1;

// The client takes the transport as an option. The resend rule and
// `onError` are the client's, so they apply to any transport; `baseUrl` in
// the config is then used only for the links the client builds.
const { V1_URL, V1_ACCESS_TOKEN } = process.env;
if (V1_URL && V1_ACCESS_TOKEN) {
  timings.length = 0;
  const transport = timed(createFetchTransport({ baseUrl: V1_URL, accessToken: V1_ACCESS_TOKEN }));
  const client = new AgilityApiClient({ baseUrl: V1_URL }, { transport });
  const stories = await client.query({ from: "Story", select: ["Name"], page: { size: 3, start: 0 } });
  console.log(`read ${stories.length} stories in ${timings.length} requests: ${timings.map((t) => `${t.path.split("?")[0]} ${t.ms} ms`).join(", ")}`);
} else {
  console.log("set V1_URL and V1_ACCESS_TOKEN to also make a live read through the transport");
}

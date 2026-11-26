import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/core/errors";
import { createFetchTransport } from "../../src/core/fetchTransport";
import type { Transport } from "../../src/core/transport";
import { CONFORMANCE_BASE_URL, fetchFrom, transportConformance } from "../../src/testing";

/**
 * The conformance suite a consumer runs against its own Transport, run
 * here against the SDK's: if the fetch transport stops doing what the
 * suite says a Transport does, this fails before a consumer's suite does.
 */
describe("Transport conformance: the fetch transport", () => {
  for (const check of transportConformance((server) => createFetchTransport({ baseUrl: CONFORMANCE_BASE_URL, retries: 0, fetchImpl: fetchFrom(server) }))) it(check.name, check.run);
});

describe("Transport conformance: the suite catches a transport that breaks a rule", () => {
  const good = (server: Parameters<typeof fetchFrom>[0]) => createFetchTransport({ baseUrl: CONFORMANCE_BASE_URL, retries: 0, fetchImpl: fetchFrom(server) });
  const failing = async (make: (server: Parameters<typeof fetchFrom>[0]) => Transport): Promise<string[]> => {
    const failed: string[] = [];
    for (const check of transportConformance(make)) await check.run().catch((e: Error) => failed.push(e.message));
    return failed;
  };

  it("one that rejects a 304 it was told to accept (an HTTP client's default), and one that throws its own error type", async () => {
    // As an HTTP client that treats every status outside 2xx as an error does: the 304 never resolves.
    const strict = (server: Parameters<typeof fetchFrom>[0]): Transport => { const t = good(server); return { request: (o) => t.request({ ...o, acceptNotModified: false }) }; };
    const broken = await failing(strict);
    expect(broken).toEqual([expect.stringMatching(/^Transport conformance: "a 304 on a request with acceptNotModified.*the transport rejected where the rule says it must resolve: HTTP 304$/)]);
    const ownErrors = (server: Parameters<typeof fetchFrom>[0]): Transport => { const t = good(server); return { request: (o) => t.request(o).catch((e: unknown) => { throw e instanceof ApiError && e.status >= 400 ? new Error(`HTTP ${e.status}`) : e; }) as never }; };
    expect((await failing(ownErrors)).some((m) => /must reject with an ApiError/.test(m))).toBe(true);
  });

  it("one that lets a leading slash escape the base path", async () => {
    const escaping = (server: Parameters<typeof fetchFrom>[0]): Transport => createFetchTransport({ baseUrl: "https://agility.example.com/", retries: 0, fetchImpl: fetchFrom(server) });
    expect(await failing(escaping)).toEqual([expect.stringMatching(/the path must stay under the base path: got https:\/\/agility\.example\.com\/rest-1\.v1/)]);
  });
});

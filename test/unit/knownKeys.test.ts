import { describe, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { CLIENT_CONFIG_KEYS, type ClientConfig } from "../../src/core/clientConfig";
import { UsageError } from "../../src/core/errors";
import { FETCH_TRANSPORT_CONFIG_KEYS, createFetchTransport, type FetchTransportConfig } from "../../src/core/fetchTransport";
import { keysOf, refuseUnknownKeys } from "../../src/core/knownKeys";
import { TypeCache } from "../../src/services/schema";
import { FakeAgilityClient } from "../../src/testing";

/**
 * A config object with a key its factory does not know is refused when it
 * is handed over. A JavaScript caller (or one checked by JSDoc, not
 * compiled) gets no excess-property error from a compiler, and a misspelt
 * or misplaced option that is quietly ignored is how a client ran for
 * releases without the `fetch` its author thought it had.
 */
const SECRET = "s3cr3t-token-value";
const refusal = (make: () => unknown): UsageError => { try { make(); } catch (error) { return error as UsageError; } throw new Error("was not refused"); };

describe("unknown config keys", () => {
  it("the client refuses a key its config does not know, names it, suggests the nearest known key, and never repeats a value", () => {
    const error = refusal(() => new AgilityApiClient({ baseUrl: "https://agility.example.com/I", accessToken: SECRET, retrys: 3, fetchImplementation: fetch } as unknown as ClientConfig));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.kind).toBe("usage");
    expect(error.message).toContain(`unknown keys "retrys" (did you mean "retries"?), "fetchImplementation"`);
    expect(error.message).toContain("It takes: baseUrl, authorization, accessToken");
    expect(error.details).toMatchObject({ unknown: ["retrys", "fetchImplementation"] });
    expect(JSON.stringify([error.message, error.details])).not.toContain(SECRET);
    // The same but for case, and one letter off.
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x", baseURL: "https://y" } as unknown as ClientConfig)).message).toContain(`"baseURL" (did you mean "baseUrl"?)`);
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x", timeoutMS: 5 } as unknown as ClientConfig)).message).toContain(`"timeoutMS" (did you mean "timeoutMs"?)`);
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x", acessToken: SECRET } as unknown as ClientConfig)).message).toContain(`"acessToken" (did you mean "accessToken"?)`);
    // Nothing near: named, with no guess.
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x", proxy: "http://p" } as unknown as ClientConfig)).message).toContain(`unknown key "proxy". It takes:`);
  });

  it("the name is the mistake: an unknown key is refused even when its value is undefined; a known key may be undefined", () => {
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x", retrys: undefined } as unknown as ClientConfig)).message).toContain(`"retrys"`);
    expect(() => new AgilityApiClient({ baseUrl: "https://x", accessToken: undefined, retries: undefined, timeoutMs: undefined, fetchImpl: undefined, onError: undefined })).not.toThrow();
    expect(() => createFetchTransport({ baseUrl: "https://x", authorization: undefined, credentials: undefined })).not.toThrow();
  });

  it("every documented key is accepted, by the client and by createFetchTransport", () => {
    const everyClientKey: Required<ClientConfig> = { baseUrl: "https://x", authorization: "Basic eA==", accessToken: "t", fetchImpl: fetch, timeoutMs: 1, retries: 0, defaultHeaders: {}, onError: () => {}, credentials: "include", onUnauthorized: () => "fail", unauthorizedStatuses: [401] };
    expect(Object.keys(everyClientKey).sort()).toEqual([...CLIENT_CONFIG_KEYS].sort());
    expect(() => new AgilityApiClient(everyClientKey)).not.toThrow();
    const everyTransportKey: Required<FetchTransportConfig> = { baseUrl: "https://x", authorization: "Basic eA==", accessToken: "t", defaultHeaders: {}, timeoutMs: 1, retries: 0, fetchImpl: fetch, credentials: "include", onUnauthorized: () => "fail", unauthorizedStatuses: [401] };
    expect(Object.keys(everyTransportKey).sort()).toEqual([...FETCH_TRANSPORT_CONFIG_KEYS].sort());
    expect(() => createFetchTransport(everyTransportKey)).not.toThrow();
  });

  it("createFetchTransport, the client's options and the fake refuse alike; a client built by withSignal is not refused", () => {
    expect(refusal(() => createFetchTransport({ baseUrl: "https://x", accessToken: SECRET, onError: () => {} } as unknown as FetchTransportConfig)).message).toMatch(/^createFetchTransport's config: unknown key "onError"/);
    // A key in the wrong object: `transport` belongs in the options, `fetchImpl` in the config.
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x", transport: {} } as unknown as ClientConfig)).message).toContain(`the client's config: unknown key "transport"`);
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x" }, { fetchImpl: fetch } as never)).message).toContain(`the client's options: unknown key "fetchImpl"`);
    expect(refusal(() => new AgilityApiClient({ baseUrl: "https://x" }, { type: new TypeCache() } as never)).message).toContain(`"type" (did you mean "types"?)`);
    // The fake takes the client's keys and `metamodel`.
    expect(() => new FakeAgilityClient({ retries: 1, metamodel: { AssetTypes: {} } })).not.toThrow();
    expect(refusal(() => new FakeAgilityClient({ metamodl: { AssetTypes: {} } } as never)).message).toContain(`"metamodl"`);
    expect(() => new AgilityApiClient({ baseUrl: "https://x" }).withSignal(new AbortController().signal)).not.toThrow();
    // Not an object at all.
    expect(() => new AgilityApiClient(null as never)).toThrow(UsageError);
    expect(() => refuseUnknownKeys("a config", [], ["a"])).toThrow(UsageError);
  });

  it("a key list cannot drift from its type: a key left out, or one the type does not have, does not compile", () => {
    interface Example { a: string; b?: number }
    expect(keysOf<Example>()({ a: true, b: true })).toEqual(["a", "b"]);
    // @ts-expect-error a key of the type left out of the list
    keysOf<Example>()({ a: true });
    // @ts-expect-error a key the type does not have
    keysOf<Example>()({ a: true, b: true, c: true });
  });
});

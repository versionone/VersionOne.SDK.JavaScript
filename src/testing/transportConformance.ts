/**
 * A conformance suite for a custom Transport: the SDK's own expectations
 * of one, runnable against any implementation with any test runner. A
 * consumer that wraps its HTTP client (axios, an instrumented fetch) as a
 * Transport would otherwise re-derive these rules from the fetch
 * transport's source, and learn of a new one when something breaks.
 *
 * ```ts
 * import { transportConformance } from "@versionone/agility-sdk/testing";
 *
 * for (const check of transportConformance((server) => makeMyTransport({ baseUrl: "https://agility.example.com/Instance/", adapter: server }))) {
 *   it(check.name, check.run);   // Jest, Vitest, node:test — each check throws an Error when the rule is broken
 * }
 * ```
 *
 * `server` stands in for the network: the suite hands it to your factory,
 * and your factory makes the transport's HTTP client call it for every
 * request (an axios adapter, a `fetch` replacement — `fetchFrom(server)`
 * is one). The base URL must be `https://agility.example.com/Instance/`,
 * so the suite can tell that a path stays inside the instance.
 *
 * When the SDK asks something new of a Transport, a check is added here and
 * the change is listed under "Breaking" in the changelog.
 */
import { ApiError, apiErrorFromResponse } from "../core/errors";
import type { Transport } from "../core/transport";

/** A request as it reaches the network: what the suite inspects. Header names in lower case. */
export interface ConformanceRequest {
  method: string;
  /** The absolute URL, query string included. */
  url: string;
  headers: Record<string, string>;
  /** The body as the HTTP client was given it: a string, bytes, a Blob, a FormData, or undefined. */
  body?: unknown;
  signal?: AbortSignal;
}

/** What the suite's server answers: a response, or "network-error" for a connection that fails. */
export type ConformanceResponse = { status: number; headers?: Record<string, string>; body?: string | Uint8Array } | "network-error";

/** The stand-in for the network: call it with each request; it answers what the current check scripted. */
export type ConformanceServer = (request: ConformanceRequest) => Promise<ConformanceResponse>;

export interface ConformanceCheck { name: string; run: () => Promise<void> }

/** The base URL a transport under test must be built with. */
export const CONFORMANCE_BASE_URL = "https://agility.example.com/Instance/";

/** A `fetch` that answers from the suite's server: for a transport built on fetch. */
export function fetchFrom(server: ConformanceServer): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key.toLowerCase()] = value; });
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const answer = await server({ method: init.method ?? "GET", url: String(input), headers, body: init.body ?? undefined, signal: init.signal ?? undefined });
    if (answer === "network-error") throw new TypeError("fetch failed");
    // A 304 (like a 204) carries no body.
    return new Response(answer.status === 304 || answer.status === 204 ? null : (answer.body as BodyInit | undefined) ?? null, { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
}

const json = (value: unknown, status = 200): ConformanceResponse => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(value) });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function expect(condition: unknown, rule: string): asserts condition {
  if (!condition) throw new Error(`Transport conformance: ${rule}`);
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Transport conformance: the request resolved, and the rule says it must reject");
}

/**
 * The checks. `make` is called once per check with that check's server and
 * must answer a fresh Transport whose HTTP client calls it, built on
 * CONFORMANCE_BASE_URL.
 */
export function transportConformance(make: (server: ConformanceServer) => Transport): ConformanceCheck[] {
  /** A transport whose network answers `answer` to everything and records what it was asked. */
  const scripted = (answer: ConformanceResponse | ((request: ConformanceRequest) => ConformanceResponse)) => {
    const seen: ConformanceRequest[] = [];
    const transport = make(async (request) => { seen.push(request); return typeof answer === "function" ? answer(request) : answer; });
    return { transport, seen };
  };
  // A rejection a check did not expect is a broken rule too: say which, rather than surface the transport's own error bare.
  const named = (checks: ConformanceCheck[]): ConformanceCheck[] => checks.map(({ name, run }) => ({ name, run: async () => {
    try { await run(); } catch (error) {
      if (error instanceof Error && error.message.startsWith("Transport conformance:")) throw error;
      throw new Error(`Transport conformance: "${name}" — the transport rejected where the rule says it must resolve: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } }));
  return named([
    { name: "a path is resolved inside the instance's base URL, a leading slash included, and query values are sent", run: async () => {
      const { transport, seen } = scripted(json([]));
      await transport.request({ method: "GET", path: "/rest-1.v1/Data/Story", query: { sel: "Name", page: "2,0", skipped: undefined, none: null } });
      const url = new URL(seen[0]!.url);
      expect(url.origin + url.pathname === "https://agility.example.com/Instance/rest-1.v1/Data/Story", `the path must stay under the base path: got ${seen[0]!.url}`);
      expect(url.searchParams.get("sel") === "Name" && url.searchParams.get("page") === "2,0", "query values must be sent");
      expect(!url.searchParams.has("skipped") && !url.searchParams.has("none"), "an undefined or null query value must be left out");
      expect(seen[0]!.method === "GET", "the method must be the one asked for");
    } },
    { name: "a body is sent in the shape it was given: a value as JSON, a string as text unless told otherwise, bytes as octet-stream, a Blob with its own type", run: async () => {
      const { transport, seen } = scripted(json({}));
      await transport.request({ method: "POST", path: "/api/asset", body: [{ from: "Story" }] });
      await transport.request({ method: "POST", path: "/api/asset", body: "from: Story" });
      await transport.request({ method: "POST", path: "/api/asset", body: "from: Story", contentType: "text/yaml" });
      await transport.request({ method: "POST", path: "/attachment.img/5", body: new Uint8Array([1, 2, 3]) });
      await transport.request({ method: "POST", path: "/attachment.img/5", body: new Blob(["hi"], { type: "text/csv" }) });
      const type = (i: number) => seen[i]!.headers["content-type"] ?? "";
      const sent = seen[0]!.body;
      expect(type(0).startsWith("application/json") && same(typeof sent === "string" ? JSON.parse(sent) : sent, [{ from: "Story" }]), "a JSON value must be sent as JSON with content-type application/json");
      expect(type(1).startsWith("text/plain") && seen[1]!.body === "from: Story", "a string must be sent as it is, as text/plain");
      expect(type(2).startsWith("text/yaml"), "contentType must override the implied content type");
      expect(type(3).startsWith("application/octet-stream"), "bytes must be sent as application/octet-stream");
      expect(type(4).startsWith("text/csv"), "a Blob must keep its own type");
    } },
    { name: "a FormData body is handed over untouched, with no content type of the transport's own (the runtime writes the multipart boundary)", run: async () => {
      if (typeof FormData === "undefined") return;
      const { transport, seen } = scripted({ status: 200, headers: { "content-type": "text/html" }, body: "<textarea>{}</textarea>" });
      const form = new FormData();
      form.append("oidToken", "Story:1");
      await transport.request({ method: "POST", path: "/EmbeddedImage.mvc/Upload", body: form, responseType: "text" });
      expect(seen[0]!.body instanceof FormData, "a FormData must reach the HTTP client as a FormData");
      expect(!(seen[0]!.headers["content-type"] ?? "").startsWith("application/json"), "a FormData must not be labelled as JSON");
    } },
    { name: "the response is read as asked: bytes as a Uint8Array, text as a string, auto as JSON when the server says JSON and text otherwise", run: async () => {
      const bytes = await scripted({ status: 200, headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) }).transport.request<unknown>({ method: "GET", path: "/attachment.img/5", responseType: "bytes" });
      expect(bytes instanceof Uint8Array && same([...bytes], [1, 2, 3]), "responseType \"bytes\" must answer a Uint8Array (not an ArrayBuffer)");
      const text = await scripted(json({ a: 1 })).transport.request<unknown>({ method: "GET", path: "/x", responseType: "text" });
      expect(text === "{\"a\":1}", "responseType \"text\" must answer the body as a string, unparsed");
      expect(same(await scripted(json({ a: 1 })).transport.request({ method: "GET", path: "/x" }), { a: 1 }), "with no responseType, a JSON response must be parsed");
      expect((await scripted({ status: 200, headers: { "content-type": "text/html" }, body: "<p>hi</p>" }).transport.request({ method: "GET", path: "/x" })) === "<p>hi</p>", "with no responseType, a non-JSON response must answer as text");
    } },
    { name: "onResponse is called with the status and case-insensitive headers before the body is answered; a missing header is null", run: async () => {
      const { transport } = scripted({ status: 200, headers: { "content-type": "text/plain", ETag: "\"26.3.2.13.1\"" }, body: "ok" });
      const order: string[] = [];
      let seenHeaders: (string | null)[] = [], status = 0;
      const body = await transport.request<string>({ method: "GET", path: "/meta.v1/Story", responseType: "text", onResponse: (r) => { order.push("onResponse"); status = r.status; seenHeaders = [r.headers.get("etag"), r.headers.get("ETag"), r.headers.get("x-missing")]; } });
      order.push("body");
      expect(body === "ok" && same(order, ["onResponse", "body"]), "onResponse must run once, before the request resolves");
      expect(status === 200, "onResponse must be given the status");
      expect(seenHeaders[0] === "\"26.3.2.13.1\"" && seenHeaders[1] === seenHeaders[0], "headers.get must find a header whatever its case");
      expect(seenHeaders[2] === null, "headers.get must answer null for a header that was not sent");
    } },
    { name: "a 304 on a request with acceptNotModified resolves undefined after onResponse has seen it; without the flag a 304 is an error like any other status outside 2xx", run: async () => {
      const notModified: ConformanceResponse = { status: 304, headers: { etag: "\"t\"" } };
      let seen: number | null = null, tag: string | null = null;
      const answer = await scripted(notModified).transport.request<unknown>({ method: "GET", path: "/meta.v1/Story", headers: { "If-None-Match": "\"t\"" }, acceptNotModified: true, onResponse: (r) => { seen = r.status; tag = r.headers.get("etag"); } });
      expect(answer === undefined, "a 304 with acceptNotModified must resolve to undefined");
      expect(seen === 304 && tag === "\"t\"", "onResponse must be called with the 304 and its headers");
      const error = await rejection(scripted(notModified).transport.request({ method: "GET", path: "/meta.v1/Story" }));
      expect(error instanceof ApiError && error.status === 304, "without acceptNotModified a 304 must reject with an ApiError carrying the status");
    } },
    { name: "a refused response rejects with the ApiError that apiErrorFromResponse makes: the status, the server's own words, the body as details", run: async () => {
      const bodies: [number, unknown][] = [
        [400, { _type: "Error", error: "Invalid WHERE parameter", exceptions: [{ type: "FormatException", message: "Invalid QueryFilter2 token Nope=1" }] }],
        [400, { Exceptions: ["The request body is not valid JSON."] }],
        [401, "Unauthorized"],
        [503, ""]
      ];
      for (const [status, data] of bodies) {
        const response: ConformanceResponse = typeof data === "string" ? { status, headers: { "content-type": "text/plain" }, body: data } : json(data, status);
        const error = await rejection(scripted(response).transport.request({ method: "GET", path: "/x" }));
        const expected = apiErrorFromResponse(status, data);
        expect(error instanceof ApiError, `a ${status} must reject with an ApiError`);
        expect(error.status === status && error.kind === expected.kind, `a ${status} must carry its status and the kind it implies (${expected.kind})`);
        expect(error.message === expected.message, `a ${status} must be worded as apiErrorFromResponse words it ("${expected.message}"), got "${error.message}"`);
        if (typeof data === "object") expect(same(error.details, data), "the parsed error body must be the error's details");
      }
    } },
    { name: "a caller's abort rejects with code ABORTED and status 0, before sending when the signal is already aborted; a failed connection rejects as NETWORK_ERROR, kind transient", run: async () => {
      const aborted = new AbortController();
      aborted.abort();
      const early = scripted(json([]));
      const before = await rejection(early.transport.request({ method: "GET", path: "/x", signal: aborted.signal }));
      expect(before instanceof ApiError && before.code === "ABORTED" && before.status === 0 && before.kind === "aborted", "a request whose signal is already aborted must reject with ApiError code ABORTED, status 0");
      expect(early.seen.length === 0, "a request whose signal is already aborted must not be sent");
      const controller = new AbortController();
      const during = await rejection(scripted(() => { controller.abort(); return "network-error"; }).transport.request({ method: "GET", path: "/x", signal: controller.signal }));
      expect(during instanceof ApiError && during.code === "ABORTED", "an abort while the request is in flight must reject with ApiError code ABORTED");
      const lost = await rejection(scripted("network-error").transport.request({ method: "POST", path: "/api/asset", body: [] }));
      expect(lost instanceof ApiError && lost.code === "NETWORK_ERROR" && lost.status === 0 && lost.kind === "transient", "a failed connection must reject with ApiError code NETWORK_ERROR, status 0, kind transient");
    } },
    { name: "responseType \"json\" insists: a body that is not JSON rejects with code BAD_JSON, and an empty one resolves undefined", run: async () => {
      const error = await rejection(scripted({ status: 200, headers: { "content-type": "text/html" }, body: "<html>Sign in</html>" }).transport.request({ method: "GET", path: "/x", responseType: "json" }));
      expect(error instanceof ApiError && error.code === "BAD_JSON" && error.kind === "protocol", "a non-JSON body under responseType \"json\" must reject with ApiError code BAD_JSON");
      expect((await scripted({ status: 200, headers: { "content-type": "application/json" }, body: "" }).transport.request({ method: "POST", path: "/x", responseType: "json" })) === undefined, "an empty body under responseType \"json\" must resolve to undefined");
    } }
  ]);
}

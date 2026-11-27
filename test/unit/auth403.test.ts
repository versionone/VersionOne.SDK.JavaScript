import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { ApiError, apiErrorFromResponse } from "../../src/core/errors";
import { createFetchTransport, type UnauthorizedContext } from "../../src/core/fetchTransport";
import { FakeAgilityClient } from "../../src/testing";
import { assetApi, rest1 } from "../../src/wire";

/**
 * Two refusals that the status alone misnames, as a browser-app consumer
 * saw them on one product release (OIDC sign-in), identities replaced:
 *   - an ended session answers 401 to a plain request and 403 to one sent
 *     with X-Requested-With: XMLHttpRequest, both with the same Bearer
 *     challenge and body. The 403 is about the sign-in;
 *   - a write the member has no right to is never a 403: api/asset
 *     reports it per command inside a 200, and rest-1 as a 400. Neither
 *     carries a challenge.
 * None of it can be reproduced where the SDK's own live tier runs: every
 * request there is authenticated, as an administrator.
 */
const CHALLENGE = { "www-authenticate": "Bearer realm=\"agility.example.com\"" };
const ENDED = { error: "Unauthorized" };
const DENIED_REST1 = { _type: "Error", error: "Bad Request", exceptions: [{ type: "DataException", message: "Violation'Security'Story" }, { type: "SecurityException", message: "Violation'Security'Story" }] };
const response = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const envelope = (over: Record<string, unknown> = {}) => ({ requestId: "r", assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 }, commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: -1 }, ...over });

describe("a 403 that challenges is about the sign-in", () => {
  it("apiErrorFromResponse: a 403 with a WWW-Authenticate challenge is kind auth; without one, or with no headers given, forbidden; a 401 is auth either way", () => {
    expect(apiErrorFromResponse(403, ENDED, CHALLENGE)).toMatchObject({ kind: "auth", status: 403, message: "Unauthorized", details: ENDED });
    // Headers in any of the forms a transport has them: a Headers, something with get, a plain record in any case.
    expect(apiErrorFromResponse(403, ENDED, new Headers(CHALLENGE)).kind).toBe("auth");
    expect(apiErrorFromResponse(403, ENDED, { "WWW-Authenticate": "Bearer" }).kind).toBe("auth");
    expect(apiErrorFromResponse(403, ENDED, { get: (name) => (name.toLowerCase() === "www-authenticate" ? "Bearer" : null) }).kind).toBe("auth");
    // Controls.
    expect(apiErrorFromResponse(403, { error: "Forbidden" }).kind).toBe("forbidden");
    expect(apiErrorFromResponse(403, ENDED).kind).toBe("forbidden");
    expect(apiErrorFromResponse(403, ENDED, { "www-authenticate": "  " }).kind).toBe("forbidden");
    expect(apiErrorFromResponse(403, ENDED, { "content-type": "application/json" }).kind).toBe("forbidden");
    expect(apiErrorFromResponse(401, ENDED).kind).toBe("auth");
    expect(apiErrorFromResponse(401, ENDED, CHALLENGE).kind).toBe("auth");
    // A challenge changes nothing about any other status.
    expect(apiErrorFromResponse(400, { error: "Bad Request" }, CHALLENGE).kind).toBe("invalid");
    expect(apiErrorFromResponse(500, { error: "Server Error" }, CHALLENGE).kind).toBe("transient");
  });

  it("the built-in transport calls onUnauthorized for it by default, hands the hook the headers, and resends as for a 401: a read on retry, a write only on retry-write", async () => {
    const seen: UnauthorizedContext[] = [];
    const ended = () => response(403, ENDED, CHALLENGE);
    const fetchImpl = vi.fn().mockResolvedValueOnce(ended()).mockResolvedValueOnce(response(200, { ok: true }));
    const transport = createFetchTransport({ baseUrl: "https://x", fetchImpl, onUnauthorized: (context) => { seen.push(context); return "retry"; } });
    expect(await transport.request({ method: "GET", path: "/meta.v1/Story" })).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatchObject({ retryable: true, error: { kind: "auth", status: 403 } });
    expect(seen[0]!.headers.get("www-authenticate")).toBe(CHALLENGE["www-authenticate"]);
    // A write: "retry" does not resend it, "retry-write" does, once.
    for (const [answer, sends] of [["retry", 1], ["retry-write", 2]] as const) {
      const write = vi.fn().mockResolvedValueOnce(ended()).mockResolvedValueOnce(response(200, envelope()));
      const sending = createFetchTransport({ baseUrl: "https://x", fetchImpl: write, onUnauthorized: () => answer }).request({ method: "POST", path: "/api/asset", body: [] });
      if (sends === 1) await expect(sending).rejects.toMatchObject({ kind: "auth", status: 403 }); else await sending;
      expect(write).toHaveBeenCalledTimes(sends);
    }
    // The hook is still called once per request: a second challenged 403 is final.
    const always = vi.fn().mockImplementation(() => Promise.resolve(ended()));
    const hook = vi.fn(() => "retry" as const);
    await expect(createFetchTransport({ baseUrl: "https://x", fetchImpl: always, onUnauthorized: hook }).request({ method: "GET", path: "/meta.v1/Story" })).rejects.toMatchObject({ kind: "auth" });
    expect(hook).toHaveBeenCalledOnce();
  });

  it("unauthorizedStatuses lists statuses in addition to those: a 403 without a challenge reaches the hook only when listed, and a consumer that lists [401, 403] gets nothing worse than before", async () => {
    const plain403 = () => response(403, { error: "Forbidden" });
    const hook = vi.fn(() => "fail" as const);
    await expect(createFetchTransport({ baseUrl: "https://x", fetchImpl: vi.fn().mockImplementation(() => Promise.resolve(plain403())), onUnauthorized: hook }).request({ method: "GET", path: "/x" })).rejects.toMatchObject({ kind: "forbidden" });
    expect(hook).not.toHaveBeenCalled();
    const listed = vi.fn(() => "fail" as const);
    const both = createFetchTransport({ baseUrl: "https://x", fetchImpl: vi.fn().mockResolvedValueOnce(plain403()).mockResolvedValueOnce(response(403, ENDED, CHALLENGE)).mockResolvedValueOnce(response(401, ENDED)), onUnauthorized: listed, unauthorizedStatuses: [401, 403] });
    for (const kind of ["forbidden", "auth", "auth"]) await expect(both.request({ method: "GET", path: "/x" })).rejects.toMatchObject({ kind });
    expect(listed).toHaveBeenCalledTimes(3);
    // A request sent with reauthorize: false (the hook's own session check) is refused straight away, challenged or not.
    const quiet = vi.fn(() => "retry" as const);
    await expect(createFetchTransport({ baseUrl: "https://x", fetchImpl: vi.fn().mockImplementation(() => Promise.resolve(response(403, ENDED, CHALLENGE))), onUnauthorized: quiet }).request({ method: "GET", path: "/x", reauthorize: false })).rejects.toMatchObject({ kind: "auth" });
    expect(quiet).not.toHaveBeenCalled();
  });

  it("explain says the sign-in sentence for it, and a write refused so was not applied", async () => {
    const fetchImpl = (async (url: string | URL) => (new URL(String(url)).pathname.startsWith("/meta.v1/") ? response(404, {}) : response(403, ENDED, CHALLENGE))) as typeof fetch;
    const client = new AgilityApiClient({ baseUrl: "https://x", fetchImpl });
    const error = await client.send([{ from: "Story:1", update: { Name: "x" } }]).catch((e: unknown) => e);
    expect((await client.explain(error))[0]).toMatchObject({ sentence: "Agility did not accept the sign-in: the token is missing, wrong or no longer valid.", audience: "user", outcome: "notApplied" });
    // The fake scripts it as the transport makes it: the headers are the factory's third argument.
    const fake = new FakeAgilityClient().onSend(apiErrorFromResponse(403, ENDED, CHALLENGE));
    await expect(fake.send([{ from: "Story:1", update: { Name: "x" } }])).rejects.toMatchObject({ kind: "auth", status: 403 });
  });
});

describe("a write the member has no right to", () => {
  it("rest-1's refusal, a 400 whose first exception is a Security violation, is kind forbidden and worded by the violation; other 400s are as they were", async () => {
    expect(apiErrorFromResponse(400, DENIED_REST1)).toMatchObject({ kind: "forbidden", status: 400, message: "Violation'Security'Story", details: DENIED_REST1 });
    // Controls: another violation, and a Security violation that is not the first exception.
    expect(apiErrorFromResponse(400, { error: "Bad Request", exceptions: [{ type: "DataException", message: "Violation'Required'AttributeDefinition'Name'Story" }] })).toMatchObject({ kind: "invalid", message: "Bad Request" });
    expect(apiErrorFromResponse(400, { error: "Bad Request", exceptions: [{ message: "Something else" }, { message: "Violation'Security'Story" }] }).kind).toBe("invalid");
    // Through the wire module and a client: not re-coded as a rejected query, and explained to a person.
    const fetchImpl = (async (url: string | URL) => (new URL(String(url)).pathname.startsWith("/meta.v1/") ? response(404, {}) : response(400, DENIED_REST1))) as typeof fetch;
    const client = new AgilityApiClient({ baseUrl: "https://x", fetchImpl });
    const refused = await rest1.operate(client.transport, "Story:1", "QuickClose").catch((e: unknown) => e as ApiError);
    expect(refused).toMatchObject({ kind: "forbidden", status: 400, request: { method: "POST", idempotent: false } });
    expect((await client.explain(refused))[0]).toMatchObject({ sentence: "Agility refused: this member is not allowed to do that.", audience: "user", echoed: false, outcome: "notApplied", retrySafe: null });
    await expect(rest1.list(client.transport, "Story", { page: { size: 1, start: 0 } })).rejects.toMatchObject({ kind: "forbidden", code: undefined });
  });

  it("api/asset's refusal, a Security command failure inside a 200, gets the same sentence for a person, and that command was not applied", async () => {
    // As api/asset answered a create by a read-only member: nothing created, the command failed for Security.
    const failed = envelope({ commandFailures: { commands: [{ "@a": { AssetType: "Story", Name: "n", Scope: "Scope:0" }, error: { message: "Violation'Security'Story", sourceCommandIndex: 0 } }], count: 1 } });
    const fetchImpl = (async (url: string | URL) => { const path = new URL(String(url)).pathname; return path.startsWith("/meta.v1/") ? response(404, {}) : path.startsWith("/loc-2.v1") ? response(200, { "Violation'Security'Story": "Violation'Security'Story", "AssetType'Story": "Backlog Item" }) : response(200, failed); }) as typeof fetch;
    const client = new AgilityApiClient({ baseUrl: "https://x", fetchImpl });
    const outcome = assetApi.outcomeOf(await assetApi.send(client.transport, [{ AssetType: "Story", Name: "n", Scope: "Scope:0" }]));
    expect(outcome).toMatchObject({ created: [], failures: [{ index: 0, message: "Violation'Security'Story" }] });
    const [said] = await client.explain(outcome);
    expect(said).toMatchObject({ sentence: "Agility refused: this member is not allowed to do that.", audience: "user", echoed: false, rule: "Security", typeLabel: "Backlog Item", attribute: null, outcome: "notApplied", index: 0, message: "Violation'Security'Story" });
    // Control: another rule the instance has no sentence for stays a developer's.
    expect((await client.explain([{ index: 0, message: "Violation'MessageMustNotBeSent" }]))[0]).toMatchObject({ audience: "developer", sentence: "Refused (message must not be sent)." });
  });
});

import { describe, expect, it, vi } from "vitest";
import { AgilityApiClient } from "../../src/client";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { localize, localizeOne, toLson } from "../../src/wire/loc2";

function fakeTransport(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (options: RequestOptions) => { calls.push(options); return answers.shift(); });
  return { request: request as Transport["request"], calls };
}

// Copied from a live loc-2.v1 response (2026-11-04): tics, a comma, a `]`, an
// unmatched tag resolving to itself, and the empty tag.
const LIVE = { Scope: "Project", "Plural'Story": "Backlog Items", "AttributeDefinition'Name'Story": "Title", "a, b": "a, b", "x]y": "x]y", "bogus tag": "bogus tag", "": "" };

describe("loc2", () => {
  it("sends every tag double-quoted in one array — the LSON form that survives tics, spaces, commas and `]` — as the raw query string of a GET", async () => {
    const tags = Object.keys(LIVE);
    const t = fakeTransport(LIVE);
    const out = await localize(t, tags);
    expect(out).toEqual(LIVE);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: "GET", responseType: "json" });
    expect(t.calls[0]!.query).toBeUndefined();
    expect(t.calls[0]!.path).toBe(`/loc-2.v1?${encodeURIComponent(toLson(tags))}`);
    expect(decodeURIComponent(t.calls[0]!.path.split("?")[1]!)).toBe('["Scope","Plural\'Story","AttributeDefinition\'Name\'Story","a, b","x]y","bogus tag",""]');
  });

  it("asks nothing for an empty list, and sends a repeated tag once", async () => {
    const none = fakeTransport();
    expect(await localize(none, [])).toEqual({});
    expect(none.calls).toHaveLength(0);
    const t = fakeTransport({ Scope: "Project" });
    await localize(t, ["Scope", "Scope"]);
    expect(decodeURIComponent(t.calls[0]!.path.split("?")[1]!)).toBe('["Scope"]');
  });

  it("POSTs a list too long for a URL — the same payload, URL-encoded, as a form body — and marks it idempotent, since it is a read", async () => {
    const tags = Array.from({ length: 300 }, (_, i) => `AttributeDefinition'Name'Type${i}`);
    const t = fakeTransport(Object.fromEntries(tags.map((x) => [x, "Title"])));
    await localize(t, tags);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/loc-2.v1", contentType: "application/x-www-form-urlencoded", idempotent: true });
    expect(decodeURIComponent(t.calls[0]!.body as string)).toBe(toLson(tags));
    const short = fakeTransport({ Scope: "Project" });
    await localize(short, ["Scope"], { maxGetLength: 5 });
    expect(short.calls[0]!.method).toBe("POST");
  });

  it("sends the culture as Accept-Language, and none when not asked", async () => {
    const t = fakeTransport({ Scope: "Projet" }, { Scope: "Project" });
    await localize(t, ["Scope"], { culture: "fr-CA" });
    await localize(t, ["Scope"]);
    expect(t.calls[0]!.headers).toEqual({ "Accept-Language": "fr-CA" });
    expect(t.calls[1]!.headers).toBeUndefined();
  });

  it("refuses an answer that is not an object; localizeOne uses the array form and reads its tag back", async () => {
    await expect(localize(fakeTransport("Project"), ["Scope"])).rejects.toThrow(/not an object/);
    const t = fakeTransport({ "Plural'Story": "Backlog Items" });
    expect(await localizeOne(t, "Plural'Story")).toBe("Backlog Items");
    expect(t.calls[0]!.path).toContain(encodeURIComponent('["Plural\'Story"]'));
  });

  it("is on the client as localize()", async () => {
    const t = fakeTransport({ Scope: "Project" });
    const client = new AgilityApiClient({ baseUrl: "https://x" }, { transport: t });
    expect(await client.localize(["Scope"])).toEqual({ Scope: "Project" });
  });
});

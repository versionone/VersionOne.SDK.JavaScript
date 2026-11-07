import { afterAll, beforeAll, expect, it } from "vitest";
import { AgilityApiClient } from "../../src/client";
import { assetApi } from "../../src/wire";
import { describeInstance, fixtureName, instance } from "./instance";

/**
 * Attachments against a real instance: add inline and in two steps, list,
 * read the bytes back, replace them, delete. Brings its own Story and
 * deletes everything it made by exact OID.
 *
 * Embedded images cannot be deleted (Agility has no Delete operation for
 * them), so that test leaves one tiny image behind on every run. It runs
 * only with SDK_TEST_EMBEDDED_IMAGES=1.
 */
describeInstance("attachments (live)", () => {
  const t = instance!.transport;
  const client = new AgilityApiClient({ baseUrl: instance!.url }, { transport: t });
  const made: string[] = [];
  let story = "";
  const text = (s: string) => new TextEncoder().encode(s);
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);

  beforeAll(async () => {
    const res = await assetApi.send(t, [{ AssetType: "Story", Name: fixtureName("attachments"), Scope: { _oid: "Scope:0" } }], { throwOnFailure: true });
    story = assetApi.momentless(res.assetsCreated.oidTokens[0]!);
    made.push(story);
  });
  afterAll(async () => {
    for (const oid of [...made].reverse()) await assetApi.send(t, [{ from: oid, execute: "Delete" }]);
  });

  it("a small file inline and a large one in two steps both store their bytes; list sees both, metadata only", async () => {
    const small = await client.attachments.add(story, text("hello attachment\n"), { filename: "sdk-integration small.txt", contentType: "text/plain" });
    const large = await client.attachments.add(story, new Blob([text("two-step bytes\n")], { type: "text/plain" }), { filename: "sdk-integration large.txt", inlineLimit: 0, description: "two-step" });
    made.push(small.oid, large.oid);
    expect(decode((await client.attachments.get(small.id)).bytes)).toBe("hello attachment\n");
    const got = await client.attachments.get(large.oid);
    expect(decode(got.bytes)).toBe("two-step bytes\n");
    expect(got).toMatchObject({ filename: "sdk-integration large.txt", contentType: "text/plain", description: "two-step" });
    const listed = await client.attachments.list(story);
    expect(listed.map((a) => a.oid).sort()).toEqual([small.oid, large.oid].sort());
    // The type the server served the bytes with, and a page with its total.
    expect((await client.attachments.get(small.id)).contentType).toMatch(/^text\/plain/);
    const first = await client.attachments.page(story, { page: { size: 1, start: 0 } });
    expect(first).toMatchObject({ total: 2, more: true });
    expect(first.attachments).toHaveLength(1);
  });

  it("put replaces the bytes; remove deletes the attachment; a missing one is NOT_FOUND", async () => {
    const a = await client.attachments.add(story, text("before\n"), { filename: "sdk-integration replace.txt", contentType: "text/plain" });
    made.push(a.oid);
    await client.attachments.put(a.id, text("after\n"), "text/plain");
    expect(decode((await client.attachments.get(a.id)).bytes)).toBe("after\n");
    await client.attachments.remove(a.id);
    expect(await client.attachments.info(a.id)).toBeNull();
    await expect(client.attachments.get(a.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.runIf(process.env.SDK_TEST_EMBEDDED_IMAGES === "1")("an embedded image uploads with token auth and is served from its URL (leaves one image behind: they cannot be deleted)", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const image = await client.embeddedImages.upload(story, png, { filename: "sdk-integration pixel.png", contentType: "image/png" });
    expect(image.url).toBe(client.embeddedImages.url(image.id));
    const served = await t.request<Uint8Array>({ method: "GET", path: `/embedded.img/${image.id}`, responseType: "bytes" });
    expect(served.length).toBe(png.length);
  });
});

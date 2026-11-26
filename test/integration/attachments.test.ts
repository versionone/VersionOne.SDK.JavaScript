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
    made.push(small._oid, large._oid);
    // add answers what it wrote and not the server's stamps, which it never read: they are absent, not null.
    for (const added of [small, large]) {
      expect(added).not.toHaveProperty("CreateDate");
      expect(added).not.toHaveProperty("CreatedBy.Name");
    }
    const read = await client.attachments.info(small.id);
    expect(typeof read?.CreateDate).toBe("string");
    expect(typeof read?.["CreatedBy.Name"]).toBe("string");
    expect(decode((await client.attachments.get(small.id)).bytes)).toBe("hello attachment\n");
    const got = await client.attachments.get(large._oid);
    expect(decode(got.bytes)).toBe("two-step bytes\n");
    expect(got).toMatchObject({ Filename: "sdk-integration large.txt", ContentType: "text/plain", Description: "two-step" });
    expect(typeof got["CreatedBy.Name"]).toBe("string");
    const listed = await client.attachments.list(story);
    expect(listed.map((a) => a._oid).sort()).toEqual([small._oid, large._oid].sort());
    // The type the server served the bytes with, and a page with its total.
    expect((await client.attachments.get(small.id)).servedContentType).toMatch(/^text\/plain/);
    const first = await client.attachments.page(story, { page: { size: 1, start: 0 } });
    expect(first).toMatchObject({ total: 2, more: true });
    expect(first.attachments).toHaveLength(1);
  });

  it("get with inline reads metadata and bytes in one request; list with a select brings the extra values, translated", async () => {
    const a = await client.attachments.add(story, text("inline read\n"), { filename: "sdk-integration inline.txt", contentType: "text/plain", description: "one request" });
    made.push(a._oid);
    const calls: string[] = [];
    const counting = new AgilityApiClient({ baseUrl: instance!.url }, { transport: { request: (o) => { calls.push(o.path); return t.request(o); } }, types: client.schema.cache });
    const got = await counting.attachments.get(a._oid, { inline: true });
    expect(calls).toEqual(["/query.v1"]);
    expect(decode(got.bytes)).toBe("inline read\n");
    expect(got).toMatchObject({ _oid: a._oid, id: a.id, Filename: "sdk-integration inline.txt", ContentType: "text/plain", servedContentType: null, Description: "one request" });
    expect(got).not.toHaveProperty("Content");
    expect(got.base64).toBe(btoa("inline read\n")); // as it arrived: no re-encoding for a caller that wants Base64
    // The same bytes the two-request read serves.
    expect(decode((await client.attachments.get(a._oid)).bytes)).toBe("inline read\n");
    // A two-step attachment whose upload never happened reads as zero bytes; one that does not exist is NOT_FOUND.
    await expect(client.attachments.get("Attachment:1", { inline: true })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const listed = await client.attachments.list(story, { select: ["Asset", "Asset.Name", "Category", "Days", "IsDeleted"] });
    const mine = listed.find((x) => x._oid === a._oid)!;
    expect(mine.Filename).toBe("sdk-integration inline.txt");
    expect(mine.Asset).toMatchObject({ _oid: story });
    expect(mine).toMatchObject({ Category: null, IsDeleted: false });
    expect(typeof mine.Days).toBe("number");
    expect(String(mine["Asset.Name"])).toMatch(/^sdk-integration attachments/);
    const paged = await client.attachments.page(story, { select: ["Days"], page: { size: 1, start: 0 } });
    expect(typeof paged.attachments[0]!.Days).toBe("number");
    expect(paged.total).toBeGreaterThanOrEqual(1);
  });

  it("put replaces the bytes; remove deletes the attachment; a missing one is NOT_FOUND", async () => {
    const a = await client.attachments.add(story, text("before\n"), { filename: "sdk-integration replace.txt", contentType: "text/plain" });
    made.push(a._oid);
    await client.attachments.put(a.id, text("after\n"), "text/plain");
    expect(decode((await client.attachments.get(a.id)).bytes)).toBe("after\n");
    await client.attachments.remove(a.id);
    expect(await client.attachments.info(a.id)).toBeNull();
    await expect(client.attachments.get(a.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.runIf(process.env.SDK_TEST_EMBEDDED_IMAGES === "1")("an embedded image uploads with token auth and is served from its URL (leaves one image behind: they cannot be deleted)", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const image = await client.embeddedImages.upload(story, png, { filename: "sdk-integration pixel.png", contentType: "image/png" });
    expect(image.url).toBe(client.urls.embeddedImage(image.id));
    const served = await t.request<Uint8Array>({ method: "GET", path: `/embedded.img/${image.id}`, responseType: "bytes" });
    expect(served.length).toBe(png.length);
  });
});

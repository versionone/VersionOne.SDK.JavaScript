import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../../src/core/errors";
import { AgilityApiClient } from "../../src/client";
import { ApiError } from "../../src/core/errors";
import { createFetchTransport } from "../../src/core/fetchTransport";
import type { RequestOptions, Transport } from "../../src/core/transport";
import { AttachmentUploadError, add, get, list, page } from "../../src/services/attachments";
import { Schema } from "../../src/services/schema";
import { queryPage } from "../../src/wire/assetApi";
import { fromBase64, getBytes, getFile, normalizeEmbeddedImageUrls, numericId, toBase64, uploadEmbeddedImage } from "../../src/wire/attachment";

const envelope = (over: Record<string, unknown> = {}) => ({
  requestId: "r", assetsCreated: { oidTokens: [], count: 0 }, assetsModified: { oidTokens: [], count: 0 }, assetsOperatedOn: { oidTokens: [], count: 0 },
  commandFailures: { commands: [], count: 0 }, queryResult: { results: [], resultMetaData: [], count: -1 }, ...over
});
function fake(...answers: unknown[]): Transport & { calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request = vi.fn(async (o: RequestOptions) => { calls.push(o); const a = answers.shift(); if (a instanceof Error) throw a; return a; });
  return { request: request as Transport["request"], calls };
}

describe("attachment wire module", () => {
  it("Base64 without Buffer round-trips, including a file larger than one chunk", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(big))).toEqual(big);
    expect(toBase64(new TextEncoder().encode("hello attachment\n"))).toBe("aGVsbG8gYXR0YWNobWVudAo="); // as the server stored it (2026-11-07)
  });

  it("numericId takes an id, an OID token, or a momented one; anything else is a UsageError", () => {
    expect([numericId(5678), numericId("5678"), numericId("Attachment:5678"), numericId("Attachment:5678:900")]).toEqual(["5678", "5678", "5678", "5678"]);
    expect(() => numericId("S-1")).toThrow(UsageError);
  });

  it("normalizeEmbeddedImageUrls rewrites every embedded.img reference to this instance's absolute URL and leaves other images alone", () => {
    const html = `<p><img src="/old/embedded.img/12"> <img src='https://other.host/x/embedded.img/34?x=1'> <img src="https://cdn/logo.png"></p>`;
    expect(normalizeEmbeddedImageUrls(html, "https://agility.example.com/MyInstance/")).toBe(
      `<p><img src="https://agility.example.com/MyInstance/embedded.img/12"> <img src='https://agility.example.com/MyInstance/embedded.img/34'> <img src="https://cdn/logo.png"></p>`
    );
  });

  it("a missing attachment is a NOT_FOUND ApiError; too large is TOO_LARGE", async () => {
    await expect(getBytes(fake(new ApiError("x", 404)), 5)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(getBytes(fake(new ApiError("x", 413)), 5)).rejects.toMatchObject({ code: "TOO_LARGE", status: 413 });
  });

  it("uploadEmbeddedImage posts multipart { image, oidToken } and reads the URL out of the HTML the route answers", async () => {
    // The route's answer, verbatim (the API-testing instance, 2026-11-07).
    const t = fake('<textarea>{"Url":"https://agility.example.com/MyInstance/embedded.img/146412","Key":"EmbeddedImage:146412"}</textarea>');
    const image = await uploadEmbeddedImage(t, "Story:146408", new Uint8Array([1, 2, 3]), { filename: "pixel.png", contentType: "image/png" });
    expect(image).toEqual({ oid: "EmbeddedImage:146412", id: "146412", url: "https://agility.example.com/MyInstance/embedded.img/146412" });
    const form = t.calls[0]!.body as FormData;
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/EmbeddedImage.mvc/Upload", responseType: "text" });
    expect(form.get("oidToken")).toBe("Story:146408");
    expect((form.get("image") as File).name).toBe("pixel.png");
    expect((form.get("image") as File).type).toBe("image/png");
    await expect(uploadEmbeddedImage(fake("<html>Sign in</html>"), "Story:1", new Uint8Array([1]))).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("the transport sends a Blob as is, with its own type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await createFetchTransport({ baseUrl: "https://x", fetchImpl }).request({ method: "POST", path: "/attachment.img/5", body: new Blob(["hi"], { type: "text/plain" }), responseType: "text" });
    const init = fetchImpl.mock.calls[0]![1];
    expect(init.body).toBeInstanceOf(Blob);
    expect(init.headers["content-type"]).toBe("text/plain");
  });
});

describe("attachments service", () => {
  it("a small file goes inline: one create with Content as Base64", async () => {
    const t = fake(envelope({ assetsCreated: { oidTokens: ["Attachment:77:900"], count: 1 } }));
    const created = await add(t, "Story:1", new TextEncoder().encode("hello attachment\n"), { filename: "a.txt", contentType: "text/plain" });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.body).toEqual([{ AssetType: "Attachment", Asset: "Story:1", Name: "a.txt", Filename: "a.txt", ContentType: "text/plain", Content: "aGVsbG8gYXR0YWNobWVudAo=" }]);
    expect(created).toEqual({ _oid: "Attachment:77", id: "77", Name: "a.txt", Filename: "a.txt", ContentType: "text/plain", Description: null, CreateDate: null, "CreatedBy.Name": null });
  });

  it("a large file goes in two steps: create with empty Content, then POST the bytes", async () => {
    const t = fake(envelope({ assetsCreated: { oidTokens: ["Attachment:78"], count: 1 } }), "");
    const bytes = new Uint8Array(20);
    await add(t, "Story:1", bytes, { filename: "b.bin", inlineLimit: 10, description: "why" });
    expect((t.calls[0]!.body as Record<string, unknown>[])[0]).toMatchObject({ Content: "", ContentType: "application/octet-stream", Description: "why" });
    expect(t.calls[1]).toMatchObject({ method: "POST", path: "/attachment.img/78", contentType: "application/octet-stream" });
    expect(t.calls[1]!.body).toEqual(bytes);
  });

  it("a failed upload reports the created, empty attachment instead of hiding it", async () => {
    const t = fake(envelope({ assetsCreated: { oidTokens: ["Attachment:79"], count: 1 } }), new ApiError("too big", 413));
    const err = (await add(t, "Story:1", new Uint8Array(20), { filename: "c.bin", inlineLimit: 10 }).catch((e: unknown) => e)) as AttachmentUploadError;
    expect(err).toBeInstanceOf(AttachmentUploadError);
    expect(err.attachment._oid).toBe("Attachment:79");
    expect(err.message).toMatch(/Attachment:79 was created .* no content.*maximum request length/);
  });

  it("list asks for metadata only — never Content — paged, newest first", async () => {
    const t = fake(envelope({ queryResult: { results: [[{ _oid: "Attachment:5", Name: "n", Filename: "f.png", ContentType: "image/png", Description: null, CreateDate: "2026-11-07T10:00:00", "CreatedBy.Name": "Dana" }]], resultMetaData: [], count: 1 } }));
    const rows = await list(t, "Story:1:44");
    const q = (t.calls[0]!.body as Record<string, unknown>[])[0]!;
    expect(q).toMatchObject({ from: "Attachment", filter: ["Asset=$asset"], with: { $asset: "Story:1" }, sort: ["-CreateDate"], page: { size: 50, start: 0 } });
    expect(q.select).not.toContain("Content");
    expect(rows).toEqual([{ _oid: "Attachment:5", id: "5", Name: "n", Filename: "f.png", ContentType: "image/png", Description: null, CreateDate: "2026-11-07T10:00:00", "CreatedBy.Name": "Dana" }]);
  });

  it("list and page take more to select: the extra keys come back on the row as selected, translated when a schema is given, beside the metadata", async () => {
    // Attachment and AttachmentCategory as far as this select goes; the row as query.v1 and api/asset spell it (the API-testing instance, 2026-11-26).
    const text = (type: string, name: string) => ({ _type: "AttributeDefinition", Name: name, Token: `${type}.${name}`, DisplayName: "", AttributeType: "Text", IsReadOnly: false, IsRequired: false, IsMultivalue: false, IsCanned: false, IsCustom: false });
    const schema = Schema.fromMetamodel({ Version: "x", AssetTypes: {
      Attachment: { _type: "AssetType", Name: "Attachment", Token: "Attachment", DisplayName: "", Abstract: false, Attributes: {
        "Attachment.Name": text("Attachment", "Name"),
        "Attachment.Category": { ...text("Attachment", "Category"), AttributeType: "Relation", RelatedAsset: "AttachmentCategory" },
        "Attachment.Days": { ...text("Attachment", "Days"), AttributeType: "Numeric" } } },
      AttachmentCategory: { _type: "AssetType", Name: "AttachmentCategory", Token: "AttachmentCategory", DisplayName: "", Abstract: false, Attributes: { "AttachmentCategory.Name": text("AttachmentCategory", "Name") } }
    } } as never);
    const row = { _oid: "Attachment:5", Name: "n", Filename: "f.png", ContentType: "image/png", Description: null, CreateDate: "2026-11-07T10:00:00", "CreatedBy.Name": "Dana", Category: { _oid: "NULL" }, "Category.Name": null, Days: "19" };
    const t = fake(envelope({ queryResult: { results: [[row]], resultMetaData: [], count: 1 } }), envelope({ queryResult: { results: [[row]], resultMetaData: [{ total: 1 }], count: 1 } }), envelope({ queryResult: { results: [[row]], resultMetaData: [], count: 1 } }));
    const [listed] = await list(t, "Story:1", { select: ["Category", "Category.Name", "Days", "Name"], schema });
    expect((t.calls[0]!.body as { select: string[] }[])[0]!.select).toEqual(["Name", "Filename", "ContentType", "Description", "CreateDate", "CreatedBy.Name", "Category", "Category.Name", "Days"]);
    expect(listed).toEqual({ _oid: "Attachment:5", id: "5", Name: "n", Filename: "f.png", ContentType: "image/png", Description: null, CreateDate: "2026-11-07T10:00:00", "CreatedBy.Name": "Dana", Category: null, "Category.Name": null, Days: 19 });
    const paged = await page(t, "Story:1", { select: ["Days"], schema });
    expect(paged).toMatchObject({ total: 1, more: false, attachments: [{ _oid: "Attachment:5", id: "5", Days: 19 }] });
    // Without a schema the extra values keep the endpoint's spelling.
    expect((await list(t, "Story:1", { select: ["Days"] }))[0]!.Days).toBe("19");
  });

  it("get with inline reads the row and its Content in one query.v1 request and decodes the bytes; a missing attachment is NOT_FOUND", async () => {
    // Content inline as Base64, as query.v1 sends it (the API-testing instance, 2026-11-26).
    const t = fake([[{ _oid: "Attachment:145797", Name: "n", Filename: "check.txt", ContentType: "text/plain", Description: null, CreateDate: "2026-11-07T10:00:00", "CreatedBy.Name": "Dana", Content: "aGVsbG8gYXR0YWNobWVudAo=" }]]);
    const got = await get(t, "Attachment:145797", { inline: true });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/query.v1", idempotent: true });
    expect((t.calls[0]!.body as Record<string, unknown>[])[0]).toMatchObject({ from: "Attachment", filter: ["ID=$id"], with: { $id: "Attachment:145797" }, page: { size: 1, start: 0 } });
    expect(new TextDecoder().decode(got.bytes)).toBe("hello attachment\n");
    expect(got).toMatchObject({ _oid: "Attachment:145797", id: "145797", Filename: "check.txt", ContentType: "text/plain", servedContentType: null, "CreatedBy.Name": "Dana" });
    expect(got).not.toHaveProperty("Content");
    await expect(get(fake([[]]), 9, { inline: true })).rejects.toMatchObject({ code: "NOT_FOUND", kind: "notFound" });
    // An attachment created empty reads as zero bytes, not as a failure.
    expect((await get(fake([[{ _oid: "Attachment:6", Content: "" }]]), 6, { inline: true })).bytes).toEqual(new Uint8Array(0));
  });

  it("the client exposes attachments and embedded images, with URLs on its own base", () => {
    const client = new AgilityApiClient({ baseUrl: "https://agility.example.com/MyInstance/" }, { transport: fake() });
    expect(client.attachments.url("Attachment:5")).toBe("https://agility.example.com/MyInstance/attachment.img/5");
    expect(client.embeddedImages.url(12)).toBe("https://agility.example.com/MyInstance/embedded.img/12");
  });
});

describe("attachment gaps the CLI consumer found", () => {
  it("the fetch transport hands onResponse the headers of a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png", "content-disposition": 'inline; filename="a b.png"' } }));
    const seen: (string | null)[] = [];
    await createFetchTransport({ baseUrl: "https://x", fetchImpl }).request({ method: "GET", path: "/attachment.img/5", responseType: "bytes", onResponse: ({ headers }) => seen.push(headers.get("content-type")) });
    expect(seen).toEqual(["image/png"]);
  });

  it("getFile returns the bytes with the served Content-Type and the filename from Content-Disposition", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "text/plain", "content-disposition": 'inline; filename="inline.txt"' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([3]), { status: 200, headers: { "content-type": "image/png", "content-disposition": "attachment; filename*=UTF-8''caf%C3%A9.png" } }));
    const t = createFetchTransport({ baseUrl: "https://x", fetchImpl });
    expect(await getFile(t, "Attachment:5")).toEqual({ bytes: new Uint8Array([1, 2]), contentType: "text/plain", filename: "inline.txt" });
    expect((await getFile(t, 6)).filename).toBe("café.png");
  });

  it("queryPage asks for the total and says whether more pages follow; attachments.page uses it", async () => {
    // resultMetaData as api/asset sends it with needTotal (the API-testing instance, 2026-11-07).
    const withTotal = (rows: unknown[], total: number | null) => envelope({ queryResult: { results: [rows], resultMetaData: [{ page: { start: 0, size: 2 }, total }], count: 1 } });
    const t = fake(withTotal([{ _oid: "Story:1" }, { _oid: "Story:2" }], 17093));
    const p = await queryPage(t, { from: "Story", select: ["Name"], page: { size: 2, start: 0 } });
    expect((t.calls[0]!.body as Record<string, unknown>[])[0]!.needTotal).toBe(true);
    expect(p).toMatchObject({ total: 17093, more: true });
    const last = await queryPage(fake(withTotal([{ _oid: "Story:3" }], 3)), { from: "Story", select: ["Name"], page: { size: 2, start: 2 } });
    expect(last).toMatchObject({ total: 3, more: false });
    const a = await page(fake(withTotal([{ _oid: "Attachment:5", Name: "n" }], 1)), "Story:1");
    expect(a).toMatchObject({ total: 1, more: false, attachments: [{ _oid: "Attachment:5", id: "5", Name: "n", Filename: null }] });
  });
});

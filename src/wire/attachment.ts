/**
 * The attachment wire module: the files an asset carries. Two endpoints and
 * one MVC route, none of them the data API:
 *
 *   attachment.img/<id>          GET the bytes; POST bytes to replace them
 *   embedded.img/<id>            GET an image embedded in rich text
 *   EmbeddedImage.mvc/Upload     POST multipart { image, oidToken } → an EmbeddedImage
 *
 * Addressed by the numeric id, not the OID token — the one place in the API
 * that does. Bytes travel as Uint8Array, ArrayBuffer or Blob, so this works
 * in Node and the browser alike (no Buffer).
 *
 * Verified against the API-testing instance (2026-11-07):
 *   - GET attachment.img/<id> answers the bytes with the Attachment's
 *     ContentType and `Content-Disposition: inline; filename="…"`; 404 for
 *     an id that does not exist. POST raw bytes (any content type) answers
 *     200 with an empty body and replaces them.
 *   - An Attachment create requires Content (empty is allowed, absent is
 *     Violation'Required'…'Content'); Base64 Content in the create stores
 *     the bytes in one request, and selecting Content reads them back as
 *     Base64.
 *   - EmbeddedImage.mvc/Upload takes token auth and answers text/html:
 *     `<textarea>{"Url":"<base>/embedded.img/<id>","Key":"EmbeddedImage:<id>"}</textarea>`.
 *     An EmbeddedImage cannot be deleted (no Delete operation).
 */
import { ApiError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Oid } from "../types/asset";

/** Bytes as a caller has them: a Uint8Array, an ArrayBuffer, or a Blob (a browser File). */
export type Bytes = Uint8Array | ArrayBuffer | Blob;

/** Bytes as a Uint8Array, whatever they came as. */
export async function toUint8Array(data: Bytes): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

/** Base64 without Buffer, in chunks so a large file does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** The numeric id from "Attachment:5678", "Attachment:5678:999" (a moment) or "5678". */
export function numericId(spec: Oid | string | number): string {
  const m = /^(?:[A-Za-z]+:)?(\d+)(?::\d+)?$/.exec(String(spec).trim());
  if (!m) throw new TypeError(`"${spec}" is not an asset id (5678, or an OID token such as Attachment:5678)`);
  return m[1]!;
}

const join = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, "")}/${path}`;

/** Where a browser opens or downloads an attachment's bytes. */
export const attachmentUrl = (baseUrl: string, id: Oid | string | number): string => join(baseUrl, `attachment.img/${numericId(id)}`);
/** Where an embedded image is served from. */
export const embeddedImageUrl = (baseUrl: string, id: Oid | string | number): string => join(baseUrl, `embedded.img/${numericId(id)}`);

/**
 * Rich text with every `embedded.img/<id>` image reference rewritten to the
 * instance's absolute URL — what Agility's own editor stores — whatever
 * host, path or quoting the reference had before.
 */
export function normalizeEmbeddedImageUrls(html: string, baseUrl: string): string {
  return html.replace(/(\bsrc\s*=\s*)(["'])([^"']*?embedded\.img\/(\d+)[^"']*)\2/gi, (_m, attr: string, quote: string, _url: string, id: string) => `${attr}${quote}${embeddedImageUrl(baseUrl, id)}${quote}`);
}

/** The endpoint's statuses, named: 404 missing, 413 larger than the server's maximum request length. */
function named(error: unknown, what: string): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return new ApiError(`${what}: not found`, 404, "NOT_FOUND", error.details);
  if (error.status === 413) return new ApiError(`${what}: larger than the server's maximum request length`, 413, "TOO_LARGE", error.details);
  return error;
}

/** An attachment's bytes. */
export async function getBytes(transport: Transport, id: Oid | string | number): Promise<Uint8Array> {
  const n = numericId(id);
  try {
    return await transport.request<Uint8Array>({ method: "GET", path: `/attachment.img/${n}`, responseType: "bytes" });
  } catch (error) {
    throw named(error, `attachment ${n}`);
  }
}

/** An attachment's bytes with the type and filename the server sent them with (Content-Type, Content-Disposition), when it did. */
export async function getFile(transport: Transport, id: Oid | string | number): Promise<{ bytes: Uint8Array; contentType: string | null; filename: string | null }> {
  const n = numericId(id);
  let contentType: string | null = null, filename: string | null = null;
  const onResponse = ({ headers }: { headers: { get(name: string): string | null } }) => {
    contentType = headers.get("content-type");
    const disposition = headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    filename = encoded ? decodeURIComponent(encoded) : /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
  };
  try {
    const bytes = await transport.request<Uint8Array>({ method: "GET", path: `/attachment.img/${n}`, responseType: "bytes", onResponse });
    return { bytes, contentType, filename };
  } catch (error) {
    throw named(error, `attachment ${n}`);
  }
}

/** Replace an attachment's bytes. The Attachment asset (name, filename, content type) is unchanged. */
export async function putBytes(transport: Transport, id: Oid | string | number, data: Bytes, contentType = "application/octet-stream"): Promise<void> {
  const n = numericId(id);
  const body = data instanceof Blob ? data : await toUint8Array(data);
  try {
    await transport.request({ method: "POST", path: `/attachment.img/${n}`, body, contentType: data instanceof Blob && data.type ? data.type : contentType, responseType: "text" });
  } catch (error) {
    throw named(error, `attachment ${n}`);
  }
}

export interface EmbeddedImage { oid: Oid; id: string; url: string }

/**
 * Upload an image to embed in an asset's rich text. The answer is the
 * image's URL — put it in an `<img src>` — and its EmbeddedImage OID.
 */
export async function uploadEmbeddedImage(transport: Transport, asset: Oid, data: Bytes, options: { filename?: string; contentType?: string } = {}): Promise<EmbeddedImage> {
  const blob = data instanceof Blob ? data : new Blob([(await toUint8Array(data)) as Uint8Array<ArrayBuffer>], { type: options.contentType ?? "application/octet-stream" });
  const form = new FormData();
  form.append("image", blob, options.filename ?? "image");
  form.append("oidToken", asset);
  let html: string;
  try {
    html = await transport.request<string>({ method: "POST", path: "/EmbeddedImage.mvc/Upload", body: form, responseType: "text" });
  } catch (error) {
    throw named(error, `embedded image for ${asset}`);
  }
  const inner = /<textarea[^>]*>([\s\S]*?)<\/textarea>/i.exec(html)?.[1];
  let payload: { Url?: unknown; Key?: unknown } | undefined;
  try {
    payload = inner ? JSON.parse(inner.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) : undefined;
  } catch { /* reported below */ }
  if (!payload || typeof payload.Url !== "string") throw new ApiError("EmbeddedImage.mvc/Upload did not answer with an image URL", 200, "BAD_RESPONSE", html.slice(0, 500));
  const id = /embedded\.img\/(\d+)/.exec(payload.Url)?.[1] ?? (typeof payload.Key === "string" ? numericId(payload.Key) : undefined);
  if (!id) throw new ApiError("EmbeddedImage.mvc/Upload answered a URL without an image id", 200, "BAD_RESPONSE", payload);
  return { oid: typeof payload.Key === "string" ? payload.Key : `EmbeddedImage:${id}`, id, url: payload.Url };
}

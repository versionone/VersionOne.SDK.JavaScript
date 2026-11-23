/**
 * The attachments service: the files attached to an asset, as part of
 * changing that asset like any other attribute. The metadata lives on an
 * Attachment asset (api/asset); the bytes live behind attachment.img
 * (wire/attachment). Consumers never call either directly.
 *
 * Two ways in for the bytes, chosen by size:
 *   - inline: one api/asset create with Content as Base64. One request,
 *     what a browser app consumer does; the JSON is a third larger than the file.
 *   - two-step, as the docs prescribe for anything not tiny: create the
 *     Attachment with empty Content, then POST the raw bytes. A failed
 *     upload leaves an empty Attachment, which is reported, not hidden.
 *
 * Listing never selects Content: across many attachments that would Base64
 * every file into one response. Reading one file's bytes goes through
 * attachment.img.
 */
import { ApiError, WrappedError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Oid } from "../types/asset";
import { momentless } from "../types/oid";
import * as assetApi from "../wire/assetApi";
import { getFile, numericId, putBytes, toBase64, toUint8Array, type Bytes } from "../wire/attachment";

/** Files up to this size go inline by default; larger ones in two steps. */
export const INLINE_LIMIT = 1_000_000;

export interface AttachmentInfo {
  oid: Oid;
  /** The numeric id attachment.img addresses it by. */
  id: string;
  name: string | null;
  filename: string | null;
  contentType: string | null;
  description: string | null;
  createDate: string | null;
  createdBy: string | null;
}

type Row = { _oid: string; Name?: string | null; Filename?: string | null; ContentType?: string | null; Description?: string | null; CreateDate?: string | null; "CreatedBy.Name"?: string | null };
const SELECT = ["Name", "Filename", "ContentType", "Description", "CreateDate", "CreatedBy.Name"];
const infoOf = (r: Row): AttachmentInfo => {
  const oid = momentless(r._oid);
  return { oid, id: numericId(oid), name: r.Name ?? null, filename: r.Filename ?? null, contentType: r.ContentType ?? null, description: r.Description ?? null, createDate: r.CreateDate ?? null, createdBy: r["CreatedBy.Name"] ?? null };
};

/** One page of the files attached to an asset, newest first, metadata only, with the total and whether more pages follow. */
export async function page(transport: Transport, asset: Oid, options: { page?: { size: number; start: number } } = {}): Promise<{ attachments: AttachmentInfo[]; total: number | null; more: boolean }> {
  const { rows, total, more } = await assetApi.queryPage(transport, { from: "Attachment", select: SELECT, filter: ["Asset=$asset"], with: { $asset: momentless(asset) }, sort: ["-CreateDate"], page: options.page ?? { size: 50, start: 0 } });
  return { attachments: rows.map((r) => infoOf(r as unknown as Row)), total, more };
}

/** The files attached to an asset, newest first, metadata only (one page; `page` also gives the total). */
export async function list(transport: Transport, asset: Oid, options: { page?: { size: number; start: number } } = {}): Promise<AttachmentInfo[]> {
  const rows = await assetApi.query(transport, { from: "Attachment", select: SELECT, filter: ["Asset=$asset"], with: { $asset: momentless(asset) }, sort: ["-CreateDate"], page: options.page ?? { size: 50, start: 0 } });
  return rows.map((r) => infoOf(r as unknown as Row));
}

/** One attachment's metadata, or null when there is none with that id. */
export async function info(transport: Transport, id: Oid | string | number): Promise<AttachmentInfo | null> {
  const [row] = await assetApi.query(transport, { from: "Attachment", select: SELECT, filter: ["ID=$id"], with: { $id: `Attachment:${numericId(id)}` }, page: { size: 1, start: 0 } });
  return row ? infoOf(row as unknown as Row) : null;
}

/**
 * One attachment: its metadata and its bytes. `contentType` is the type the
 * server sent the bytes with, falling back to the Attachment's recorded
 * one; `recordedContentType` is always the latter.
 */
export async function get(transport: Transport, id: Oid | string | number): Promise<AttachmentInfo & { bytes: Uint8Array; recordedContentType: string | null }> {
  const meta = await info(transport, id);
  if (!meta) throw new ApiError(`attachment ${numericId(id)}: not found`, 404, "NOT_FOUND");
  const file = await getFile(transport, meta.id);
  return { ...meta, bytes: file.bytes, contentType: file.contentType ?? meta.contentType, recordedContentType: meta.contentType };
}

export interface AddOptions {
  filename: string;
  /** Defaults to the Blob's type, then application/octet-stream. */
  contentType?: string;
  /** Defaults to the filename. */
  name?: string;
  description?: string;
  /** Inline (one request) up to this many bytes, two-step above. Default INLINE_LIMIT. */
  inlineLimit?: number;
}

/** An Attachment was created but its bytes could not be uploaded: it exists, empty. Remove it or upload again with `put`. */
export class AttachmentUploadError extends WrappedError {
  constructor(readonly attachment: AttachmentInfo, cause: unknown) {
    super(`${attachment.oid} was created on its asset with no content, and uploading the file failed: ${cause instanceof Error ? cause.message : String(cause)}`, "ATTACHMENT_UPLOAD", cause);
    this.name = "AttachmentUploadError";
  }
}

/** Attach a file to an asset. Inline up to `inlineLimit` bytes, two-step above it. */
export async function add(transport: Transport, asset: Oid, data: Bytes, options: AddOptions): Promise<AttachmentInfo> {
  const bytes = await toUint8Array(data);
  const contentType = options.contentType ?? (typeof Blob !== "undefined" && data instanceof Blob && data.type ? data.type : "application/octet-stream");
  const inline = bytes.length <= (options.inlineLimit ?? INLINE_LIMIT);
  const create: assetApi.CreateBody = { AssetType: "Attachment", Asset: momentless(asset), Name: options.name ?? options.filename, Filename: options.filename, ContentType: contentType, Content: inline ? toBase64(bytes) : "" };
  if (options.description) create.Description = options.description;
  const oid = assetApi.outcomeOf(await assetApi.send(transport, [create], { throwOnFailure: true })).created[0]!;
  const created: AttachmentInfo = { oid, id: numericId(oid), name: String(create.Name), filename: options.filename, contentType, description: options.description ?? null, createDate: null, createdBy: null };
  if (!inline) {
    try {
      await putBytes(transport, created.id, bytes, contentType);
    } catch (error) {
      throw new AttachmentUploadError(created, error);
    }
  }
  return created;
}

/** Replace an attachment's bytes. */
export async function put(transport: Transport, id: Oid | string | number, data: Bytes, contentType?: string): Promise<void> {
  await putBytes(transport, id, data, contentType);
}

/** Delete an attachment. */
export async function remove(transport: Transport, id: Oid | string | number): Promise<void> {
  await assetApi.send(transport, [{ from: `Attachment:${numericId(id)}`, execute: "Delete" }], { throwOnFailure: true });
}

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
 * Listing never selects Content by itself: across many attachments that
 * would Base64 every file into one response. Reading one file's bytes goes
 * through attachment.img, or — for a small file, on request — comes inline
 * with its row in one read (`get` with `inline`).
 */
import { ApiError, WrappedError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Oid } from "../types/asset";
import type { Attachment } from "../types/assets/Attachment";
import { momentless } from "../types/oid";
import type { SelectKey, SelectPath, SelectValue } from "../types/query";
import * as assetApi from "../wire/assetApi";
import { fromBase64, getFile, numericId, putBytes, toBase64, toUint8Array, type Bytes } from "../wire/attachment";
import * as queryV1 from "../wire/queryV1";
import type { Schema } from "./schema";

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

/** What `list` and `page` take: the page (default the first 50) and, optionally, more to select. */
export interface ListOptions<S extends readonly (SelectPath<Attachment> | assetApi.QueryBody)[] | undefined = undefined> {
  page?: { size: number; start: number };
  /**
   * More to read with each attachment, as a query's `select` on Attachment
   * (`Category.Name`, `Asset.Number`, a sub-select): each answer then
   * carries those values under `selected`, keyed as selected. The
   * metadata is always read. Selecting `Content` here Base64s every file
   * on the page into one response: for one small file use `get` with
   * `inline`.
   */
  select?: S;
  /** The schema to translate the extra values with (numbers as numbers, a single relation as one Ref); the client passes its own. Without it they keep the endpoint's spelling. */
  schema?: Schema;
}

/** The values an extra `select` read, keyed as selected. */
export type AttachmentSelected<S> = S extends readonly (infer E)[] ? { [K in SelectKey<E>]: SelectValue<Attachment, K> } : never;

/** What `list` and `page` answer per attachment: the metadata, and `selected` when the call selected more. */
export type ListedAttachment<S> = S extends readonly unknown[] ? AttachmentInfo & { selected: AttachmentSelected<S> } : AttachmentInfo;

const keyOf = (entry: string | assetApi.QueryBody): string => (typeof entry === "string" ? entry : entry.from);

/** The query `list` and `page` send, and how one of its rows reads. */
async function listing<S extends readonly (SelectPath<Attachment> | assetApi.QueryBody)[] | undefined>(asset: Oid, options: ListOptions<S>) {
  const extra = (options.select ?? []) as readonly (string | assetApi.QueryBody)[];
  const have = new Set(SELECT);
  const q: assetApi.QueryBody = { from: "Attachment", select: [...SELECT, ...extra.filter((e) => !(typeof e === "string" && have.has(e)))], filter: ["Asset=$asset"], with: { $asset: momentless(asset) }, sort: ["-CreateDate"], page: options.page ?? { size: 50, start: 0 } };
  if (options.select && options.schema) await options.schema.ensureFor([q]);
  const read: assetApi.ReadOptions = options.select && options.schema ? { lookup: options.schema } : {};
  const toInfo = (row: unknown): ListedAttachment<S> => {
    const r = row as Row & Record<string, unknown>;
    const info = infoOf(r);
    return (options.select ? { ...info, selected: Object.fromEntries(extra.map(keyOf).map((k) => [k, r[k] ?? null])) } : info) as ListedAttachment<S>;
  };
  return { q, read, toInfo };
}

/** One page of the files attached to an asset, newest first, metadata only (plus whatever `select` adds), with the total and whether more pages follow. */
export async function page<const S extends readonly (SelectPath<Attachment> | assetApi.QueryBody)[] | undefined = undefined>(transport: Transport, asset: Oid, options: ListOptions<S> = {}): Promise<{ attachments: ListedAttachment<S>[]; total: number | null; more: boolean }> {
  const { q, read, toInfo } = await listing(asset, options);
  const { rows, total, more } = await assetApi.queryPage(transport, q, read);
  return { attachments: rows.map(toInfo), total, more };
}

/** The files attached to an asset, newest first, metadata only (plus whatever `select` adds); one page (`page` also gives the total). */
export async function list<const S extends readonly (SelectPath<Attachment> | assetApi.QueryBody)[] | undefined = undefined>(transport: Transport, asset: Oid, options: ListOptions<S> = {}): Promise<ListedAttachment<S>[]> {
  const { q, read, toInfo } = await listing(asset, options);
  return (await assetApi.query(transport, q, read)).map(toInfo);
}

/** One attachment's metadata, or null when there is none with that id. */
export async function info(transport: Transport, id: Oid | string | number): Promise<AttachmentInfo | null> {
  const [row] = await assetApi.query(transport, { from: "Attachment", select: SELECT, filter: ["ID=$id"], with: { $id: `Attachment:${numericId(id)}` }, page: { size: 1, start: 0 } });
  return row ? infoOf(row as unknown as Row) : null;
}

export interface GetOptions {
  /**
   * Read the bytes inline with the metadata, in one request instead of
   * two: the Attachment's Content comes back as Base64 beside its row
   * (through query.v1, so the read is resent like a GET). For small files:
   * the response is a third larger than the file and is held in memory
   * whole, and the size is not known until it arrives. `contentType` is
   * then the Attachment's recorded one (no attachment.img response to
   * read a served type from).
   */
  inline?: boolean;
}

/**
 * One attachment: its metadata and its bytes. Two requests by default (the
 * row, then attachment.img), one with `inline`. `contentType` is the type
 * the server sent the bytes with, falling back to the Attachment's recorded
 * one; `recordedContentType` is always the latter.
 */
export async function get(transport: Transport, id: Oid | string | number, options: GetOptions = {}): Promise<AttachmentInfo & { bytes: Uint8Array; recordedContentType: string | null }> {
  if (options.inline) {
    const [row] = await queryV1.query(transport, { from: "Attachment", select: [...SELECT, "Content"], filter: ["ID=$id"], with: { $id: `Attachment:${numericId(id)}` }, page: { size: 1, start: 0 } });
    if (!row) throw new ApiError(`attachment ${numericId(id)}: not found`, 404, "NOT_FOUND");
    const content = (row as { Content?: unknown }).Content;
    if (typeof content !== "string") throw new ApiError(`attachment ${numericId(id)}: the row came without its Content`, 200, "BAD_RESPONSE", row);
    const meta = infoOf(row as unknown as Row);
    return { ...meta, bytes: fromBase64(content), recordedContentType: meta.contentType };
  }
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

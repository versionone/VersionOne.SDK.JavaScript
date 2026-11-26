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
import type { Asset, DateString, Oid } from "../types/asset";
import type { Attachment } from "../types/assets/Attachment";
import { momentless } from "../types/oid";
import type { SelectKey, SelectPath, SelectValue } from "../types/query";
import * as assetApi from "../wire/assetApi";
import { fromBase64, getFile, numericId, putBytes, toBase64, toUint8Array, type Bytes } from "../wire/attachment";
import * as queryV1 from "../wire/queryV1";
import type { Schema } from "./schema";

/** Files up to this size go inline by default; larger ones in two steps. */
export const INLINE_LIMIT = 1_000_000;

/**
 * An attachment as the SDK answers it: a row of the Attachment asset type,
 * under meta.v1's own attribute names like every other row, with what was
 * selected and nothing else — plus `id`, the number attachment.img
 * addresses the file by (the one place the API uses a bare id). The type
 * is closed: it has these keys and the ones a `select` named, so reading
 * any other (`row.filename`, `row.FileName`) is a compile error.
 */
export interface AttachmentInfo {
  /** The attachment's OID token, momentless: "Attachment:5678". */
  _oid: Oid;
  /** The numeric id attachment.img addresses it by: "5678" for Attachment:5678. */
  id: string;
  Name: string | null;
  Filename: string | null;
  /** The content type recorded on the Attachment. */
  ContentType: string | null;
  Description: string | null;
  CreateDate: DateString | null;
  /** The creating member's name: the select path, as selected. */
  "CreatedBy.Name": string | null;
}

/** What every attachment read selects. */
export const SELECT = ["Name", "Filename", "ContentType", "Description", "CreateDate", "CreatedBy.Name"] as const;
const DEFAULTS: Record<string, null> = Object.fromEntries(SELECT.map((k) => [k, null]));
/** A row as answered: OID momentless, its numeric id beside it, an attribute the server left out read as null. */
const infoOf = <T extends AttachmentInfo = AttachmentInfo>(row: Asset): T => {
  const oid = momentless(row._oid);
  return { ...DEFAULTS, ...row, _oid: oid, id: numericId(oid) } as unknown as T;
};

type Extra = readonly (SelectPath<Attachment> | assetApi.QueryBody)[];

/** What `list` and `page` take: the page (default the first 50) and, optionally, more to select. */
export interface ListOptions<S extends Extra | undefined = undefined> {
  page?: { size: number; start: number };
  /**
   * More to read with each attachment, as a query's `select` on Attachment
   * (`Category.Name`, `Asset.Number`, a sub-select): each row then carries
   * those keys too, as selected. The metadata is always read. Selecting
   * `Content` here Base64s every file on the page into one response: for
   * one small file use `get` with `inline`.
   */
  select?: S;
  /** The schema to translate the extra values with (numbers as numbers, a single relation as one Ref); the client passes its own. Without it they keep the endpoint's spelling. */
  schema?: Schema;
}

/** An attachment row with the extra keys a `select` added, typed by what was selected. */
export type ListedAttachment<S> = S extends readonly (infer E)[] ? AttachmentInfo & { [K in SelectKey<E>]: SelectValue<Attachment, K> } : AttachmentInfo;

/** The query `list` and `page` send, and how to read it. */
async function listing<S extends Extra | undefined>(asset: Oid, options: ListOptions<S>) {
  const extra = (options.select ?? []) as readonly (string | assetApi.QueryBody)[];
  const have = new Set<string>(SELECT);
  const q: assetApi.QueryBody = { from: "Attachment", select: [...SELECT, ...extra.filter((e) => !(typeof e === "string" && have.has(e)))], filter: ["Asset=$asset"], with: { $asset: momentless(asset) }, sort: ["-CreateDate"], page: options.page ?? { size: 50, start: 0 } };
  if (options.select && options.schema) await options.schema.ensureFor([q]);
  const read: assetApi.ReadOptions = options.select && options.schema ? { lookup: options.schema } : {};
  return { q, read };
}

/** One page of the files attached to an asset, newest first, metadata only (plus whatever `select` adds), with the total and whether more pages follow. */
export async function page<const S extends Extra | undefined = undefined>(transport: Transport, asset: Oid, options: ListOptions<S> = {}): Promise<{ attachments: ListedAttachment<S>[]; total: number | null; more: boolean }> {
  const { q, read } = await listing(asset, options);
  const { rows, total, more } = await assetApi.queryPage(transport, q, read);
  return { attachments: rows.map((r) => infoOf<ListedAttachment<S>>(r)), total, more };
}

/** The files attached to an asset, newest first, metadata only (plus whatever `select` adds); one page (`page` also gives the total). */
export async function list<const S extends Extra | undefined = undefined>(transport: Transport, asset: Oid, options: ListOptions<S> = {}): Promise<ListedAttachment<S>[]> {
  const { q, read } = await listing(asset, options);
  return (await assetApi.query(transport, q, read)).map((r) => infoOf<ListedAttachment<S>>(r));
}

/** One attachment's metadata, or null when there is none with that id. */
export async function info(transport: Transport, id: Oid | string | number): Promise<AttachmentInfo | null> {
  const [row] = await assetApi.query(transport, { from: "Attachment", select: [...SELECT], filter: ["ID=$id"], with: { $id: `Attachment:${numericId(id)}` }, page: { size: 1, start: 0 } });
  return row ? infoOf(row) : null;
}

export interface GetOptions {
  /**
   * Read the bytes inline with the metadata, in one request instead of
   * two: the Attachment's Content comes back as Base64 beside its row
   * (through query.v1, so the read is resent like a GET). For small files:
   * the response is a third larger than the file and is held in memory
   * whole, and the size is not known until it arrives. `servedContentType`
   * is then null (no attachment.img response to read one from).
   */
  inline?: boolean;
}

/** An attachment with its bytes. */
export interface AttachmentFile extends AttachmentInfo {
  bytes: Uint8Array;
  /** The Content-Type attachment.img served the bytes with; null for an inline read. `ContentType` is the recorded one. */
  servedContentType: string | null;
  /** The content as Base64, on an inline read only: it is how the content arrived, so a caller that wants Base64 need not encode the bytes again. */
  base64?: string;
}

/**
 * One attachment: its metadata and its bytes. Two requests by default (the
 * row, then attachment.img), one with `inline`.
 */
export async function get(transport: Transport, id: Oid | string | number, options: GetOptions = {}): Promise<AttachmentFile> {
  if (options.inline) {
    const [row] = await queryV1.query(transport, { from: "Attachment", select: [...SELECT, "Content"], filter: ["ID=$id"], with: { $id: `Attachment:${numericId(id)}` }, page: { size: 1, start: 0 } });
    if (!row) throw new ApiError(`attachment ${numericId(id)}: not found`, 404, "NOT_FOUND");
    const { Content: content, ...rest } = row as Asset & { Content?: unknown };
    if (typeof content !== "string") throw new ApiError(`attachment ${numericId(id)}: the row came without its Content`, 200, "BAD_RESPONSE", row);
    return { ...infoOf(rest), bytes: fromBase64(content), servedContentType: null, base64: content };
  }
  const meta = await info(transport, id);
  if (!meta) throw new ApiError(`attachment ${numericId(id)}: not found`, 404, "NOT_FOUND");
  const file = await getFile(transport, meta.id);
  return { ...meta, bytes: file.bytes, servedContentType: file.contentType };
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

/**
 * What `add` answers: the attachment as it was written. The server's own
 * stamps (when it was created, and by whom) are not read back, so they are
 * not in the type at all — a null there would read as "it has none". Read
 * the attachment with `info` for those.
 */
export type AddedAttachment = Omit<AttachmentInfo, "CreateDate" | "CreatedBy.Name">;

/** An Attachment was created but its bytes could not be uploaded: it exists, empty. Remove it or upload again with `put`. */
export class AttachmentUploadError extends WrappedError {
  constructor(readonly attachment: AddedAttachment, cause: unknown) {
    super(`${attachment._oid} was created on its asset with no content, and uploading the file failed: ${cause instanceof Error ? cause.message : String(cause)}`, "ATTACHMENT_UPLOAD", cause);
    this.name = "AttachmentUploadError";
  }
}

/** Attach a file to an asset. Inline up to `inlineLimit` bytes, two-step above it. Answers the attachment as written, without the server's own stamps (read it with `info` for its `CreateDate` and creator). */
export async function add(transport: Transport, asset: Oid, data: Bytes, options: AddOptions): Promise<AddedAttachment> {
  const bytes = await toUint8Array(data);
  const contentType = options.contentType ?? (typeof Blob !== "undefined" && data instanceof Blob && data.type ? data.type : "application/octet-stream");
  const inline = bytes.length <= (options.inlineLimit ?? INLINE_LIMIT);
  const create: assetApi.CreateBody = { AssetType: "Attachment", Asset: momentless(asset), Name: options.name ?? options.filename, Filename: options.filename, ContentType: contentType, Content: inline ? toBase64(bytes) : "" };
  if (options.description) create.Description = options.description;
  const oid = assetApi.outcomeOf(await assetApi.send(transport, [create], { throwOnFailure: true })).created[0]!;
  const created: AddedAttachment = { _oid: oid, id: numericId(oid), Name: String(create.Name), Filename: options.filename, ContentType: contentType, Description: options.description ?? null };
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

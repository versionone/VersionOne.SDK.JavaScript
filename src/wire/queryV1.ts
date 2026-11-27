/**
 * The query.v1 wire module: reads only. The endpoint takes the same query
 * bodies as api/asset's query commands and answers with nothing but the
 * rows — an array with one array of rows per query, in request order — so
 * it is the simplest place to explore what a query does. api/asset can do
 * everything query.v1 does (and write); query.v1 can never write.
 *
 * Verified against the API-testing instance (2026-11-06):
 *   - POST a query body, or an array of them (or YAML documents separated by
 *     ---); the answer is [[row, …], …], [] for a query that matched nothing.
 *   - rows are spelled exactly as api/asset spells them: every scalar a
 *     string ("2", "True"), a relation { _oid }, a multi-value relation a
 *     list, a sub-selected single relation a list. So they translate through
 *     the same schema the same way.
 *   - one bad query fails the whole request: 400 with rest-1's error shape,
 *     { error: "Bad Request", exceptions: [{ type, message }, …] }, and no
 *     rows at all. The useful text is in exceptions, not error.
 *   - a filter literal with an em dash fails here too; a `with` variable
 *     carrying the same value works.
 *
 * Because the endpoint cannot change anything, a request is sent idempotent:
 * the transport may retry it after a network failure or a 5xx like a GET.
 */
import { ApiError, UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset } from "../types/asset";
import { fromWireRow, type QueryBody, type ReadOptions, type RowContext } from "./assetApi";
import { fromTypeOf } from "./select";

/** What query.v1 said about each refused query: its exception type and message. */
export interface QueryRejection { type: string | null; message: string }

/**
 * The error for a read the server refused, whichever endpoint refused it
 * (query.v1 and rest-1 answer a 400 in the same document shape): the exceptions'
 * messages joined as the message, and `details` the exceptions alone
 * ({ type, message }[]) — not the whole error document, so a caller that
 * prints details prints what matters.
 */
export function rejected(error: ApiError): ApiError {
  const details = error.details as { error?: unknown; exceptions?: { type?: unknown; message?: unknown }[] } | undefined;
  const rejections: QueryRejection[] = (details?.exceptions ?? []).filter((e) => e && typeof e.message === "string" && e.message).map((e) => ({ type: typeof e.type === "string" ? e.type : null, message: e.message as string }));
  // The server's own timeout is not a refusal of the query, whatever status it came with.
  // Nor is a write refused for want of rights (rest-1's 400 with a Security violation): it keeps its kind.
  if (!rejections.length || error.code === "SERVER_TIMEOUT" || error.kind === "forbidden") return error;
  // rest-1 names what it refused in `error` ("Invalid WHERE parameter"); query.v1 says only "Bad Request", which adds nothing.
  const lead = typeof details?.error === "string" && details.error && details.error !== "Bad Request" ? [details.error] : [];
  return new ApiError([...lead, ...rejections.map((r) => r.message)].join("; "), error.status, "QUERY_REJECTED", rejections);
}

/**
 * Several queries in one request; one array of rows per query, in order, []
 * where a query matched nothing. A page is required on every query. A
 * query the server refuses throws (an ApiError coded QUERY_REJECTED, with
 * the server's messages) — never an empty result.
 */
export async function queries<Row extends Asset = Asset>(transport: Transport, qs: QueryBody[], options: ReadOptions = {}): Promise<Row[][]> {
  for (const q of qs) if (!q.page) throw new UsageError(`query of ${q.from} without a page: every query.v1 read must be bounded`);
  if (!qs.length) return [];
  let response: unknown;
  try {
    response = await transport.request<unknown>({ method: "POST", path: "/query.v1", body: qs, responseType: "json", idempotent: true });
  } catch (error) {
    throw error instanceof ApiError && error.status === 400 ? rejected(error) : error;
  }
  if (!Array.isArray(response) || response.length !== qs.length || !response.every(Array.isArray)) {
    throw new ApiError(`query.v1 answered with ${Array.isArray(response) ? `${response.length} results` : "no result list"} for ${qs.length} queries`, 200, "BAD_RESPONSE", response);
  }
  return qs.map((q, i) => {
    const type = options.lookup ? fromTypeOf(q.from, qs) : null;
    const context: RowContext | undefined = type ? { lookup: options.lookup!, type } : undefined;
    return (response as Record<string, unknown>[][])[i]!.map((row) => fromWireRow<Row>(row, context));
  });
}

/** One query, its rows. */
export async function query<Row extends Asset = Asset>(transport: Transport, q: QueryBody, options: ReadOptions = {}): Promise<Row[]> {
  const [rows] = await queries<Row>(transport, [q], options);
  return rows ?? [];
}

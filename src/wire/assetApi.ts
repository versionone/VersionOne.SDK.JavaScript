/**
 * The api/asset (Bulk API) wire module: exactly what the endpoint takes and
 * returns, and the translation between that and the model.
 *
 * The model is endpoint-agnostic: a relation is a Ref ({ _oid }), whatever
 * endpoint it came from or is going to. This module is where api/asset's
 * spellings live — a relation value written as an OID string (or an array
 * of them), one aliased command per array element, `previewOnly` on the
 * query string, YAML as a text body — so callers never learn them.
 *
 * Verified shapes (agility-api-documentation, asset-bulk section):
 *   - response: requestId, createdDate, completedDate, duration,
 *     durationSeconds, complete, processing, assetsCreated/assetsModified/
 *     assetsOperatedOn { oidTokens, count }, commandFailures { commands,
 *     count } with each entry the echoed command (its alias replaced by a
 *     generated one) plus error { message, sourceCommandIndex, stackTrace? }
 *     — sourceCommandIndex is the only reliable key back to the request —
 *     and queryResult { results, resultMetaData, count } with results
 *     POSITIONAL, one array per query command in request order.
 *   - a batch commits per command: a later failure does not undo an
 *     earlier success, and the HTTP status is 200 either way.
 *   - preview (?previewOnly=true) returns the projection: creates echoed,
 *     bare query-scoped updates and executes expanded to one command per
 *     matched asset, aliased ones echoed unexpanded.
 */
import type { Transport } from "../core/transport";
import type { Asset, Oid, Ref } from "../types/asset";

// ---- what the endpoint takes ------------------------------------------------

/** A value in a command as the MODEL writes it: scalars, Refs, lists of either, or a nested command. */
export type CommandValue = string | number | boolean | null | Ref | CommandValue[] | { [key: string]: CommandValue };

export interface CreateBody { AssetType: string; [attribute: string]: CommandValue }
export interface QueryBody {
  from: string;
  select?: (string | QueryBody)[];
  filter?: string[];
  where?: Record<string, string>;
  with?: Record<string, CommandValue>;
  sort?: string[];
  page?: { size: number; start: number };
  find?: string;
  findin?: string[];
  asof?: string;
}
export interface UpdateBody { from: string; filter?: string[]; where?: Record<string, string>; with?: Record<string, CommandValue>; update: Record<string, CommandValue> }
export interface ExecuteBody { from: string; filter?: string[]; where?: Record<string, string>; with?: Record<string, CommandValue>; execute: string | { op: string; args?: Record<string, CommandValue>; list?: Record<string, CommandValue>[] } }
export type CommandBody = CreateBody | QueryBody | UpdateBody | ExecuteBody;

/** An alias key: "@story". */
export type Alias = `@${string}`;
/** A command as sent: aliased ({ "@x": body }) or bare (the body itself). */
export type Command = { [alias: Alias]: CommandBody } | CommandBody;

// ---- what the endpoint returns ----------------------------------------------

export interface OidTokens { oidTokens: Oid[]; count: number }
export interface CommandError { message: string; sourceCommandIndex?: number; stackTrace?: string }
/** The echoed command (under a generated alias) plus the error. */
export type CommandFailure = { error: CommandError | string } & Record<string, unknown>;
export interface AssetApiResponse<Row extends Asset = Asset> {
  requestId: string;
  createdDate: string;
  completedDate: string;
  duration: string;
  durationSeconds: number;
  complete: boolean;
  processing: boolean;
  assetsCreated: OidTokens;
  assetsModified: OidTokens;
  assetsOperatedOn: OidTokens;
  commandFailures: { commands: CommandFailure[]; count: number };
  queryResult: { results: Row[][]; resultMetaData: unknown[]; count: number };
}

// ---- translation ------------------------------------------------------------

const isRef = (v: unknown): v is Ref => !!v && typeof v === "object" && !Array.isArray(v) && "_oid" in v && typeof (v as Ref)._oid === "string";

/** An OID token without its moment: "Story:1234:5678" -> "Story:1234". */
export const momentless = (oid: string): Oid => oid.split(":").slice(0, 2).join(":");

/**
 * A model value as api/asset wants it written: a Ref becomes its OID token,
 * a list of Refs a list of tokens, and everything else is left as is —
 * strings (OID tokens, monikers, alias references like "@story") pass
 * through untouched, and nested command bodies are translated recursively.
 */
export function toWireValue(value: CommandValue): unknown {
  if (isRef(value)) return momentless(value._oid);
  if (Array.isArray(value)) return value.map(toWireValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWireValue(v)]));
  return value;
}

/** A batch as api/asset wants it. */
export const toWire = (commands: Command[]): unknown[] => commands.map((c) => toWireValue(c as CommandValue));

/**
 * A query row as the model carries it. query.v1 already speaks the model's
 * relation shape ({ _oid } and [{ _oid }]), so this is nearly identity: OIDs
 * lose their moment, and nothing else is touched.
 */
export function fromWireRow<Row extends Asset = Asset>(row: Record<string, unknown>): Row {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = k === "_oid" && typeof v === "string" ? momentless(v) : fromWireValue(v);
  return out as Row;
}
function fromWireValue(value: unknown): unknown {
  if (isRef(value)) return { ...value, _oid: momentless(value._oid) };
  if (Array.isArray(value)) return value.map(fromWireValue);
  return value;
}

/** The failures of a response, normalised: index and message, always both. */
export function failuresOf<Row extends Asset = Asset>(response: AssetApiResponse<Row>): { index: number | null; message: string; echoed: Record<string, unknown> }[] {
  return (response.commandFailures?.commands ?? []).map(({ error, ...echoed }) => ({
    index: typeof error === "object" && error && typeof error.sourceCommandIndex === "number" ? error.sourceCommandIndex : null,
    message: typeof error === "string" ? error : error?.message || "command failed",
    echoed
  }));
}

// ---- the calls --------------------------------------------------------------

export interface SendOptions {
  /** Return the projection instead of executing (?previewOnly=true). */
  previewOnly?: boolean;
}

/** Send a batch. The response is the envelope; per-command failures are inside it, not thrown. */
export async function send<Row extends Asset = Asset>(transport: Transport, commands: Command[], options: SendOptions = {}): Promise<AssetApiResponse<Row>> {
  const response = await transport.request<AssetApiResponse<Row>>({
    method: "POST",
    path: "/api/asset",
    query: options.previewOnly ? { previewOnly: "true" } : undefined,
    body: toWire(commands),
    responseType: "json"
  });
  return { ...response, queryResult: { ...response.queryResult, results: (response.queryResult?.results ?? []).map((rows) => rows.map((r) => fromWireRow<Row>(r as Record<string, unknown>))) } };
}

/** Preview a batch: the projection, one command per asset the server would touch. */
export async function preview(transport: Transport, commands: Command[]): Promise<Command[]> {
  return transport.request<Command[]>({ method: "POST", path: "/api/asset", query: { previewOnly: "true" }, body: toWire(commands), responseType: "json" });
}

/**
 * Send YAML as written. api/asset parses it server-side (a single document
 * or several separated by ---); with previewOnly the parsed commands come
 * back as JSON, which is how a caller gets YAML parsed without a parser.
 */
export async function sendYaml<Row extends Asset = Asset>(transport: Transport, yaml: string, options: SendOptions = {}): Promise<AssetApiResponse<Row> | Command[]> {
  return transport.request({ method: "POST", path: "/api/asset", query: options.previewOnly ? { previewOnly: "true" } : undefined, body: yaml, contentType: "text/yaml", responseType: "json" });
}

/** One query, its rows. A page is required: no read of api/asset is unbounded. */
export async function query<Row extends Asset = Asset>(transport: Transport, q: QueryBody): Promise<Row[]> {
  const [rows] = await queries<Row>(transport, [q]);
  return rows ?? [];
}

/** Several queries in one request; one array of rows per query, in order, [] where a query matched nothing. */
export async function queries<Row extends Asset = Asset>(transport: Transport, qs: QueryBody[]): Promise<Row[][]> {
  for (const q of qs) if (!q.page) throw new Error(`query of ${q.from} without a page: every api/asset read must be bounded`);
  const response = await send<Row>(transport, qs);
  return qs.map((_, i) => response.queryResult.results[i] ?? []);
}

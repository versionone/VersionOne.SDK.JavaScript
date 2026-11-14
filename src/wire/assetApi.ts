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
 * Verified shapes (https://docs.digital.ai/agility-api/apis/asset-bulk, and
 * its errors page for commandFailures):
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
import { ApiError, UsageError } from "../core/errors";
import type { Transport } from "../core/transport";
import type { Asset, Oid, Ref } from "../types/asset";
import type { AssetTypeToken, AttributeLookup, AttributeTokenRef, AttributeType } from "../types/metamodel";
import type { CreateType, From, SelectPath, TypeOf } from "../types/query";
import { momentless } from "../types/oid";
import { fromTypeOf, resolvePath, type PathResolution } from "./select";

export { momentless };

// ---- what the endpoint takes ------------------------------------------------

/** A value in a command as the MODEL writes it: scalars, Refs, lists of either, or a nested command. */
export type CommandValue = string | number | boolean | null | Ref | CommandValue[] | { [key: string]: CommandValue };

export interface CreateBody { AssetType: CreateType; [attribute: string]: CommandValue }
/**
 * A query. Written with a literal `from`, `select` completes from that
 * type's attributes and the rows come back typed by what was selected
 * (src/types/query.ts); written from variables, it is what it always was.
 */
export interface QueryBody<F extends string = string> {
  from: F | From;
  select?: (SelectPath<TypeOf<F>> | QueryBody)[];
  filter?: string[];
  where?: Record<string, string>;
  with?: Record<string, CommandValue>;
  sort?: string[];
  page?: { size: number; start: number };
  find?: string;
  findin?: string[];
  asof?: string;
  /** Ask api/asset for the total number of matches (query.v1 ignores it); read it with queryPage. */
  needTotal?: boolean;
  /** Group the rows by a relation: each result row is then a group, its rows under `_children` (translated like any row of `from`). */
  group?: (string | { from: string; [key: string]: unknown })[];
}
/**
 * An update. Each key of `update` is an attribute; its value replaces a
 * scalar or a single relation (null clears it). A multi-value relation is
 * changed with `{ add: [...], remove: [...] }`. A plain list does NOT
 * replace a multi-value relation: the server ADDS its members, like rest-1's
 * `act: "add"` (seen live on v1sdktesting, 2026-11-07). To set one exactly,
 * remove what should go and add what should come. A change comment goes in
 * the update node as `ChangeComment`.
 */
export interface UpdateBody { from: From; filter?: string[]; where?: Record<string, string>; with?: Record<string, CommandValue>; update: Record<string, CommandValue> }
/**
 * An operation (QuickClose, Inactivate, Reactivate, Delete, …), optionally
 * with arguments. It cannot carry a change comment. Agility refuses to
 * Delete a closed asset (Violation'AssetCannotDeleteClosed): Reactivate it
 * first, as batch.reversible does.
 */
export interface ExecuteBody { from: From; filter?: string[]; where?: Record<string, string>; with?: Record<string, CommandValue>; execute: string | { op: string; args?: Record<string, CommandValue>; list?: Record<string, CommandValue>[] } }
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
  /**
   * One slot per query command, in request order; [] where a query matched
   * nothing. The server DROPS the slot of a query that failed, shifting the
   * later ones up (live, 2026-11-04); send puts the slot back as null, so a
   * caller's positions hold and a failure never reads as an empty result.
   */
  queryResult: { results: (Row[] | null)[]; resultMetaData: unknown[]; count: number };
}

// ---- translation ------------------------------------------------------------

const isRef = (v: unknown): v is Ref => !!v && typeof v === "object" && !Array.isArray(v) && "_oid" in v && typeof (v as Ref)._oid === "string";

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
 * What a row is translated against: the schema, and the type of the rows.
 * Without it a row is passed through with only its OIDs normalised, which
 * is the endpoint's own spelling: every scalar a string, a sub-selected
 * single relation a one-element list.
 */
export interface RowContext { lookup: AttributeLookup; type: AssetTypeToken }

/**
 * A query row as the model carries it. The endpoint spells every scalar as a
 * string ("5", "False") and a single relation selected with a sub-select as
 * a one-element list ([{ _oid }], or [] when unset); with a schema each key
 * is resolved to its attribute and translated — Numeric, LongInt and Rank
 * to number, Boolean to boolean, [x] to x and [] to null on a single
 * relation, { _oid: "NULL" } (an unset single relation) to null,
 * an @Count to number, and a sub-select's rows recursively by their own
 * type. Everywhere, OIDs lose their moment. A key the schema cannot resolve
 * is left as sent.
 */
export function fromWireRow<Row extends Asset = Asset>(row: Record<string, unknown>, context?: RowContext): Row {
  const out: Record<string, unknown> = {};
  // A `group` query answers with group rows: the group's key as `_oid` and
  // the grouped rows under `_children`. The children are rows of the query's
  // own type (or group rows again, for nested groups), so they translate
  // with the same context. No attribute is called _children, so its presence
  // is what marks a group row; a "NULL" key is the group of rows with the
  // relation unset, and reads as null like any unset relation.
  const grouped = Array.isArray(row._children);
  for (const [k, v] of Object.entries(row)) {
    if (grouped && k === "_children") out[k] = (v as unknown[]).map((child) => (child && typeof child === "object" ? fromWireRow(child as Record<string, unknown>, context) : child));
    else if (grouped && k === "_oid" && v === "NULL") out[k] = null;
    else if (k === "_oid" && typeof v === "string") out[k] = momentless(v);
    else out[k] = context ? translate(v, resolvePath(context.lookup, context.type, k), context.lookup) : fromWireValue(v);
  }
  return out as Row;
}
/**
 * An unset single relation selected without a sub-select: the endpoint
 * sends { _oid: "NULL" } (seen live on TeamRoom.Team, 2026-11-06). The
 * model reads it as null, never as a Ref to an asset called NULL.
 */
const isNullRef = (value: unknown): boolean => isRef(value) && value._oid === "NULL";

function fromWireValue(value: unknown): unknown {
  if (isNullRef(value)) return null;
  if (isRef(value)) return { ...value, _oid: momentless(value._oid) };
  if (Array.isArray(value)) return value.map(fromWireValue);
  return value;
}

function translate(value: unknown, resolution: PathResolution, lookup: AttributeLookup): unknown {
  if (resolution.kind !== "resolved") return fromWireValue(value);
  if (resolution.aggregate) return toNumber(value);
  const definition = resolution.definition!;
  if (definition.AttributeType === "Relation") {
    const context = resolution.valueType ? { lookup, type: resolution.valueType } : undefined;
    const one = (x: unknown): unknown => (isNullRef(x) ? null : isRef(x) ? fromWireRow(x as Record<string, unknown>, context) : fromWireValue(x));
    if (resolution.multi) return (Array.isArray(value) ? value : value == null ? [] : [value]).filter((x) => !isNullRef(x)).map(one);
    if (Array.isArray(value)) return value.length ? one(value[0]) : null;
    return value == null ? null : one(value);
  }
  const one = (x: unknown): unknown => scalar(x, definition.AttributeType);
  return resolution.multi && Array.isArray(value) ? value.map(one) : one(value);
}

/** A scalar as the model carries it, from the string the endpoint sent. A value that does not parse is left as sent. */
function scalar(value: unknown, type: AttributeType): unknown {
  if (value == null) return null;
  switch (type) {
    case "Numeric":
    case "LongInt":
    case "Rank": // a 32-bit integer sent as a string ("-2000000000"); sorts as a number
      return toNumber(value);
    case "Boolean":
      return value === true || value === "True" || value === "true" ? true : value === false || value === "False" || value === "false" ? false : value;
    default:
      return value;
  }
}
function toNumber(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isNaN(n) ? value : n;
}

/**
 * One failed command, normalised. `index` is the zero-based position, in
 * the batch as sent, of the command that produced the failure (the server's
 * sourceCommandIndex — the echoed alias is replaced by a generated one, so
 * the index is the only key back to the request); null when the server gave
 * none. Several failures can share one index: a failed create fails every
 * descendant it would have parented, and the first entry is the root cause.
 * `message` is the server's text, often an apostrophe-delimited token
 * ("Violation'Invalid'Epic.Scope") a caller can branch on or run through
 * loc-2 — but an unknown attribute reads differently in `select` and in
 * `where`, so match on text with care. stackTrace is never kept: only
 * internal development builds send it.
 */
export interface CommandFailureDetail {
  index: number | null;
  message: string;
  /**
   * The command as the server echoed it, under a generated alias: what a
   * caller resends after correcting it. Readable on every failure but not
   * enumerable, so a serialised failure (a receipt, a log line) carries
   * index, message and violation and not the whole command.
   */
  readonly echoed: Record<string, unknown>;
  /** The message read as a validation violation, when it is one. */
  violation: Violation | null;
}

/** A failure detail with `echoed` readable but not enumerable. */
function failureDetail(index: number | null, message: string, echoed: Record<string, unknown>): CommandFailureDetail {
  const detail = { index, message, violation: parseViolation(message) } as CommandFailureDetail;
  Object.defineProperty(detail, "echoed", { value: echoed, enumerable: false, writable: false });
  return detail;
}

/**
 * A validation failure as api/asset words it: `Violation'<Rule>'<tag>`,
 * where the rule is Required, Invalid, AssetCannotDeleteClosed, … and the
 * rest, when present, names what was violated. The attribute form is a
 * loc-2 tag (`AttributeDefinition'Scope'Story`, live 2026-11-12), which
 * `client.localize` turns into the attribute's label; an older spelling is
 * the token itself (`Epic.Scope`). Both read as `attribute: "Story.Scope"`.
 */
export interface Violation {
  rule: string;
  /** "Story.Scope" when the violation names an attribute; null otherwise. */
  attribute: AttributeTokenRef | null;
  /** The loc-2 tag naming what was violated (`AttributeDefinition'Scope'Story`), when the message carries one; null for the token spelling. */
  tag: string | null;
}

/** The violation a failure message describes, or null when it is not one. */
export function parseViolation(message: string): Violation | null {
  const parts = message.trim().split("'");
  if (parts[0] !== "Violation" || !parts[1]) return null;
  const rule = parts[1], rest = parts.slice(2).filter((p) => p !== "");
  if (rest[0] === "AttributeDefinition" && rest[1] && rest[2]) return { rule, attribute: `${rest[2]}.${rest[1]}`, tag: rest.join("'") };
  // The older spelling names the attribute by its token ("Epic.Scope"): not a loc-2 tag, so `tag` is null there.
  const token = rest.length === 1 && /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(rest[0]!) ? (rest[0] as AttributeTokenRef) : null;
  return { rule, attribute: token, tag: !token && rest.length > 1 ? rest.join("'") : null };
}

/** The failures of a response, normalised: index and message, always both. */
export function failuresOf<Row extends Asset = Asset>(response: AssetApiResponse<Row>): CommandFailureDetail[] {
  return (response.commandFailures?.commands ?? []).map(({ error, ...echoed }) => failureDetail(
    typeof error === "object" && error && typeof error.sourceCommandIndex === "number" ? error.sourceCommandIndex : null,
    typeof error === "string" ? error : error?.message || "command failed",
    echoed
  ));
}

/** What a batch did, in the model's terms: the services read this, never the envelope. */
export interface Outcome<Row extends Asset = Asset> {
  /** The server's id for the request: what to quote when asking about a batch. Null for an outcome merged from several sends. */
  requestId: string | null;
  created: Oid[];
  modified: Oid[];
  operated: Oid[];
  failures: CommandFailureDetail[];
  /** One slot per query, in request order; null where the query failed. */
  queryResults: (Row[] | null)[];
  durationSeconds: number | null;
}

/**
 * The outcome of a (translated) response: OIDs momentless, failures
 * normalised. Every field has a default, so a partial envelope (a test fake
 * that sends only queryResult) still yields a complete Outcome; consumers'
 * fakes rely on that, and the unit tests keep it so.
 */
export function outcomeOf<Row extends Asset = Asset>(response: AssetApiResponse<Row>): Outcome<Row> {
  return {
    requestId: typeof response.requestId === "string" && response.requestId ? response.requestId : null,
    created: (response.assetsCreated?.oidTokens ?? []).map(momentless),
    modified: (response.assetsModified?.oidTokens ?? []).map(momentless),
    operated: (response.assetsOperatedOn?.oidTokens ?? []).map(momentless),
    failures: failuresOf(response),
    queryResults: response.queryResult?.results ?? [],
    durationSeconds: typeof response.durationSeconds === "number" ? response.durationSeconds : null
  };
}

/** An outcome with nothing in it, to merge several sends into. */
export const emptyOutcome = <Row extends Asset = Asset>(): Outcome<Row> => ({ requestId: null, created: [], modified: [], operated: [], failures: [], queryResults: [], durationSeconds: null });

/**
 * Add one send's outcome to another's, for a batch sent in several
 * requests. `offset` is how many commands were sent before this one, so a
 * failure's index stays a position in everything sent.
 */
export function mergeOutcome<Row extends Asset = Asset>(into: Outcome<Row>, done: Outcome<Row>, offset: number): Outcome<Row> {
  into.created.push(...done.created);
  into.modified.push(...done.modified);
  into.operated.push(...done.operated);
  into.failures.push(...done.failures.map((f) => failureDetail(f.index === null ? null : f.index + offset, f.message, f.echoed)));
  into.queryResults.push(...done.queryResults);
  into.requestId = null; // several sends, several ids: none is "the" request
  if (done.durationSeconds !== null) into.durationSeconds = (into.durationSeconds ?? 0) + done.durationSeconds;
  return into;
}

/**
 * A batch in which at least one command failed. api/asset answers 200 and
 * commits per command, so this is not an HTTP failure and not all-or-
 * nothing: `response` is the whole (translated) envelope, with whatever did
 * succeed — created OIDs, modified OIDs, query rows — and `failures` says
 * which commands did not, by index. The message joins the failures'
 * messages, root cause first, so a log line reads like the server's own
 * words. To retry, correct and resend `response.commandFailures.commands`
 * verbatim: each entry is a complete command under its alias wrapper, the
 * succeeded commands are absent, so nothing is applied twice. Resending the
 * original batch is not safe. (Echoed execute failures do not resend
 * cleanly; rewrite them as from-addressed executes.)
 */
export class CommandFailureError<Row extends Asset = Asset> extends ApiError {
  readonly failures: CommandFailureDetail[];
  readonly response: AssetApiResponse<Row>;
  /** What the batch did, in the model's terms: the commands that succeeded are committed. */
  readonly outcome: Outcome<Row>;

  constructor(response: AssetApiResponse<Row>, failures: CommandFailureDetail[] = failuresOf(response)) {
    super(failures.map((f) => f.message).join("; ") || "command failed", 200, "CommandFailure", failures);
    this.name = "CommandFailureError";
    this.failures = failures;
    this.response = response;
    this.outcome = outcomeOf(response);
  }
}

// ---- the calls --------------------------------------------------------------

export interface ReadOptions {
  /** The schema to translate rows with; the types the queries touch must already be loaded (Schema.ensureFor). Without it, rows keep the endpoint's spelling. */
  lookup?: AttributeLookup;
}

export interface SendOptions extends ReadOptions {
  /** Return the projection instead of executing (?previewOnly=true). */
  previewOnly?: boolean;
  /**
   * Throw a CommandFailureError when any command failed, instead of
   * returning the envelope with failures inside it. The commands that
   * succeeded are committed either way; the error carries the response.
   */
  throwOnFailure?: boolean;
  /**
   * The caller has made this batch safe to send twice (a guarded batch with
   * no creates: services/guard) and says so; the transport may then retry it
   * after a network failure or a 5xx. Never set it for a plain batch: a
   * retried write after a timeout is a double write.
   */
  idempotent?: boolean;
}

/** A command's body, aliased or bare. */
const bodyOf = (c: Command): unknown => { const keys = Object.keys(c); return keys.length === 1 && keys[0]!.startsWith("@") ? (c as Record<string, unknown>)[keys[0]!] : c; };
const isQuery = (body: unknown): body is QueryBody => !!body && typeof body === "object" && typeof (body as QueryBody).from === "string" && !("update" in body) && !("execute" in body) && !("AssetType" in body);
/** The query commands of a batch, in order, each with its index in the batch. */
function queriesIn(commands: Command[]): { body: QueryBody; index: number }[] {
  return commands.flatMap((c, index) => { const body = bodyOf(c); return isQuery(body) ? [{ body, index }] : []; });
}

/**
 * The server's results, one slot per query again. It sends a slot for every
 * query that ran (an empty match included) and none for a query that
 * failed; a failure names its command by sourceCommandIndex, so the failed
 * queries are known and the rest fill in order. Null when the counts
 * disagree: the positions cannot be trusted, and the caller decides what
 * that means rather than this guessing.
 */
function realign<T>(sent: { index: number }[], results: T[], failed: Set<number>): (T | null)[] | null {
  const expected = sent.filter((q) => !failed.has(q.index)).length;
  if (results.length !== expected) return null;
  let next = 0;
  return sent.map((q) => (failed.has(q.index) ? null : results[next++]!));
}

/**
 * Send a batch. The response is the envelope; per-command failures are
 * inside it (failuresOf reads them), or thrown as a CommandFailureError with
 * throwOnFailure. Query rows are translated, each by its query's type when a
 * schema is given.
 */
export async function send<Row extends Asset = Asset>(transport: Transport, commands: Command[], options: SendOptions = {}): Promise<AssetApiResponse<Row>> {
  const response = await transport.request<AssetApiResponse<Row>>({
    method: "POST",
    path: "/api/asset",
    query: options.previewOnly ? { previewOnly: "true" } : undefined,
    body: toWire(commands),
    responseType: "json",
    idempotent: options.idempotent === true
  });
  // A preview answers with the projection, not an envelope.
  if (options.previewOnly) return response;
  const queries = queriesIn(commands);
  const failures = failuresOf(response);
  const failed = new Set(failures.flatMap((f) => (f.index === null ? [] : [f.index])));
  const results = response.queryResult?.results ?? [];
  let aligned = realign(queries, results, failed);
  if (!aligned) {
    // A failure without a sourceCommandIndex may be one of the queries, so
    // no row can be placed with confidence: every slot is null, never a
    // misplaced row, and the failures themselves are the answer (thrown
    // with throwOnFailure, as every read asks). With no such failure, the
    // server's answer is inconsistent, and that is an error of its own.
    if (!failures.some((f) => f.index === null)) throw new ApiError(`api/asset returned ${results.length} query results for ${queries.filter((q) => !failed.has(q.index)).length} queries that did not fail; cannot tell which result belongs to which query`, 200, "BAD_RESPONSE", response);
    aligned = queries.map(() => null);
  }
  const contextOf = (i: number): RowContext | undefined => {
    const type = options.lookup ? fromTypeOf(queries[i]!.body.from, commands) : null;
    return type ? { lookup: options.lookup!, type } : undefined;
  };
  const translated: AssetApiResponse<Row> = { ...response, queryResult: { ...response.queryResult, results: aligned!.map((rows, i) => rows && rows.map((r) => fromWireRow<Row>(r as Record<string, unknown>, contextOf(i)))) } };
  if (options.throwOnFailure && translated.commandFailures?.count) throw new CommandFailureError(translated);
  return translated;
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
export async function query<Row extends Asset = Asset>(transport: Transport, q: QueryBody, options: ReadOptions = {}): Promise<Row[]> {
  const [rows] = await queries<Row>(transport, [q], options);
  return rows ?? [];
}

/**
 * One page of a query, with the total number of matches (api/asset reports
 * it when asked with needTotal; `total` is null when it does not) and
 * whether more pages follow.
 */
export async function queryPage<Row extends Asset = Asset>(transport: Transport, q: QueryBody, options: ReadOptions = {}): Promise<{ rows: Row[]; total: number | null; more: boolean }> {
  if (!q.page) throw new UsageError(`query of ${q.from} without a page: every api/asset read must be bounded`);
  const response = await send<Row>(transport, [{ ...q, needTotal: true }], { ...options, throwOnFailure: true });
  const rows = response.queryResult.results[0] ?? [];
  const reported = (response.queryResult as { resultMetaData?: { total?: unknown }[] }).resultMetaData?.[0]?.total;
  const total = typeof reported === "number" ? reported : null;
  return { rows, total, more: total === null ? rows.length === q.page.size : q.page.start + rows.length < total };
}

/**
 * Several queries in one request; one array of rows per query, in order, []
 * where a query matched nothing. A query the server rejected (a bad select
 * token, a malformed filter) throws a CommandFailureError rather than
 * reading as [] — a failure must never look like an empty result.
 */
export async function queries<Row extends Asset = Asset>(transport: Transport, qs: QueryBody[], options: ReadOptions = {}): Promise<Row[][]> {
  for (const q of qs) if (!q.page) throw new UsageError(`query of ${q.from} without a page: every api/asset read must be bounded`);
  const response = await send<Row>(transport, qs, { ...options, throwOnFailure: true });
  return qs.map((_, i) => response.queryResult.results[i] ?? []);
}

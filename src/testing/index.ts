/**
 * `@versionone/agility-sdk/testing`: a client for a consumer's unit tests.
 *
 * A FakeAgilityClient is a real AgilityApiClient — every check the client
 * makes before a request (a page on every read, a well-formed OID) still
 * runs, and every service still composes its requests — over a transport
 * that sends nothing and answers from what the test scripted. It is
 * scripted in the model's shape, the shape the client hands a consumer:
 * rows with numbers as numbers and a relation as a Ref, OIDs for a write.
 * What it does not do is behave like the server: it evaluates no filter,
 * sort or `where`, applies no write, and translates nothing. A test
 * asserts on what was asked (`asked`, `sent`, `requests`) and scripts
 * what comes back; whether the server would answer that way is what an
 * integration test against an instance is for.
 */
import { AgilityApiClient } from "../client";

export { CONFORMANCE_BASE_URL, fetchFrom, transportConformance } from "./transportConformance";
export type { ConformanceCheck, ConformanceRequest, ConformanceResponse, ConformanceServer } from "./transportConformance";
import type { ClientConfig } from "../core/clientConfig";
import { ApiError, UsageError, apiErrorFromResponse } from "../core/errors";
import type { RequestOptions, Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import { isOidToken, momentless, typeOfOid } from "../types/oid";
import type { Command, CommandBody, QueryBody } from "../wire/assetApi";
import type { MetamodelDocument } from "../wire/meta";

export type { MetamodelDocument } from "../wire/meta";

/** A scripted row: an OID and whatever the code under test selects, in the model's shape. */
export type FakeRow = Asset & { [attribute: string]: unknown };

/** What a scripted query answers: the rows, or the rows with the total a paged read reports. */
export type FakeRows = readonly FakeRow[] | { rows: readonly FakeRow[]; total?: number | null };

/** What a scripted write answers; anything left out is empty. `failures` are by index in the batch as sent. */
export interface FakeOutcome {
  created?: Oid[];
  modified?: Oid[];
  operated?: Oid[];
  failures?: { index: number; message: string }[];
}

type QueryAnswer = FakeRows | Error | ((q: QueryBody) => FakeRows);
type SendAnswer = FakeOutcome | Error | ((commands: Command[]) => FakeOutcome);
type RequestAnswer = unknown | ((request: RequestOptions) => unknown);
type QueryMatch = string | ((q: QueryBody) => boolean);
type RequestMatch = string | RegExp | ((request: RequestOptions) => boolean);

const bodyOf = (command: Command): CommandBody => {
  const keys = Object.keys(command);
  return (keys.length === 1 && keys[0]!.startsWith("@") ? (command as Record<string, unknown>)[keys[0]!] : command) as CommandBody;
};
const isQuery = (body: CommandBody): body is QueryBody => typeof (body as QueryBody).from === "string" && !("update" in body) && !("execute" in body) && !("AssetType" in body);
const typeOfFrom = (from: string): string => (isOidToken(from) ? typeOfOid(from) ?? from : from);

type ListMatch = string | ((type: string, params: Record<string, string | undefined>) => boolean);

interface Script {
  lists: { match: ListMatch; answer: FakeRows | Error | ((type: string, params: Record<string, string | undefined>) => FakeRows) }[];
  metamodel: FakeOptions["metamodel"] | null;
  queries: { match: QueryMatch; answer: QueryAnswer }[];
  sends: SendAnswer[];
  requests: { match: RequestMatch; answer: RequestAnswer }[];
  labels: Record<string, string>;
  seen: { requests: RequestOptions[]; asked: QueryBody[]; sent: Command[][] };
  nextId: number;
  /** The fake's versions: each asset's moment (1 until something writes it), and the assets that are gone. */
  moments: Map<Oid, number>;
  gone: Set<Oid>;
  /** Assets the fake itself created or wrote: they exist without a scripted row. */
  known: Set<Oid>;
}

const momentOf = (script: Script, oid: Oid): number => script.moments.get(oid) ?? 1;
const bump = (script: Script, oid: Oid): void => { script.moments.set(oid, momentOf(script, oid) + 1); script.known.add(oid); };
/** A readable time that moves with the moment, for `ChangeDate`. */
const changedAt = (moment: number): string => `2026-01-01T00:00:${String(moment % 60).padStart(2, "0")}.${String(moment).padStart(3, "0")}`;
/** Does the fake's instance have this asset: a row was scripted for it, or the fake created or wrote it, and nobody removed it. */
const exists = (script: Script, oid: Oid): boolean => !script.gone.has(oid) && (script.known.has(oid) || scriptedRows(script).some((row) => momentless(row._oid) === oid));

/** The SDK's own lookup of assets by OID (stamps, a batch's snapshot, names, states): `filter: ["ID=$oids"]`. */
const isOidLookup = (q: QueryBody): boolean => q.filter?.length === 1 && q.filter[0] === "ID=$oids" && Array.isArray(q.with?.$oids);
/** A command the guard wrote: one asset at one moment, while that version is current. */
const guardedOn = (body: CommandBody): { oid: Oid; moment: string } | null => {
  const b = body as { where?: Record<string, unknown>; filter?: string[]; with?: Record<string, unknown> };
  return b.where?.ID === "$oid" && b.where?.Moment === "$moment" && b.filter?.includes("RetireDateUTC=''") ? { oid: momentless(String(b.with?.$oid)), moment: String(b.with?.$moment) } : null;
};

/** The rows of an OID lookup: each asked asset that exists, with what was selected of its scripted row, its Moment and its ChangeDate. */
function lookupByOid(script: Script, q: QueryBody): Asset[] {
  const rows = scriptedRows(script);
  return (q.with!.$oids as string[]).map(momentless).filter((oid) => exists(script, oid)).map((oid) => {
    const scripted = rows.find((row) => momentless(row._oid) === oid) ?? { _oid: oid };
    const out: Record<string, unknown> = { _oid: oid };
    for (const entry of q.select ?? []) {
      const key = typeof entry === "string" ? entry : entry.from;
      if (key === "Moment") out.Moment = String(momentOf(script, oid));
      else if (key === "ChangeDate") out.ChangeDate = changedAt(momentOf(script, oid));
      else if (scripted[key] !== undefined) out[key] = scripted[key];
    }
    return out as unknown as Asset;
  });
}

/** The scripted rows for one query, and the total a paged read would report. */
const hitFor = (script: Script, q: QueryBody, type: string) =>
  // The answer scripted last wins, so a test can override what a shared setup scripted.
  [...script.queries].reverse().find(({ match }) => (typeof match === "function" ? match(q) : match === q.from || match === type));

/** Every row scripted as a list, whatever its type: what a lookup by Number searches. */
const scriptedRows = (script: Script): FakeRow[] =>
  script.queries.flatMap(({ answer }) => (Array.isArray(answer) ? answer : answer && typeof answer === "object" && !(answer instanceof Error) && "rows" in answer ? [...(answer as { rows: readonly FakeRow[] }).rows] : []) as FakeRow[]);

/** The resolver's question: one query per number root, each `Number=$numbers`. */
const isNumberLookup = (q: QueryBody): boolean => q.filter?.length === 1 && q.filter[0] === "Number=$numbers" && Array.isArray(q.with?.$numbers);

/** The scripted rows for one query, and the total a paged read would report. `created` is the asset an alias `from` ("@story") names: the create earlier in the same batch. */
function answerQuery(script: Script, q: QueryBody, created?: { type: string; oid: Oid | undefined; sent: Record<string, unknown> }): { rows: Asset[]; total: number | null } {
  script.seen.asked.push(q);
  const type = created?.type ?? typeOfFrom(q.from);
  const hit = hitFor(script, q, type);
  // A lookup by OID is answered from what the fake knows of each asset, unless a function was scripted for it.
  if (!created && isOidLookup(q) && typeof hit?.answer !== "function" && !(hit?.answer instanceof Error)) { const rows = lookupByOid(script, q); return { rows, total: rows.length }; }
  if (!hit) throw new UsageError(`FakeAgilityClient: no answer scripted for a query of ${q.from}${created ? ` (the ${type} the batch creates)` : ""}; script one with fake.onQuery("${type}", rows)`);
  if (hit.answer instanceof Error) throw hit.answer;
  if (typeof hit.answer === "function") {
    const answered = hit.answer(q);
    return Array.isArray(answered) ? { rows: [...answered], total: null } : { rows: [...(answered as { rows: readonly Asset[] }).rows], total: (answered as { total?: number | null }).total ?? null };
  }
  const scripted = hit.answer as FakeRows;
  if (!Array.isArray(scripted)) { const s = scripted as { rows: readonly Asset[]; total?: number | null }; return { rows: [...s.rows], total: s.total ?? null }; }
  // Rows scripted as a list are the whole result: a read by OID gets the row
  // with that OID, and a page gets its slice, so `get` and `pages` end as
  // they would against a server.
  // A read-back of the batch's own create: the first scripted row of its type stands in for what the server
  // would add (a Number, defaults), the scalar values the create sent win over it (a relation, sent as an
  // OID token or an alias, is not a row's Ref and is left to the script), and the OID is the created one.
  if (created) {
    const sent = Object.fromEntries(Object.entries(created.sent).filter(([k, v]) => k !== "AssetType" && (v === null || typeof v !== "object") && !isOidToken(v) && !(typeof v === "string" && v.startsWith("@"))));
    return { rows: created.oid ? [{ ...(scripted[0] ?? {}), ...sent, _oid: created.oid }] : [], total: created.oid ? 1 : 0 };
  }
  const all = isOidToken(q.from) ? scripted.filter((row) => momentless(row._oid) === momentless(q.from)) : [...scripted];
  const page = q.page ?? { size: all.length, start: 0 };
  // A row that was not scripted with a Moment or ChangeDate gets the fake's own when the query selects them: what a guard will compare.
  const wants = (key: string) => (q.select ?? []).includes(key);
  const versioned = (row: FakeRow): FakeRow => {
    const moment = momentOf(script, momentless(row._oid));
    return { ...row, ...(wants("Moment") && row.Moment === undefined ? { Moment: String(moment) } : {}), ...(wants("ChangeDate") && row.ChangeDate === undefined ? { ChangeDate: changedAt(moment) } : {}) };
  };
  return { rows: all.slice(page.start, page.start + page.size).filter((row) => !script.gone.has(momentless(row._oid))).map(versioned), total: all.length };
}

/** What a batch's writes answer: the scripted outcome, or one made up from the commands (a new OID per create, the addressed OID for an update or an operation). */
function answerSend(script: Script, commands: Command[], writes: { body: CommandBody; index: number }[]): Required<FakeOutcome> {
  script.seen.sent.push(commands);
  const answer = script.sends[script.sends.length - 1];
  if (answer instanceof Error) throw answer;
  if (answer) return { created: [], modified: [], operated: [], failures: [], ...(typeof answer === "function" ? answer(commands) : answer) };
  const out: Required<FakeOutcome> = { created: [], modified: [], operated: [], failures: [] };
  for (const { body } of writes) {
    const guarded = guardedOn(body);
    // A guarded command applies only to an asset that exists, at the moment it was guarded on; anything else matches
    // nothing. A plain one applies to whatever its OID names, unless the test removed that asset.
    const target = guarded ? (exists(script, guarded.oid) && String(momentOf(script, guarded.oid)) === guarded.moment ? guarded.oid : null) : "from" in body && isOidToken(body.from) && !script.gone.has(momentless(body.from)) ? momentless(body.from) : null;
    if ("AssetType" in body) { const oid = `${String(body.AssetType)}:${script.nextId++}`; out.created.push(oid); script.known.add(oid); }
    else if (target && "update" in body) { out.modified.push(target); bump(script, target); }
    else if (target && "execute" in body) { out.operated.push(target); bump(script, target); }
  }
  return out;
}

function respond(script: Script, request: RequestOptions): unknown {
  const raw = [...script.requests].reverse().find(({ match }) => (typeof match === "string" ? request.path.startsWith(match) : match instanceof RegExp ? match.test(request.path) : match(request)));
  // A type nothing scripted is a type the fake's instance does not have, so rows are read as scripted. These
  // reads are the client's own schema loading, not something the code under test asked for: they are not recorded.
  if (!raw && request.method === "GET" && request.path.startsWith("/meta.v1/") && script.metamodel) {
    // The fake's instance has the metamodel's types: serve the document, part by part, as meta.v1 does.
    const [type, attribute] = request.path.slice("/meta.v1/".length).split("/").map(decodeURIComponent);
    const found = attribute ? script.metamodel.AssetTypes[type!]?.Attributes[`${type}.${attribute}`] : script.metamodel.AssetTypes[type!];
    if (!found) throw apiErrorFromResponse(404, { error: "Not Found", exceptions: [{ message: `FakeAgilityClient's metamodel has nothing at ${request.path}` }] });
    request.onResponse?.({ status: 200, headers: { get: () => null } });
    return found;
  }
  if (!raw && request.method === "GET" && request.path.startsWith("/meta.v1/")) throw apiErrorFromResponse(404, { error: "Not Found", exceptions: [{ message: `FakeAgilityClient knows no asset type at ${request.path}` }] });
  script.seen.requests.push(request);
  if (raw) {
    if (raw.answer instanceof Error) throw raw.answer;
    return typeof raw.answer === "function" ? (raw.answer as (r: RequestOptions) => unknown)(request) : raw.answer;
  }
  if (request.path.startsWith("/loc-2.v1")) {
    // loc-2 answers a tag it does not know with the tag itself; so does the fake, for every tag onLocalize did not script.
    const encoded = request.method === "GET" ? request.path.slice(request.path.indexOf("?") + 1) : String(request.body);
    return Object.fromEntries((JSON.parse(decodeURIComponent(encoded)) as string[]).map((tag) => [tag, script.labels[tag] ?? tag]));
  }
  if (request.method === "GET" && request.path.startsWith("/rest-1.v1/Data/") && !request.path.slice("/rest-1.v1/Data/".length).includes("/")) {
    const type = decodeURIComponent(request.path.slice("/rest-1.v1/Data/".length));
    const params = (request.query ?? {}) as Record<string, string | undefined>;
    const hit = [...script.lists].reverse().find(({ match }) => (typeof match === "function" ? match(type, params) : match === type));
    if (hit) {
      if (hit.answer instanceof Error) throw hit.answer;
      const answered = typeof hit.answer === "function" ? hit.answer(type, params) : hit.answer;
      const [size, start] = (params.page ?? "").split(",").map(Number) as [number, number];
      // A list is the whole result and is paged here; a function answers one page itself.
      const whole = Array.isArray(answered) && typeof hit.answer !== "function";
      const all = (Array.isArray(answered) ? answered : (answered as { rows: readonly FakeRow[] }).rows) as readonly FakeRow[];
      const rows = whole ? all.slice(start, start + size) : all;
      const total = Array.isArray(answered) ? (whole ? all.length : undefined) : (answered as { total?: number | null }).total ?? undefined;
      return { _type: "Assets", total: params.needTotal === "true" ? total : undefined, pageSize: size, pageStart: start, Assets: rows.map(toAssetDocument) };
    }
  }
  if (request.method === "POST" && request.path === "/query.v1") return (request.body as QueryBody[]).map((q) => answerQuery(script, q).rows);
  if (request.method === "POST" && request.path === "/api/asset" && Array.isArray(request.body)) {
    const commands = request.body as Command[];
    // A preview answers the projection: a write addressed to one asset becomes a per-asset command; creates,
    // queries and aliased writes are echoed, as the server echoes them.
    if (request.query?.previewOnly) return commands.map((c, i) => {
      const body = bodyOf(c) as Record<string, unknown>;
      const aliased = body !== (c as unknown);
      if (aliased || !("update" in body || "execute" in body)) return c;
      if (typeof body.from !== "string" || !isOidToken(body.from)) throw new UsageError(`FakeAgilityClient cannot preview command ${i}: it is scoped by a query (from ${String(body.from)}), and the fake evaluates no filter. Address the assets by OID, or script the preview with fake.onRequest((r) => r.query?.previewOnly === "true", projection)`);
      return { [`@fake-${i}`]: { oid: momentless(body.from), ...("update" in body ? { update: body.update } : { execute: body.execute }) } } as unknown as Command;
    });
    const bodies = commands.map((c, index) => ({ body: bodyOf(c), index, alias: Object.keys(c).length === 1 && Object.keys(c)[0]!.startsWith("@") ? Object.keys(c)[0]! : null }));
    const writes = bodies.filter(({ body }) => !isQuery(body));
    const done = writes.length ? answerSend(script, commands, writes) : { created: [], modified: [], operated: [], failures: [] };
    // The i-th create made the i-th created OID; a query from its alias reads that asset back.
    const creates = writes.filter(({ body }) => "AssetType" in body);
    const createdBy = (from: string) => {
      const i = creates.findIndex(({ alias }) => alias === from);
      return i < 0 ? undefined : { type: String((creates[i]!.body as { AssetType: unknown }).AssetType), oid: done.created[i], sent: creates[i]!.body as Record<string, unknown> };
    };
    const asked = bodies.filter(({ body }) => isQuery(body)).map(({ body }) => body as QueryBody);
    let answers: { rows: Asset[]; total: number | null }[];
    if (asked.length && asked.every(isNumberLookup) && !asked.some((q) => hitFor(script, q, q.from))) {
      // resolve.numbers asks every number root at once; which roots is the SDK's business, so the fake answers
      // from every row a test scripted, by Number, whatever its type. A number no row has is simply not found.
      const wanted = new Set((asked[0]!.with!.$numbers as string[]).map((n) => n.toUpperCase()));
      const found = scriptedRows(script).filter((row) => typeof row.Number === "string" && wanted.has(row.Number.toUpperCase()));
      script.seen.asked.push(...asked);
      answers = asked.map((_, i) => ({ rows: i === 0 ? found : [], total: i === 0 ? found.length : 0 }));
    } else answers = asked.map((q) => answerQuery(script, q, q.from.startsWith("@") ? createdBy(q.from) : undefined));
    const tokens = (oidTokens: Oid[]) => ({ oidTokens, count: oidTokens.length });
    return {
      requestId: `fake-${script.seen.requests.length}`, createdDate: "", completedDate: "", duration: "", durationSeconds: 0, complete: true, processing: false,
      assetsCreated: tokens(done.created), assetsModified: tokens(done.modified), assetsOperatedOn: tokens(done.operated),
      commandFailures: { commands: done.failures.map(({ index, message }) => ({ error: { message, sourceCommandIndex: index } })), count: done.failures.length },
      queryResult: { results: answers.map((a) => a.rows), resultMetaData: answers.map((a) => ({ total: a.total })), count: answers.length }
    };
  }
  throw new UsageError(`FakeAgilityClient: no answer scripted for ${request.method} ${request.path}; script one with fake.onRequest("${request.path}", answer)`);
}

export interface FakeOptions {
  /**
   * Asset types as meta.v1 delivers them, for the fake's instance to have:
   * `{ AssetTypes: { Story: <the document GET /meta.v1/Story answers>, … } }`.
   * Only the types the code under test touches are needed — the ones its
   * queries read from and select through — and those are small; the whole
   * `GET /meta.v1` document (several megabytes) works too, `Version`
   * included or not. With it the fake serves `meta.v1/<Type>` from these,
   * so answers go through the real translation: a response captured from
   * a server, scripted with `onRequest`, reads as it would live ("5"
   * becomes 5, "False" false, a sub-selected single relation one Ref),
   * for the fake and for any client built on `fake.transport`. A type that
   * is not among them does not exist on the fake's instance, and its rows
   * read as sent. Rows scripted in the model's shape still read as
   * scripted. Without this option the instance has no types at all.
   */
  metamodel?: { Version?: string; AssetTypes: MetamodelDocument["AssetTypes"] };
}

/** A model row as rest-1 would send it: what `onList` answers with, so the client's own translation reads it back. */
function toAssetDocument(row: FakeRow): Record<string, unknown> {
  const isRef = (v: unknown): v is { _oid: string } => !!v && typeof v === "object" && typeof (v as { _oid?: unknown })._oid === "string";
  const ref = (r: { _oid: string }) => ({ _type: "Asset", href: "", idref: r._oid });
  const Attributes: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (name === "_oid") continue;
    if (isRef(value)) Attributes[name] = { _type: "Relation", name, value: ref(value) };
    else if (Array.isArray(value) && value.length && value.every(isRef)) Attributes[name] = { _type: "Relation", name, value: value.map(ref) };
    else Attributes[name] = { _type: "Attribute", name, value };
  }
  return { _type: "Asset", href: "", id: row._oid, Attributes };
}

/**
 * An AgilityApiClient that sends nothing: reads answer the rows a test
 * scripted, writes are recorded and answer OIDs, and everything asked is
 * kept for the test to assert on.
 *
 * ```ts
 * import { FakeAgilityClient } from "@versionone/agility-sdk/testing";
 *
 * const fake = new FakeAgilityClient()
 *   .onQuery("Story", [{ _oid: "Story:1", Name: "Logon", Estimate: 2 }]);
 * const rows = await listStories(fake);          // the code under test takes an AgilityApiClient
 * expect(fake.asked[0]).toMatchObject({ from: "Story", filter: ["Scope=$scope"] });
 * ```
 *
 * - `onQuery(match, rows)` answers `query`, `queries`, `get`, `queryPage`,
 *   `pages`, `all` and everything built on them. Rows are in the model's
 *   shape and come back as scripted. A list is the whole result: the fake
 *   pages it, reports its length as the total, and answers a read by OID
 *   with the row of that OID. A function gets the query and answers one
 *   page itself (`onQuery((q) => q.from === "StoryStatus" &&
 *   q.filter?.[0]?.startsWith("Team."), teamStatuses)` tells two queries
 *   of one type apart). No filter, `where` or sort is evaluated. A query nothing
 *   was scripted for throws a UsageError: an unscripted read never looks
 *   like an empty result.
 * - `send` needs no script: each create answers a new OID
 *   (`Story:1000`, `Story:1001`, …), each update or operation addressed by
 *   OID answers that OID. `onSend` scripts anything else (failures by
 *   index, a create's OID).
 * - A query from an alias of a create in the same batch (`from: "@story"`)
 *   answers the first row scripted for the created type, under the OID the
 *   create answered and with the scalar values the create sent. `resolve.numbers` and `resolve.ref` find a number
 *   among every row scripted as a list, by its `Number`; one no row has is
 *   `missing`. `localize` answers each tag with its `onLocalize` label, or
 *   with the tag itself.
 * - `fake.transport` can be the Transport of another client (one your code
 *   builds and wraps): it reads rows as scripted too, because the fake
 *   answers every meta.v1 type read with 404, "no such type".
 * - `sendGuarded` and `batch.run` work on assets addressed by OID that a
 *   row was scripted for: the fake keeps a moment per asset, applies a
 *   guarded command only at that moment, and answers a batch's snapshot,
 *   stamps and read-backs from the scripted rows. `fake.touch(oid)` is
 *   someone else changing the asset (the next guarded write stamped
 *   earlier is a conflict; a receipt's reverse finds it drifted);
 *   `fake.remove(oid)` is it being deleted. `onSend` replaces this
 *   simulation with its own answer. A write scoped by a query cannot be
 *   previewed by the fake (it evaluates no filter): script that preview
 *   with `onRequest`.
 * - `onList(type, rows)` answers `client.data.list` the same way: rows in
 *   the model's shape, a list paged by the fake.
 * - `onRequest(match, answer)` answers any other request by path, in the
 *   endpoint's own shape (attachment bytes, a captured response), and wins
 *   over everything above. With `new FakeAgilityClient({ metamodel })` a
 *   captured query response reads as it would live: translated.
 * - An `Error` as an answer is thrown: `new ApiError("Unauthorized", 401)`,
 *   or `apiErrorFromResponse(status, body)` for a refusal as the fetch
 *   transport words it.
 */
export class FakeAgilityClient extends AgilityApiClient {
  /** Every request the client made, in order, as a Transport sees it (the client's own unscripted meta.v1 type loads left out). */
  readonly requests: RequestOptions[];
  /** Every query asked, in order, whichever read asked it. */
  readonly asked: QueryBody[];
  /** Every batch that carried a write, in order, as sent: a Ref is written as its OID token. */
  readonly sent: Command[][];
  private readonly script: Script;

  constructor(config: Partial<ClientConfig> & FakeOptions = {}) {
    const script: Script = { lists: [], metamodel: config.metamodel ?? null, queries: [], sends: [], requests: [], labels: {}, seen: { requests: [], asked: [], sent: [] }, nextId: 1000, moments: new Map(), gone: new Set(), known: new Set() };
    const transport: Transport = {
      // Answers are computed synchronously and delivered as a real response would be: later, and a throw as a rejection.
      request: async <T>(request: RequestOptions): Promise<T> => {
        if (request.signal?.aborted) throw new ApiError("Request aborted", 0, "ABORTED", { cause: request.signal.reason });
        return respond(script, request) as T;
      }
    };
    // The fake's instance has no asset type (every meta.v1 read answers 404), so rows scripted in the model's shape pass through as written.
    const { metamodel: _metamodel, ...clientConfig } = config;
    // No resends by default: an error a test scripts is seen once, as scripted. Pass `retries` to test a resend.
    super({ baseUrl: "https://agility.example.com/Fake", retries: 0, ...clientConfig }, { transport });
    this.script = script;
    this.requests = script.seen.requests;
    this.asked = script.seen.asked;
    this.sent = script.seen.sent;
  }

  /**
   * Script the answer to queries of an asset type (`"Story"`, which also
   * matches a read by OID of that type), of one OID (`"Story:1"`), or
   * matching a predicate. The answer scripted last wins.
   */
  onQuery(match: QueryMatch, answer: QueryAnswer): this {
    this.script.queries.push({ match, answer });
    return this;
  }

  /** Script what writes answer from here on: an outcome, a function of the batch, or an Error to throw. */
  onSend(answer: SendAnswer): this {
    this.script.sends.push(answer);
    return this;
  }

  /**
   * Script `client.data.list` (rest-1's list read: text search, deleted
   * assets) for an asset type or a predicate over the type and the query
   * string rest-1 is sent (`find`, `where`, `sel`, `deleted`). Rows are in
   * the model's shape, as for `onQuery`: a list is the whole result (the
   * fake pages it and reports its length as the total when asked), a
   * function answers one page. No `find` or filter is evaluated.
   */
  onList(match: ListMatch, answer: FakeRows | Error | ((type: string, params: Record<string, string | undefined>) => FakeRows)): this {
    this.script.lists.push({ match, answer });
    return this;
  }

  /** Script labels for `client.localize`: tag → label. A tag nothing scripted answers itself, as loc-2 answers a tag it does not know. */
  onLocalize(labels: Record<string, string>): this {
    Object.assign(this.script.labels, labels);
    return this;
  }

  /**
   * Someone else changed this asset: its moment moves on, so a guarded
   * write stamped before now is a conflict, and a receipt's reverse finds
   * it drifted.
   */
  touch(oid: Oid): this {
    bump(this.script, momentless(oid));
    return this;
  }

  /** This asset is gone: reads by OID no longer find it, and a write to it matches nothing. */
  remove(oid: Oid): this {
    this.script.gone.add(momentless(oid));
    return this;
  }

  /** Script the answer to any request by path (a prefix, a RegExp, or a predicate), in the endpoint's own shape. Wins over onQuery and onSend. */
  onRequest(match: RequestMatch, answer: RequestAnswer): this {
    this.script.requests.push({ match, answer });
    return this;
  }
}

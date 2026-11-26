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
import type { ClientConfig } from "../core/clientConfig";
import { ApiError, UsageError, apiErrorFromResponse } from "../core/errors";
import type { RequestOptions, Transport } from "../core/transport";
import type { Asset, Oid } from "../types/asset";
import { isOidToken, momentless, typeOfOid } from "../types/oid";
import type { Command, CommandBody, QueryBody } from "../wire/assetApi";

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

interface Script {
  queries: { match: QueryMatch; answer: QueryAnswer }[];
  sends: SendAnswer[];
  requests: { match: RequestMatch; answer: RequestAnswer }[];
  labels: Record<string, string>;
  seen: { requests: RequestOptions[]; asked: QueryBody[]; sent: Command[][] };
  nextId: number;
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
  return { rows: all.slice(page.start, page.start + page.size), total: all.length };
}

/** What a batch's writes answer: the scripted outcome, or one made up from the commands (a new OID per create, the addressed OID for an update or an operation). */
function answerSend(script: Script, commands: Command[], writes: { body: CommandBody; index: number }[]): Required<FakeOutcome> {
  script.seen.sent.push(commands);
  const answer = script.sends[script.sends.length - 1];
  if (answer instanceof Error) throw answer;
  if (answer) return { created: [], modified: [], operated: [], failures: [], ...(typeof answer === "function" ? answer(commands) : answer) };
  const out: Required<FakeOutcome> = { created: [], modified: [], operated: [], failures: [] };
  for (const { body } of writes) {
    if ("AssetType" in body) out.created.push(`${String(body.AssetType)}:${script.nextId++}`);
    else if ("update" in body && isOidToken(body.from)) out.modified.push(momentless(body.from));
    else if ("execute" in body && isOidToken(body.from)) out.operated.push(momentless(body.from));
  }
  return out;
}

function respond(script: Script, request: RequestOptions): unknown {
  const raw = [...script.requests].reverse().find(({ match }) => (typeof match === "string" ? request.path.startsWith(match) : match instanceof RegExp ? match.test(request.path) : match(request)));
  // A type nothing scripted is a type the fake's instance does not have, so rows are read as scripted. These
  // reads are the client's own schema loading, not something the code under test asked for: they are not recorded.
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
  if (request.method === "POST" && request.path === "/query.v1") return (request.body as QueryBody[]).map((q) => answerQuery(script, q).rows);
  if (request.method === "POST" && request.path === "/api/asset" && Array.isArray(request.body)) {
    const commands = request.body as Command[];
    // A preview answers the projection; the fake's is the batch as written.
    if (request.query?.previewOnly) return commands;
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
 * - `onRequest(match, answer)` answers any other request by path, in the
 *   endpoint's own shape (rest-1 behind `client.data`, attachment bytes,
 *   meta.v1), and wins over everything above. Guarded sends and
 *   `batch.run` are not scripted by the fake: their request sequence is
 *   internal to the SDK and changes between alphas, so fake the function
 *   of yours that calls them.
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

  constructor(config: Partial<ClientConfig> = {}) {
    const script: Script = { queries: [], sends: [], requests: [], labels: {}, seen: { requests: [], asked: [], sent: [] }, nextId: 1000 };
    const transport: Transport = {
      // Answers are computed synchronously and delivered as a real response would be: later, and a throw as a rejection.
      request: async <T>(request: RequestOptions): Promise<T> => {
        if (request.signal?.aborted) throw new ApiError("Request aborted", 0, "ABORTED", { cause: request.signal.reason });
        return respond(script, request) as T;
      }
    };
    // The fake's instance has no asset type (every meta.v1 read answers 404), so rows scripted in the model's shape pass through as written.
    super({ baseUrl: "https://agility.example.com/Fake", ...config }, { transport });
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

  /** Script labels for `client.localize`: tag → label. A tag nothing scripted answers itself, as loc-2 answers a tag it does not know. */
  onLocalize(labels: Record<string, string>): this {
    Object.assign(this.script.labels, labels);
    return this;
  }

  /** Script the answer to any request by path (a prefix, a RegExp, or a predicate), in the endpoint's own shape. Wins over onQuery and onSend. */
  onRequest(match: RequestMatch, answer: RequestAnswer): this {
    this.script.requests.push({ match, answer });
    return this;
  }
}

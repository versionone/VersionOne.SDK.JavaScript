import type { ClientConfig } from "./core/clientConfig";
import { ApiError, UsageError } from "./core/errors";
import { createFetchTransport } from "./core/fetchTransport";
import { DEFAULT_TIMEOUT_MS, withErrorHook, withRequestStamp, withRetry, withTimeout, governsItself } from "./core/retry";
import type { Transport } from "./core/transport";
import * as attachments from "./services/attachments";
import * as batch from "./services/batch";
import * as explainService from "./services/explain";
import * as fieldsService from "./services/fields";
import * as listsService from "./services/lists";
import * as guard from "./services/guard";
import * as resolve from "./services/resolve";
import { Schema, type TypeCache } from "./services/schema";
import * as searchService from "./services/search";
import type { Asset, Oid } from "./types/asset";
import type { Attachment } from "./types/assets/Attachment";
import type { Member } from "./types/assets/Member";
import type { From, RowOf, RowsOf, Selected, SelectPath, TypeOf } from "./types/query";
import { isOidToken, momentless } from "./types/oid";
import { isAssetNumber } from "./services/resolve";
import * as assetApi from "./wire/assetApi";
import * as attachment from "./wire/attachment";
import * as fields from "./wire/fields";
import * as loc2 from "./wire/loc2";
import * as meta from "./wire/meta";
import * as queryV1 from "./wire/queryV1";
import * as rest1 from "./wire/rest1";

export interface ClientOptions {
  /** Bring your own transport (a fake in tests, an instrumented one in an app). */
  transport?: Transport;
  /**
   * Share loaded type definitions with other clients of the same instance,
   * whatever their credentials: this client's schema keeps its types in
   * `types` and loads anything missing through this client's transport.
   * A server that builds a client per user keeps one TypeCache per instance.
   * To load nothing at all, seed one from a metamodel document:
   * `TypeCache.fromMetamodel(metamodel)`. Without it, types are loaded from
   * meta.v1 as queries first touch them.
   */
  types?: TypeCache;
}

/** One page of rows, with the total number of matches when the server reports it, and whether more pages follow. */
export interface Page<Row extends { _oid: Oid } = Asset> {
  rows: Row[];
  /** The number of matches across all pages; null when the server did not report one. */
  total: number | null;
  /**
   * Whether more pages follow: what a pager reads. With a total it is exact
   * (`start + rows.length < total`). When `total` is null it is whether
   * this page came back full, the only signal left, so a pager keeps
   * offering "next" on `more` and never on `total`; the page after a full
   * last page is then empty with `more` false.
   */
  more: boolean;
}

export interface PagesOptions {
  /**
   * The most rows to read across all pages: the iteration stops there, and
   * the last page is cut to fit. Default 1000. Every read is bounded; a
   * caller that truly wants everything says how many that is.
   */
  limit?: number;
}

/** What `me` answers: the member the credentials belong to. */
export type Me = Pick<Member, "_oid" | "Name" | "Username" | "Nickname" | "Email">;

const DEFAULT_LIMIT = 1000;

/** Transports a client has already put its resend rule and error hook around. */
const dressed = new WeakSet<Transport>();

/** Every read is bounded: the type says so, and for a caller the type did not reach this says so before any request (not even a schema load) is sent. */
function bounded(qs: readonly assetApi.QueryBody[]): void {
  for (const q of qs) {
    if (!q.page) throw new UsageError(`query of ${q.from} without a page: every read must be bounded`);
    searchable(String(q.from), q.find);
  }
}
/** A text search for nothing: the server answers it with zero rows, which would read as "nothing matches". */
function searchable(from: string, find: string | undefined): void {
  if (find !== undefined && !String(find).trim()) throw new UsageError(`query of ${from} with an empty \`find\`: the server answers a search for nothing with no rows, not all rows; leave \`find\` out to read without searching`);
}
const ME_SELECT = ["Name", "Username", "Nickname", "Email"];

/**
 * The client: one transport, one schema, and the wire modules bound to
 * them. Every read goes through the schema so its rows arrive in the
 * model's shape (numbers as numbers, a single relation as one Ref), and
 * every write answers in the model's terms (an Outcome, never an envelope).
 *
 * Reads: `query`, `queries`, `get`, `queryPage`, `pages`, `all`, `me`. A
 * query body is the same everywhere; the client picks the endpoint.
 * query.v1 answers rows alone — the lightest response, and read-only by
 * construction, so a request can be resent like a GET — but its shape has
 * nowhere to put a total; api/asset reports one (`needTotal`) beside the
 * rows, which is why `queryPage` goes there and `query` does not. rest-1
 * serves what neither does: `search` (text search across types),
 * `deleted`, `history`, `template`, `operate`. Writes: `send`,
 * `sendGuarded`, `batch.run`, `copy`. Services: `resolve`,
 * `fields`, `attachments`, `embeddedImages`, `schema`, `localize`, `urls`.
 */
export class AgilityApiClient {
  readonly transport: Transport;
  readonly schema: Schema;

  constructor(config: ClientConfig, opts: ClientOptions = {}) {
    // The built-in transport times its attempts and resends idempotent requests itself (it can read Retry-After); a
    // custom one gets the same two rules from the client. A transport another client of ours already dressed (withSignal) is taken as it is.
    let transport = opts.transport ?? createFetchTransport({
      baseUrl: config.baseUrl,
      authorization: config.authorization,
      accessToken: config.accessToken,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      defaultHeaders: config.defaultHeaders,
      credentials: config.credentials,
      onUnauthorized: config.onUnauthorized,
      unauthorizedStatuses: config.unauthorizedStatuses,
      fetchImpl: config.fetchImpl
    });
    if (!dressed.has(transport)) {
      // A custom transport: each attempt under the client's deadline, and the resend rule around that. The built-in
      // transport applies both itself, also when it was made by the caller and handed in: wrapping it again would
      // send a failed read four times instead of two.
      if (!governsItself(transport)) transport = withRetry(withTimeout(transport, config.timeoutMs ?? DEFAULT_TIMEOUT_MS), config.retries ?? 1);
      // Every error says what was asked (so an explanation can tell a failed read from a write whose fate is unknown).
      transport = withRequestStamp(transport);
      if (config.onError) transport = withErrorHook(transport, config.onError);
      dressed.add(transport);
    }
    this.transport = transport;
    this.config = config;
    this.schema = new Schema(this.transport, undefined, opts.types);
  }

  private readonly config: ClientConfig;

  /**
   * The same client, with every request it sends tied to `signal`: abort it
   * (on navigation, say) and in-flight requests end with an ApiError coded
   * ABORTED. The loaded types are shared; a type load that other
   * callers are waiting on is not cancelled.
   */
  withSignal(signal: AbortSignal): AgilityApiClient {
    const base = this.transport;
    const transport: Transport = { request: (options) => base.request({ ...options, signal: options.signal ?? signal }) };
    dressed.add(transport); // `base` already resends and reports errors: not twice
    return new AgilityApiClient(this.config, { transport, types: this.schema.cache });
  }

  // ---- reads ------------------------------------------------------------------

  /**
   * One query, its rows, translated. Sent to query.v1: it cannot write, so
   * the request is marked idempotent and the transport resends it once
   * after a network failure or a 5xx (`retries`, default 1). A page is
   * required; a query the server refuses throws an ApiError (kind
   * "invalid", code QUERY_REJECTED; `message` holds the server's
   * sentences, `details` each exception's type and message), never an
   * empty result.
   */
  query<const F extends From, const Q extends assetApi.Query<F>>(q: Q & assetApi.Query<F>): Promise<RowOf<Q>[]>;
  query<Row extends { _oid: Oid } = Asset>(q: assetApi.Query): Promise<Row[]>;
  async query(q: assetApi.Query): Promise<Asset[]> {
    bounded([q]);
    await this.schema.ensureFor([q]);
    return queryV1.query(this.transport, q, { lookup: this.schema });
  }

  /** Several queries in one request; one array of rows per query, in order. */
  queries<const Qs extends readonly assetApi.Query[]>(qs: Qs): Promise<RowsOf<Qs>>;
  queries<Row extends { _oid: Oid } = Asset>(qs: assetApi.Query[]): Promise<Row[][]>;
  async queries(qs: readonly assetApi.Query[]): Promise<Asset[][]> {
    bounded(qs);
    await this.schema.ensureFor(qs);
    return queryV1.queries(this.transport, [...qs], { lookup: this.schema });
  }

  /**
   * One asset by OID token, with the attributes selected, or null when no
   * asset has that OID. (`select` omitted: just the OID, which tells you it
   * exists.)
   */
  get<const O extends string, const S extends readonly (SelectPath<TypeOf<O>> | assetApi.QueryBody)[]>(oid: O, select: S): Promise<Selected<TypeOf<O>, S> | null>;
  get<Row extends { _oid: Oid } = Asset>(oid: Oid, select?: assetApi.QueryBody["select"]): Promise<Row | null>;
  async get(oid: Oid, select?: assetApi.QueryBody["select"]): Promise<Asset | null> {
    const rows = await this.query({ from: momentless(oid), ...(select ? { select } : {}), page: { size: 1, start: 0 } });
    return rows[0] ?? null;
  }

  /**
   * One page with its total: api/asset reports the number of matches when
   * asked (query.v1 does not), so this read goes there. `total` is null
   * when the server did not say; `more` is then whether the page was full.
   */
  queryPage<const F extends From, const Q extends assetApi.Query<F>>(q: Q & assetApi.Query<F>): Promise<Page<RowOf<Q>>>;
  queryPage<Row extends { _oid: Oid } = Asset>(q: assetApi.Query): Promise<Page<Row>>;
  async queryPage(q: assetApi.Query): Promise<Page> {
    bounded([q]);
    await this.schema.ensureFor([q]);
    return assetApi.queryPage(this.transport, q, { lookup: this.schema });
  }

  /**
   * The query page by page, as an async iterator, up to `limit` rows in
   * all (default 1000): `page.start` advances by `page.size` from where the
   * query starts, and the iteration ends at a short page or at the limit.
   * Each page is a plain read on query.v1, so a long walk survives a
   * transient failure like any GET.
   */
  pages<const F extends From, const Q extends assetApi.Query<F>>(q: Q & assetApi.Query<F>, options?: PagesOptions): AsyncGenerator<RowOf<Q>[], void, undefined>;
  pages<Row extends { _oid: Oid } = Asset>(q: assetApi.Query, options?: PagesOptions): AsyncGenerator<Row[], void, undefined>;
  async *pages(q: assetApi.Query, options: PagesOptions = {}): AsyncGenerator<Asset[], void, undefined> {
    bounded([q]);
    const limit = options.limit ?? DEFAULT_LIMIT;
    const size = q.page.size;
    let start = q.page.start, read = 0;
    while (read < limit) {
      const want = Math.min(size, limit - read);
      const rows = await this.query({ ...q, page: { size: want, start } });
      if (rows.length) yield rows;
      read += rows.length;
      start += rows.length;
      if (rows.length < want) return;
    }
  }

  /** Every row of the query up to `limit` (default 1000), read page by page. */
  all<const F extends From, const Q extends assetApi.Query<F>>(q: Q & assetApi.Query<F>, options?: PagesOptions): Promise<RowOf<Q>[]>;
  all<Row extends { _oid: Oid } = Asset>(q: assetApi.Query, options?: PagesOptions): Promise<Row[]>;
  async all(q: assetApi.Query, options: PagesOptions = {}): Promise<Asset[]> {
    const out: Asset[] = [];
    for await (const page of this.pages(q, options)) out.push(...page);
    return out;
  }

  /** The member these credentials belong to (Member.IsSelf, live 2026-11-12): what a comment's Author is. */
  async me(): Promise<Me> {
    const [row] = await this.query<Me>({ from: "Member", select: ME_SELECT, filter: ["IsSelf='true'"], page: { size: 1, start: 0 } });
    if (!row) throw new ApiError("the server knows no member for these credentials", 0, "NOT_FOUND");
    return row;
  }

  // ---- the endpoints behind the reads -----------------------------------------------

  /**
   * meta.v1: the instance's schema, read on request and not cached (the
   * cached view queries use is `schema`; `schema.revalidate()` drops it
   * when the schema's tag moves). What comes back is the model's
   * `Metamodel` / `AssetType` — references as tokens (`Base: "Story"`,
   * `RelatedAsset: "Member"`), operations by name — not meta.v1's own
   * document, which spells them `{ nameref, href }`; for that document,
   * read `/meta.v1` through the transport.
   * `read` and `readType` are conditional: pass the tag a previous answer
   * carried and an unchanged schema answers null without a download —
   * meta.v1 sends one strong ETag for the whole schema. `etag()` reads that
   * tag alone, from the smallest resource.
   */
  readonly meta = {
    metamodel: () => meta.getMetamodel(this.transport),
    read: (options?: meta.ConditionalOptions) => meta.readMetamodel(this.transport, options),
    assetType: (token: string) => meta.getAssetType(this.transport, token),
    readType: (token: string, options?: meta.ConditionalOptions) => meta.readAssetType(this.transport, token, options),
    attributeDefinition: (tokenref: `${string}.${string}`) => meta.getAttributeDefinition(this.transport, tokenref),
    etag: (options?: meta.ConditionalOptions) => meta.etag(this.transport, options)
  };

  /**
   * loc-2.v1: labels for tags, in one request (meta's DisplayName values are
   * tags, and so is a violation's `tag`). An unmatched tag comes back as
   * itself; the server never says "missing", so neither does this.
   */
  localize(tags: readonly string[], options?: loc2.LocalizeOptions): Promise<loc2.Localizations> {
    return loc2.localize(this.transport, tags, options);
  }

  /**
   * An error, said to a person: one Explanation per failed command (from a
   * CommandFailureError, an Outcome or its `failures`), or one for any
   * other error. Each has a short `sentence` — "Project is required.",
   * with the instance's own label for the attribute — and the parts it was
   * made from (`rule`, `attribute`, `attributeLabel`, `typeLabel`, the
   * server's own `localized` sentence where it has one). One loc-2 request
   * at most; a label it cannot get is replaced by the attribute's name,
   * never an error.
   */
  explain(error: unknown, options?: loc2.LocalizeOptions): Promise<explainService.Explanation[]> {
    return explainService.explain(this.transport, error, options);
  }

  /**
   * Text search across asset types: one page of mixed rows in one order,
   * with the total. `types` is required (there is no default set of
   * types). `select` and `findin` take plain attribute names: a row has
   * each selected key under that name, null where its type has no such
   * attribute, so `Number` is simply `row.Number` for a Story and a
   * Request alike. To search within one type or one family of types, an
   * ordinary read with `find` does it: `client.query({ from, find, … })`.
   *
   * The text index trails a write by a few seconds: an asset created a
   * moment ago is found by its Number at once and by its words shortly
   * after.
   */
  async search<Row extends { _oid: Oid } = searchService.SearchRow>(text: string, options: searchService.SearchOptions): Promise<searchService.SearchResult<Row>> {
    return searchService.search<Row>(this.transport, this.schema, text, options);
  }

  /**
   * Deleted assets of a type: one page, each row's `AssetState` saying
   * `"Deleted"`. No other read returns a deleted asset.
   */
  async deleted<Row extends { _oid: Oid } = searchService.SearchRow>(type: string, params: Omit<rest1.ReadParams, "deleted">): Promise<searchService.SearchResult<Row>> {
    searchable(type, params.find);
    await this.schema.ensureFor([{ from: type, select: params.select }]);
    const { rows, total, more } = await rest1.list<Row & Asset>(this.transport, type, { ...params, filter: [...(params.filter ?? []), "IsDeleted='true'"], deleted: true, needTotal: params.needTotal ?? true }, { lookup: this.schema });
    return { rows, total, more };
  }

  /**
   * An asset's history: one row per version, newest paging as asked, each
   * row's `_oid` carrying its moment (`Story:1234:5678`). `target` is an
   * OID token, or an asset type for the history of every asset of it.
   */
  async history<Row extends Asset = Asset>(target: string, params: rest1.ReadParams): Promise<rest1.ReadResult<Row>> {
    await this.schema.ensureFor([{ from: target.split(":")[0]!, select: params.select }]);
    return rest1.history<Row>(this.transport, target, params, { lookup: this.schema });
  }

  /**
   * A new asset's template: what the type's initializer would fill in for
   * a context (a Timebox's next name and dates in a schedule's scope, a
   * Story's carry-over from a Request). Nothing is created.
   */
  async template<F extends From>(type: F, options?: { ctx?: Oid }): Promise<rest1.Template<TypeOf<F>>> {
    await this.schema.load(type);
    return rest1.template<TypeOf<F>>(this.transport, type, { ...options, lookup: this.schema });
  }

  /**
   * Run an operation for its result: the asset the server answered with
   * and its new moment. `send` with an `execute` performs the same
   * operations but does not say what a Copy made; this does. Never resent.
   */
  operate(oid: Oid, op: string): Promise<rest1.OperationResult> {
    return rest1.operate(this.transport, oid, op);
  }

  /** Copy an asset (the server's Copy operation) and answer the copy's OID. */
  async copy(oid: Oid): Promise<Oid> {
    return (await rest1.operate(this.transport, oid, "Copy")).oid;
  }

  /**
   * What a form needs for an asset type in a scope: the attributes the
   * server requires to create one (meta), the ones the product shows there
   * (api/visibleFields, custom fields included once configured), and the
   * scope's scheme's important fields and whether they are enforced at
   * close. `visible` alone answers for several types and scopes at once.
   */
  readonly fields = {
    describe: (type: From, scope: Oid) => fieldsService.describe(this.transport, this.schema, type, scope),
    visible: (types: readonly From[], scopes: readonly Oid[]) => fields.visibleFields(this.transport, types, scopes),
    visibleByAsset: (oid: Oid) => fields.visibleFieldsByAsset(this.transport, oid)
  };

  /**
   * Which values a list-typed attribute (Status, Priority, a custom
   * dropdown) may take: for an existing asset (`{ asset }`: its own scope
   * and team apply, a team with its own process included) or for one not
   * created yet (`{ type, scope, team? }`). The scope's scheme and the
   * team's process decide, as in the product's own pickers; the server
   * itself enforces less on a write (it accepts a status outside the
   * scope's scheme), so resolve a name here before writing it.
   * `values` answers a map from attribute to rows `{ _oid, Name }` in the
   * list's order, one request per attribute; `value` answers the one
   * value a name (or an OID) means there, or throws NO_SUCH_VALUE /
   * AMBIGUOUS_VALUE with the candidates as rows in `details.values`.
   * Only relations to a list type: the endpoint cannot be paged, so for
   * Owners, Team or Timebox use `client.query` on the related type with a
   * filter and a page.
   */
  readonly lists = {
    values: (input: listsService.ValuesInput) => listsService.values(this.transport, this.schema, input),
    value: (input: listsService.ValueInput) => listsService.value(this.transport, this.schema, input)
  };

  // ---- writes -----------------------------------------------------------------------

  /**
   * Send a batch (api/asset). The Outcome says what it did — created,
   * modified and operated OIDs, failures by index (each with its parsed
   * violation), query rows per query command — and never the envelope.
   * The server commits per command and answers 200 either way, so a
   * failed command is in `failures`, or thrown as a CommandFailureError
   * with `throwOnFailure` (the error carries the same Outcome). A command
   * addressed to one asset by OID that did nothing and reported nothing
   * (the asset is gone) is in `unmatched`: the server calls that a
   * success. Not guarded: it writes
   * whatever is there now. `sendGuarded` is the
   * compare-and-set.
   */
  async send<Row extends Asset = Asset>(commands: assetApi.Command[], options?: Omit<assetApi.SendOptions, "lookup" | "previewOnly">): Promise<assetApi.Outcome<Row>> {
    await this.schema.ensureFor(commands);
    const outcome = assetApi.outcomeOf(await assetApi.send<Row>(this.transport, commands, { ...options, lookup: this.schema }));
    outcome.unmatched = assetApi.unmatchedOf(commands, outcome);
    return outcome;
  }

  /** The server's projection of a batch: one command per asset it would touch, nothing applied. */
  preview(commands: assetApi.Command[]): Promise<assetApi.Command[]> {
    return assetApi.preview(this.transport, commands);
  }

  /**
   * Send as a compare-and-set: each asset is changed only if nobody has
   * changed it since it was read. The result is a plain send's Outcome
   * plus `conflicts`: the assets whose command matched nothing, because
   * someone changed them (or they are gone); nothing was applied to those.
   * By default the moment is read just before the send; pass `moments`
   * to guard on the version a person saw earlier (select `Moment` with the
   * row you show, keep it, pass it here). With `throwOnFailure` a failed
   * command throws a CommandFailureError and a conflict a ConflictError
   * (kind "conflict"). Throws UnguardableError, before any write, for
   * shapes it cannot cover. What it cannot see: a change that makes no new
   * version of the asset, such as a child added to it.
   */
  async sendGuarded<Row extends Asset = Asset>(commands: assetApi.Command[], options?: Omit<guard.GuardedOptions, "lookup">): Promise<guard.GuardedResult<Row>> {
    await this.schema.ensureFor(commands);
    return guard.sendGuarded<Row>(this.transport, commands, { ...options, lookup: this.schema });
  }

  /**
   * Services: what a person types, turned into assets, each answered as a
   * row (`_oid`, `AssetType`, `Number`, `Name`, `AssetState`). Numbers
   * resolve in one api/asset request across every number root; `ref`
   * takes an OID token as given, without a request; `refs` reads a mixed
   * list.
   */
  readonly resolve = {
    numbers: (numbers: readonly string[]) => resolve.resolveNumbers(this.transport, numbers, { types: this.schema.cache }),
    ref: (spec: string) => resolve.resolveRef(this.transport, spec, { types: this.schema.cache }),
    /** Numbers and OID tokens mixed, each one read (Number, Name, AssetState where its type has them): two requests at most. */
    refs: (specs: readonly string[]) => resolve.resolveRefs(this.transport, this.schema, specs, { types: this.schema.cache })
  };

  /**
   * A batch with a record: preview, snapshot what it overwrites, (confirm,)
   * send — guarded or not, as `guard` says; it has no default — and a
   * receipt with the created, touched and conflicting assets and a reverse
   * batch. `reversible` drops from a receipt's reverse the assets changed
   * since, unless forced.
   */
  readonly batch = {
    run: (commands: assetApi.Command[], options: batch.BatchOptions) => batch.runBatch(this.transport, this.schema, commands, options),
    reversible: (receipt: batch.ReversibleReceipt, options?: { force?: boolean }) => batch.reversible(this.transport, receipt, options)
  };

  /**
   * The files attached to assets: metadata on Attachment assets, bytes
   * through attachment.img. `add` sends a small file inline (one request)
   * and a large one in two steps; `get` reads a small one inline on request.
   */
  readonly attachments = {
    /** One page of an asset's attachments, newest first, metadata only; `select` adds keys to each row. */
    list: <const S extends readonly (SelectPath<Attachment> | assetApi.QueryBody)[] | undefined = undefined>(asset: string, options?: Omit<attachments.ListOptions<S>, "schema">) => attachments.list<S>(this.transport, asset, { ...options, schema: this.schema }),
    /** The same page with the total and whether more follow. */
    page: <const S extends readonly (SelectPath<Attachment> | assetApi.QueryBody)[] | undefined = undefined>(asset: string, options?: Omit<attachments.ListOptions<S>, "schema">) => attachments.page<S>(this.transport, asset, { ...options, schema: this.schema }),
    info: (id: string | number) => attachments.info(this.transport, id),
    /** Metadata and bytes: two requests, or one with `{ inline: true }` (for small files; the content rides in the row as Base64). */
    get: (id: string | number, options?: attachments.GetOptions) => attachments.get(this.transport, id, options),
    add: (asset: string, data: attachment.Bytes, options: attachments.AddOptions) => attachments.add(this.transport, asset, data, options),
    put: (id: string | number, data: attachment.Bytes, contentType?: string) => attachments.put(this.transport, id, data, contentType),
    remove: (id: string | number) => attachments.remove(this.transport, id)
  };

  /**
   * Images embedded in an asset's rich text (Description and other long
   * text). `upload` returns the URL to put in an <img src>; `normalize`
   * rewrites every embedded.img reference in some HTML to this instance's
   * absolute URL, as Agility's own editor stores it. They cannot be deleted.
   */
  readonly embeddedImages = {
    upload: (asset: string, data: attachment.Bytes, options?: { filename?: string; contentType?: string }) => attachment.uploadEmbeddedImage(this.transport, asset, data, options),
    normalize: (html: string) => attachment.normalizeEmbeddedImageUrls(html, this.config.baseUrl)
  };

  /** Where a browser opens things on this instance: an asset's page, an attachment's bytes, an embedded image. */
  readonly urls = {
    /**
     * The asset's page, from an OID token or an asset Number (S-01001,
     * what a person typed and what a message shows): assetdetail.v1
     * resolves either and redirects to the type's own detail page; a signed-
     * out reader lands there after logging in. Anything else is a UsageError.
     */
    asset: (ref: Oid | string) => {
      const base = this.config.baseUrl.replace(/\/+$/, "");
      const text = ref.trim();
      if (isOidToken(text)) return `${base}/assetdetail.v1?oid=${momentless(text)}`;
      if (isAssetNumber(text)) return `${base}/assetdetail.v1?Number=${encodeURIComponent(text)}`;
      throw new UsageError(`"${ref}" is neither an OID token (Story:1234) nor an asset number (S-1234)`);
    },
    /** Where a browser opens or downloads an attachment's bytes, from its OID token (Attachment:5678) or its numeric id. */
    attachment: (id: string | number) => attachment.attachmentUrl(this.config.baseUrl, id),
    /** Where an embedded image is served from, from its OID token (EmbeddedImage:5678) or its numeric id. */
    embeddedImage: (id: string | number) => attachment.embeddedImageUrl(this.config.baseUrl, id)
  };
}

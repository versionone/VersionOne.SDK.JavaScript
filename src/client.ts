import type { ClientConfig } from "./core/clientConfig";
import { ApiError, UsageError } from "./core/errors";
import { createFetchTransport } from "./core/fetchTransport";
import type { Transport } from "./core/transport";
import * as attachments from "./services/attachments";
import * as batch from "./services/batch";
import * as fieldsService from "./services/fields";
import * as guard from "./services/guard";
import * as resolve from "./services/resolve";
import { Schema, type TypeCache } from "./services/schema";
import type { Asset, Oid } from "./types/asset";
import type { Member } from "./types/assets/Member";
import type { Metamodel } from "./types/metamodel";
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
   * Seed the schema so no type is fetched: a metamodel document as
   * meta.getMetamodel returns it, or the committed metamodel.json run
   * through meta.toMetamodel. Without it, types are loaded from meta.v1 as
   * queries first touch them.
   */
  metamodel?: Metamodel;
  /** Share an existing schema (and its cache) instead of starting a new one. */
  schema?: Schema;
  /**
   * Share loaded type definitions with other clients of the same instance,
   * whatever their credentials: this client's schema keeps its types in
   * `types` and loads anything missing through this client's transport.
   * A server that builds a client per user keeps one TypeCache per instance.
   */
  types?: TypeCache;
}

/** One page of rows, with the total number of matches when the server reports it, and whether more pages follow. */
export interface Page<Row extends Asset = Asset> { rows: Row[]; total: number | null; more: boolean }

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
 * sits behind `data` for what neither does: deleted assets, history, a
 * new asset's template, an operation's result. Writes: `assets.send`,
 * `assets.sendGuarded`, `batch.run`, `copy`. Services: `resolve`,
 * `fields`, `attachments`, `embeddedImages`, `schema`, `localize`, `urls`.
 */
export class AgilityApiClient {
  readonly transport: Transport;
  readonly schema: Schema;

  constructor(config: ClientConfig, options: ClientOptions | Transport = {}) {
    // A bare Transport as the second argument is the older spelling; keep it working.
    const opts: ClientOptions = "request" in options ? { transport: options } : options;
    this.transport = opts.transport ?? createFetchTransport({
      baseUrl: config.baseUrl,
      authorization: config.authorization,
      accessToken: config.accessToken,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      defaultHeaders: config.defaultHeaders,
      credentials: config.credentials,
      onUnauthorized: config.onUnauthorized,
      unauthorizedStatuses: config.unauthorizedStatuses
    });
    this.config = config;
    this.schema = opts.schema ?? new Schema(this.transport, opts.metamodel, opts.types);
  }

  private readonly config: ClientConfig;

  /**
   * The same client, with every request it sends tied to `signal`: abort it
   * (on navigation, say) and in-flight requests end with an ApiError coded
   * ABORTED. The schema and its cache are shared; a type load that other
   * callers are waiting on is not cancelled.
   */
  withSignal(signal: AbortSignal): AgilityApiClient {
    const base = this.transport;
    const transport: Transport = { request: (options) => base.request({ ...options, signal: options.signal ?? signal }) };
    return new AgilityApiClient(this.config, { transport, schema: this.schema });
  }

  // ---- reads ------------------------------------------------------------------

  /**
   * One query, its rows, translated. Sent to query.v1: it cannot write, so
   * the request is marked idempotent and the transport may resend it after
   * a network failure or a 5xx — when `retries` is set above its default
   * of 0. A page is required; a query the server refuses throws an
   * ApiError (kind "invalid", code QUERY_REJECTED; `message` holds the
   * server's sentences, `details` its whole error document), never an
   * empty result.
   */
  query<const F extends From, const Q extends assetApi.QueryBody<F>>(q: Q & assetApi.QueryBody<F>): Promise<RowOf<Q>[]>;
  query<Row extends Asset = Asset>(q: assetApi.QueryBody): Promise<Row[]>;
  async query(q: assetApi.QueryBody): Promise<Asset[]> {
    await this.schema.ensureFor([q]);
    return queryV1.query(this.transport, q, { lookup: this.schema });
  }

  /** Several queries in one request; one array of rows per query, in order. */
  queries<const Qs extends readonly assetApi.QueryBody[]>(qs: Qs): Promise<RowsOf<Qs>>;
  queries<Row extends Asset = Asset>(qs: assetApi.QueryBody[]): Promise<Row[][]>;
  async queries(qs: readonly assetApi.QueryBody[]): Promise<Asset[][]> {
    await this.schema.ensureFor(qs);
    return queryV1.queries(this.transport, [...qs], { lookup: this.schema });
  }

  /**
   * One asset by OID token, with the attributes selected, or null when no
   * asset has that OID. (`select` omitted: just the OID, which tells you it
   * exists.)
   */
  get<const O extends string, const S extends readonly (SelectPath<TypeOf<O>> | assetApi.QueryBody)[]>(oid: O, select: S): Promise<Selected<TypeOf<O>, S> | null>;
  get<Row extends Asset = Asset>(oid: Oid, select?: assetApi.QueryBody["select"]): Promise<Row | null>;
  async get(oid: Oid, select?: assetApi.QueryBody["select"]): Promise<Asset | null> {
    const rows = await this.query({ from: momentless(oid), ...(select ? { select } : {}), page: { size: 1, start: 0 } });
    return rows[0] ?? null;
  }

  /**
   * One page with its total: api/asset reports the number of matches when
   * asked (query.v1 does not), so this read goes there. `total` is null
   * when the server did not say; `more` is then whether the page was full.
   */
  queryPage<const F extends From, const Q extends assetApi.QueryBody<F>>(q: Q & assetApi.QueryBody<F>): Promise<Page<RowOf<Q>>>;
  queryPage<Row extends Asset = Asset>(q: assetApi.QueryBody): Promise<Page<Row>>;
  async queryPage(q: assetApi.QueryBody): Promise<Page> {
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
  pages<const F extends From, const Q extends assetApi.QueryBody<F>>(q: Q & assetApi.QueryBody<F>, options?: PagesOptions): AsyncGenerator<RowOf<Q>[], void, undefined>;
  pages<Row extends Asset = Asset>(q: assetApi.QueryBody, options?: PagesOptions): AsyncGenerator<Row[], void, undefined>;
  async *pages(q: assetApi.QueryBody, options: PagesOptions = {}): AsyncGenerator<Asset[], void, undefined> {
    if (!q.page) throw new UsageError(`query of ${q.from} without a page: every read must be bounded`);
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
  all<const F extends From, const Q extends assetApi.QueryBody<F>>(q: Q & assetApi.QueryBody<F>, options?: PagesOptions): Promise<RowOf<Q>[]>;
  all<Row extends Asset = Asset>(q: assetApi.QueryBody, options?: PagesOptions): Promise<Row[]>;
  async all(q: assetApi.QueryBody, options: PagesOptions = {}): Promise<Asset[]> {
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
   * meta.v1: the instance's schema, raw. (The translated, cached view is
   * `schema`; `schema.revalidate()` drops it when the schema's tag moves.)
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
   * rest-1.v1, for what the other endpoints cannot do: deleted assets
   * (`deleted: true`), one asset by OID without a page, history (one row
   * per moment), a new asset's template (`template`: what the type's
   * initializer fills in for a context — a Timebox's next name and dates,
   * a Story's carry-over from a Request), and an operation's result
   * (`operate`: api/asset performs a Copy but never says what it made;
   * rest-1 answers the new OID). Parameters are spelled as a query's
   * (`select`, `filter`).
   */
  readonly data = {
    list: <Row extends Asset = Asset>(type: string, params: rest1.ReadParams) => rest1.list<Row>(this.transport, type, params),
    get: <Row extends Asset = Asset>(oid: string, select?: string[]) => rest1.get<Row>(this.transport, oid, select),
    history: <Row extends Asset = Asset>(target: string, params: rest1.ReadParams) => rest1.history<Row>(this.transport, target, params),
    template: <F extends From>(type: F, options?: { ctx?: Oid }) => rest1.template<TypeOf<F>>(this.transport, type, options),
    operate: (oid: Oid, op: string) => rest1.operate(this.transport, oid, op)
  };

  /** Copy an asset (the server's Copy operation) and answer the copy's OID: the one thing api/asset's `execute: "Copy"` does not say. */
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

  /** @deprecated since 1.0.0-alpha.3: use `client.query` / `client.queries` (the same endpoint, query.v1; only the name moved). Removed in 1.0.0. */
  readonly queryV1 = {
    query: <Row extends Asset = Asset>(q: assetApi.QueryBody) => this.query<Row>(q),
    queries: <Row extends Asset = Asset>(qs: assetApi.QueryBody[]) => this.queries<Row>(qs)
  };

  // ---- writes -----------------------------------------------------------------------

  /** api/asset: batches, answered in the model's terms. */
  readonly assets = {
    /**
     * Send a batch. The Outcome says what it did — created, modified and
     * operated OIDs, failures by index (each with its parsed violation),
     * query rows per query command — and never the envelope. api/asset
     * commits per command and answers 200 either way, so a failed command
     * is in `failures`, or thrown as a CommandFailureError with
     * `throwOnFailure` (the error carries the same Outcome).
     */
    send: async <Row extends Asset = Asset>(commands: assetApi.Command[], options?: Omit<assetApi.SendOptions, "lookup" | "previewOnly">): Promise<assetApi.Outcome<Row>> => {
      await this.schema.ensureFor(commands);
      return assetApi.outcomeOf(await assetApi.send<Row>(this.transport, commands, { ...options, lookup: this.schema }));
    },
    /** The server's projection of a batch: one command per asset it would touch, nothing applied. */
    preview: (commands: assetApi.Command[]) => assetApi.preview(this.transport, commands),
    /**
     * Send as a compare-and-set: each asset is changed only if nobody has
     * changed it since the preview read it; the rest come back `skipped`.
     * Throws UnguardableError, before any request, for shapes it cannot
     * cover.
     */
    sendGuarded: async <Row extends Asset = Asset>(commands: assetApi.Command[], options?: Pick<assetApi.SendOptions, "throwOnFailure">) => {
      await this.schema.ensureFor(commands);
      return guard.sendGuarded<Row>(this.transport, commands, { ...options, lookup: this.schema });
    },
    /** @deprecated since 1.0.0-alpha.3: use `client.query` (rows, through query.v1) or `client.queryPage` (rows and a total, through api/asset as this does). Removed in 1.0.0. */
    query: async <Row extends Asset = Asset>(q: assetApi.QueryBody) => {
      await this.schema.ensureFor([q]);
      return assetApi.query<Row>(this.transport, q, { lookup: this.schema });
    },
    /** @deprecated since 1.0.0-alpha.3: use `client.queries`. Removed in 1.0.0. */
    queries: async <Row extends Asset = Asset>(qs: assetApi.QueryBody[]) => {
      await this.schema.ensureFor(qs);
      return assetApi.queries<Row>(this.transport, qs, { lookup: this.schema });
    }
  };

  /**
   * Services: what a person types, turned into assets. Numbers resolve in
   * one api/asset request across every number root; an OID token is taken
   * as is.
   */
  readonly resolve = {
    numbers: (numbers: readonly string[]) => resolve.resolveNumbers(this.transport, numbers, { types: this.schema.cache }),
    ref: (spec: string) => resolve.resolveRef(this.transport, spec, { types: this.schema.cache })
  };

  /**
   * A batch with a record: preview, snapshot what it overwrites, (confirm,)
   * send guarded, and a receipt with created/touched/skipped assets and a
   * reverse batch. `reversible` drops from a receipt's reverse the assets
   * changed since, unless forced.
   */
  readonly batch = {
    run: (commands: assetApi.Command[], options?: batch.BatchOptions) => batch.runBatch(this.transport, this.schema, commands, options),
    reversible: (receipt: Pick<batch.Receipt, "reverse" | "after">, options?: { force?: boolean }) => batch.reversible(this.transport, receipt, options)
  };

  /**
   * The files attached to assets: metadata on Attachment assets, bytes
   * through attachment.img. `add` sends a small file inline (one request)
   * and a large one in two steps.
   */
  readonly attachments = {
    list: (asset: string, options?: { page?: { size: number; start: number } }) => attachments.list(this.transport, asset, options),
    page: (asset: string, options?: { page?: { size: number; start: number } }) => attachments.page(this.transport, asset, options),
    info: (id: string | number) => attachments.info(this.transport, id),
    get: (id: string | number) => attachments.get(this.transport, id),
    add: (asset: string, data: attachment.Bytes, options: attachments.AddOptions) => attachments.add(this.transport, asset, data, options),
    put: (id: string | number, data: attachment.Bytes, contentType?: string) => attachments.put(this.transport, id, data, contentType),
    remove: (id: string | number) => attachments.remove(this.transport, id),
    /** @deprecated since 1.0.0-alpha.3: `client.urls.attachment`. Removed in 1.0.0. */
    url: (id: string | number) => this.urls.attachment(id)
  };

  /**
   * Images embedded in an asset's rich text (Description and other long
   * text). `upload` returns the URL to put in an <img src>; `normalize`
   * rewrites every embedded.img reference in some HTML to this instance's
   * absolute URL, as Agility's own editor stores it. They cannot be deleted.
   */
  readonly embeddedImages = {
    upload: (asset: string, data: attachment.Bytes, options?: { filename?: string; contentType?: string }) => attachment.uploadEmbeddedImage(this.transport, asset, data, options),
    /** @deprecated since 1.0.0-alpha.3: `client.urls.embeddedImage`. Removed in 1.0.0. */
    url: (id: string | number) => this.urls.embeddedImage(id),
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

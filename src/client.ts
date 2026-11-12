import type { ClientConfig } from "./core/clientConfig";
import { ApiError, UsageError } from "./core/errors";
import { createFetchTransport } from "./core/fetchTransport";
import type { Transport } from "./core/transport";
import * as attachments from "./services/attachments";
import * as batch from "./services/batch";
import * as guard from "./services/guard";
import * as resolve from "./services/resolve";
import { Schema, type TypeCache } from "./services/schema";
import type { Asset, Oid } from "./types/asset";
import type { Member } from "./types/assets/Member";
import type { Metamodel } from "./types/metamodel";
import { momentless } from "./types/oid";
import * as assetApi from "./wire/assetApi";
import * as attachment from "./wire/attachment";
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
 * query body is the same everywhere; the client picks the endpoint
 * (query.v1 for plain reads — read-only by construction, so a request can
 * be retried like a GET; api/asset where a total is wanted; rest-1 behind
 * `data` for deleted assets and history). Writes: `assets.send`,
 * `assets.sendGuarded`, `batch.run`. Services: `resolve`, `attachments`,
 * `embeddedImages`, `schema`, `localize`, `urls`.
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
   * the request is retried like a GET after a network failure or a 5xx. A
   * page is required; a query the server refuses throws (kind "invalid"),
   * never an empty result.
   */
  async query<Row extends Asset = Asset>(q: assetApi.QueryBody): Promise<Row[]> {
    await this.schema.ensureFor([q]);
    return queryV1.query<Row>(this.transport, q, { lookup: this.schema });
  }

  /** Several queries in one request; one array of rows per query, in order. */
  async queries<Row extends Asset = Asset>(qs: assetApi.QueryBody[]): Promise<Row[][]> {
    await this.schema.ensureFor(qs);
    return queryV1.queries<Row>(this.transport, qs, { lookup: this.schema });
  }

  /**
   * One asset by OID token, with the attributes selected, or null when no
   * asset has that OID. (`select` omitted: just the OID, which tells you it
   * exists.)
   */
  async get<Row extends Asset = Asset>(oid: Oid, select?: assetApi.QueryBody["select"]): Promise<Row | null> {
    const rows = await this.query<Row>({ from: momentless(oid), ...(select ? { select } : {}), page: { size: 1, start: 0 } });
    return rows[0] ?? null;
  }

  /**
   * One page with its total: api/asset reports the number of matches when
   * asked (query.v1 does not), so this read goes there. `total` is null
   * when the server did not say; `more` is then whether the page was full.
   */
  async queryPage<Row extends Asset = Asset>(q: assetApi.QueryBody): Promise<Page<Row>> {
    await this.schema.ensureFor([q]);
    return assetApi.queryPage<Row>(this.transport, q, { lookup: this.schema });
  }

  /**
   * The query page by page, as an async iterator, up to `limit` rows in
   * all (default 1000): `page.start` advances by `page.size` from where the
   * query starts, and the iteration ends at a short page or at the limit.
   * Each page is a plain read on query.v1, so a long walk survives a
   * transient failure like any GET.
   */
  async *pages<Row extends Asset = Asset>(q: assetApi.QueryBody, options: PagesOptions = {}): AsyncGenerator<Row[], void, undefined> {
    if (!q.page) throw new UsageError(`query of ${q.from} without a page: every read must be bounded`);
    const limit = options.limit ?? DEFAULT_LIMIT;
    const size = q.page.size;
    let start = q.page.start, read = 0;
    while (read < limit) {
      const want = Math.min(size, limit - read);
      const rows = await this.query<Row>({ ...q, page: { size: want, start } });
      if (rows.length) yield rows;
      read += rows.length;
      start += rows.length;
      if (rows.length < want) return;
    }
  }

  /** Every row of the query up to `limit` (default 1000), read page by page. */
  async all<Row extends Asset = Asset>(q: assetApi.QueryBody, options: PagesOptions = {}): Promise<Row[]> {
    const out: Row[] = [];
    for await (const page of this.pages<Row>(q, options)) out.push(...page);
    return out;
  }

  /** The member these credentials belong to (Member.IsSelf, live 2026-11-12): what a comment's Author is. */
  async me(): Promise<Me> {
    const [row] = await this.query<Me>({ from: "Member", select: ME_SELECT, filter: ["IsSelf='true'"], page: { size: 1, start: 0 } });
    if (!row) throw new ApiError("the server knows no member for these credentials", 0, "NOT_FOUND");
    return row;
  }

  // ---- the endpoints behind the reads -----------------------------------------------

  /** meta.v1: the instance's schema, raw. (The translated, cached view is `schema`.) */
  readonly meta = {
    metamodel: () => meta.getMetamodel(this.transport),
    assetType: (token: string) => meta.getAssetType(this.transport, token),
    attributeDefinition: (tokenref: `${string}.${string}`) => meta.getAttributeDefinition(this.transport, tokenref)
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
   * rest-1.v1, for what query.v1 cannot do: deleted assets (`deleted:
   * true`), one asset by OID without a page, and history (one row per
   * moment). Parameters are spelled as a query's (`select`, `filter`).
   */
  readonly data = {
    list: <Row extends Asset = Asset>(type: string, params: rest1.ReadParams) => rest1.list<Row>(this.transport, type, params),
    get: <Row extends Asset = Asset>(oid: string, select?: string[]) => rest1.get<Row>(this.transport, oid, select),
    history: <Row extends Asset = Asset>(target: string, params: rest1.ReadParams) => rest1.history<Row>(this.transport, target, params)
  };

  /** @deprecated since 1.0.0-alpha.3: `client.query` / `client.queries` read through query.v1. Removed in 1.0.0. */
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
    /** @deprecated since 1.0.0-alpha.3: use `client.query` (or `client.queryPage` for a total). Removed in 1.0.0. */
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
    /** The asset's page: assetdetail.v1 redirects to the type's own detail page (live 2026-11-12). */
    asset: (oid: Oid) => `${this.config.baseUrl.replace(/\/+$/, "")}/assetdetail.v1?oid=${momentless(oid)}`,
    attachment: (id: string | number) => attachment.attachmentUrl(this.config.baseUrl, id),
    embeddedImage: (id: string | number) => attachment.embeddedImageUrl(this.config.baseUrl, id)
  };
}

import type { ClientConfig } from "./core/clientConfig";
import { createFetchTransport } from "./core/fetchTransport";
import type { Transport } from "./core/transport";
import * as attachments from "./services/attachments";
import * as batch from "./services/batch";
import * as guard from "./services/guard";
import * as resolve from "./services/resolve";
import { Schema, type TypeCache } from "./services/schema";
import type { Asset } from "./types/asset";
import type { Metamodel } from "./types/metamodel";
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

/**
 * The client: one transport, one schema, and the wire modules bound to
 * them. Every api/asset read goes through the schema so its rows arrive in
 * the model's shape (numbers as numbers, a single relation as one Ref).
 * Services ported from gh-v1 are exposed here the same way: resolve, the
 * guard (assets.sendGuarded), batch.
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

  /** meta.v1: the instance's schema, raw. (The translated, cached view is `schema`.) */
  readonly meta = {
    metamodel: () => meta.getMetamodel(this.transport),
    assetType: (token: string) => meta.getAssetType(this.transport, token),
    attributeDefinition: (tokenref: `${string}.${string}`) => meta.getAttributeDefinition(this.transport, tokenref)
  };

  /**
   * loc-2.v1: labels for tags, in one request (meta's DisplayName values are
   * tags). An unmatched tag comes back as itself; the server never says
   * "missing", so neither does this.
   */
  localize(tags: readonly string[], options?: loc2.LocalizeOptions): Promise<loc2.Localizations> {
    return loc2.localize(this.transport, tags, options);
  }

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
   * and a large one in two steps; `url` is where a browser opens one.
   */
  readonly attachments = {
    list: (asset: string, options?: { page?: { size: number; start: number } }) => attachments.list(this.transport, asset, options),
    info: (id: string | number) => attachments.info(this.transport, id),
    get: (id: string | number) => attachments.get(this.transport, id),
    add: (asset: string, data: attachment.Bytes, options: attachments.AddOptions) => attachments.add(this.transport, asset, data, options),
    put: (id: string | number, data: attachment.Bytes, contentType?: string) => attachments.put(this.transport, id, data, contentType),
    remove: (id: string | number) => attachments.remove(this.transport, id),
    url: (id: string | number) => attachment.attachmentUrl(this.config.baseUrl, id)
  };

  /**
   * Images embedded in an asset's rich text (Description and other long
   * text). `upload` returns the URL to put in an <img src>; `normalize`
   * rewrites every embedded.img reference in some HTML to this instance's
   * absolute URL, as Agility's own editor stores it. They cannot be deleted.
   */
  readonly embeddedImages = {
    upload: (asset: string, data: attachment.Bytes, options?: { filename?: string; contentType?: string }) => attachment.uploadEmbeddedImage(this.transport, asset, data, options),
    url: (id: string | number) => attachment.embeddedImageUrl(this.config.baseUrl, id),
    normalize: (html: string) => attachment.normalizeEmbeddedImageUrls(html, this.config.baseUrl)
  };

  /** rest-1.v1: bounded reads, one asset, history. */
  readonly data = {
    list: <Row extends Asset = Asset>(type: string, params: rest1.ReadParams) => rest1.list<Row>(this.transport, type, params),
    get: <Row extends Asset = Asset>(oid: string, sel?: string[]) => rest1.get<Row>(this.transport, oid, sel),
    history: <Row extends Asset = Asset>(target: string, params: rest1.ReadParams) => rest1.history<Row>(this.transport, target, params)
  };

  /**
   * query.v1: reads only, the same query bodies as assets.query, rows
   * translated the same way. The endpoint cannot write, so it is the safe
   * place to explore a query; its requests may be retried like a GET.
   */
  readonly queryV1 = {
    query: async <Row extends Asset = Asset>(q: assetApi.QueryBody) => {
      await this.schema.ensureFor([q]);
      return queryV1.query<Row>(this.transport, q, { lookup: this.schema });
    },
    queries: async <Row extends Asset = Asset>(qs: assetApi.QueryBody[]) => {
      await this.schema.ensureFor(qs);
      return queryV1.queries<Row>(this.transport, qs, { lookup: this.schema });
    }
  };

  /** api/asset: batches and queries, rows translated through the schema. */
  readonly assets = {
    send: async <Row extends Asset = Asset>(commands: assetApi.Command[], options?: Omit<assetApi.SendOptions, "lookup">) => {
      await this.schema.ensureFor(commands);
      return assetApi.send<Row>(this.transport, commands, { ...options, lookup: this.schema });
    },
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
    query: async <Row extends Asset = Asset>(q: assetApi.QueryBody) => {
      await this.schema.ensureFor([q]);
      return assetApi.query<Row>(this.transport, q, { lookup: this.schema });
    },
    queries: async <Row extends Asset = Asset>(qs: assetApi.QueryBody[]) => {
      await this.schema.ensureFor(qs);
      return assetApi.queries<Row>(this.transport, qs, { lookup: this.schema });
    }
  };
}

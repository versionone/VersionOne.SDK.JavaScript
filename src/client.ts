import type { ClientConfig } from "./core/clientConfig";
import { createFetchTransport } from "./core/fetchTransport";
import type { Transport } from "./core/transport";
import { Schema } from "./services/schema";
import type { Asset } from "./types/asset";
import type { Metamodel } from "./types/metamodel";
import * as assetApi from "./wire/assetApi";
import * as meta from "./wire/meta";
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
}

/**
 * The client: one transport, one schema, and the wire modules bound to
 * them. Every api/asset read goes through the schema so its rows arrive in
 * the model's shape (numbers as numbers, a single relation as one Ref).
 * Services (resolve, guard, batch) arrive as the port from gh-v1 lands and
 * are exposed here the same way.
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
      defaultHeaders: config.defaultHeaders
    });
    this.schema = new Schema(this.transport, opts.metamodel);
  }

  /** meta.v1: the instance's schema, raw. (The translated, cached view is `schema`.) */
  readonly meta = {
    metamodel: () => meta.getMetamodel(this.transport),
    assetType: (token: string) => meta.getAssetType(this.transport, token),
    attributeDefinition: (tokenref: `${string}.${string}`) => meta.getAttributeDefinition(this.transport, tokenref)
  };

  /** rest-1.v1: bounded reads, one asset, history. */
  readonly data = {
    list: <Row extends Asset = Asset>(type: string, params: rest1.ReadParams) => rest1.list<Row>(this.transport, type, params),
    get: <Row extends Asset = Asset>(oid: string, sel?: string[]) => rest1.get<Row>(this.transport, oid, sel),
    history: <Row extends Asset = Asset>(target: string, params: rest1.ReadParams) => rest1.history<Row>(this.transport, target, params)
  };

  /** api/asset: batches and queries, rows translated through the schema. */
  readonly assets = {
    send: async <Row extends Asset = Asset>(commands: assetApi.Command[], options?: Omit<assetApi.SendOptions, "lookup">) => {
      await this.schema.ensureFor(commands);
      return assetApi.send<Row>(this.transport, commands, { ...options, lookup: this.schema });
    },
    preview: (commands: assetApi.Command[]) => assetApi.preview(this.transport, commands),
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

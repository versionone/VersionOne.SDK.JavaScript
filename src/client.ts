import type { ClientConfig } from "./core/clientConfig";
import { createFetchTransport } from "./core/fetchTransport";
import type { Transport } from "./core/transport";
import type { Asset } from "./types/asset";
import * as assetApi from "./wire/assetApi";
import * as meta from "./wire/meta";

/**
 * The client: one transport, and the wire modules bound to it. Services
 * (resolve, guard, batch) arrive as the port from gh-v1 lands and are
 * exposed here the same way.
 */
export class AgilityApiClient {
  readonly transport: Transport;

  constructor(config: ClientConfig, transport?: Transport) {
    this.transport = transport ?? createFetchTransport({
      baseUrl: config.baseUrl,
      authorization: config.authorization,
      accessToken: config.accessToken,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      defaultHeaders: config.defaultHeaders
    });
  }

  /** meta.v1: the instance's schema. */
  readonly meta = {
    metamodel: () => meta.getMetamodel(this.transport),
    assetType: (token: string) => meta.getAssetType(this.transport, token),
    attributeDefinition: (tokenref: `${string}.${string}`) => meta.getAttributeDefinition(this.transport, tokenref)
  };

  /** api/asset: batches and queries. */
  readonly assets = {
    send: <Row extends Asset = Asset>(commands: assetApi.Command[], options?: assetApi.SendOptions) => assetApi.send<Row>(this.transport, commands, options),
    preview: (commands: assetApi.Command[]) => assetApi.preview(this.transport, commands),
    query: <Row extends Asset = Asset>(q: assetApi.QueryBody) => assetApi.query<Row>(this.transport, q),
    queries: <Row extends Asset = Asset>(qs: assetApi.QueryBody[]) => assetApi.queries<Row>(this.transport, qs)
  };
}

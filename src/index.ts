export { AgilityApiClient } from "./client";
export { ApiError } from "./core/errors";
export { createFetchTransport } from "./core/fetchTransport";
export type { ClientConfig } from "./core/clientConfig";
export type { RequestBody, RequestOptions, ResponseType, Transport } from "./core/transport";

// The model: what things are.
export type { Asset, AttributeValue, CustomAttributes, DateString, Oid, Ref, AssetStateValue } from "./types/asset";
export type { AssetType, AttributeDefinition, AttributeType, AttributeTokenRef, AssetTypeToken, Metamodel } from "./types/metamodel";
export type * from "./types/assets/index";

// The wire layer: one module per endpoint.
export { assetApi } from "./wire";
export * as meta from "./wire/meta";
export type { AssetApiResponse, Command, CommandBody, CommandValue, CreateBody, ExecuteBody, QueryBody, UpdateBody } from "./wire/assetApi";

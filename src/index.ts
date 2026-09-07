export { AgilityApiClient } from "./client";
export type { ClientOptions } from "./client";
export { ApiError } from "./core/errors";
export { createFetchTransport } from "./core/fetchTransport";
export type { ClientConfig } from "./core/clientConfig";
export type { RequestBody, RequestOptions, ResponseType, Transport } from "./core/transport";

// The model: what things are.
export type { Asset, AttributeValue, CustomAttributes, DateString, Oid, Ref, AssetStateValue } from "./types/asset";
export { ASSET_STATE_CODES } from "./types/asset";
export { isOidToken, momentless, parseOid, toOid, typeOfOid } from "./types/oid";
export type { OidParts } from "./types/oid";
export type { AssetType, AttributeDefinition, AttributeLookup, AttributeType, AttributeTokenRef, AssetTypeToken, Metamodel } from "./types/metamodel";
export type * from "./types/assets/index";

// The wire layer: one module per endpoint.
export { assetApi, rest1, meta } from "./wire";
export * as select from "./wire/select";
export type { AssetApiResponse, Command, CommandBody, CommandValue, CreateBody, ExecuteBody, QueryBody, UpdateBody, ReadOptions, RowContext, SendOptions } from "./wire/assetApi";
export type { AssetDocument, AssetsDocument, ReadParams, ReadResult } from "./wire/rest1";

// Services: what to do.
export { Schema } from "./services/schema";

/**
 * The wire layer: one module per endpoint, each knowing exactly what its
 * endpoint takes and returns and translating to and from the model. The
 * model (src/types) never learns an envelope; a caller never converts.
 */
export * as assetApi from "./assetApi";
export * as rest1 from "./rest1";
export * as meta from "./meta";
export * as loc2 from "./loc2";
export * as queryV1 from "./queryV1";
export * as attachment from "./attachment";
export * as select from "./select";
export * as fields from "./fields";
export type { AssetDocument, AssetsDocument, ReadParams, ReadResult } from "./rest1";
export type { AssetApiResponse, Command, CommandBody, CommandValue, CreateBody, ExecuteBody, QueryBody, UpdateBody, CommandFailure, CommandError, OidTokens, SendOptions } from "./assetApi";
export type { Localizations, LocalizeOptions } from "./loc2";

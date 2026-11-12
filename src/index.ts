export { AgilityApiClient } from "./client";
export type { ClientOptions, Me, Page, PagesOptions } from "./client";
export { ApiError, UsageError, WrappedError, kindOf } from "./core/errors";
export type { ErrorKind } from "./core/errors";
export { createFetchTransport } from "./core/fetchTransport";
export type { FetchTransportConfig, UnauthorizedContext, UnauthorizedDecision } from "./core/fetchTransport";
export type { ClientConfig } from "./core/clientConfig";
export type { RequestBody, RequestOptions, ResponseType, Transport } from "./core/transport";

// The model: what things are.
export type { Asset, AttributeValue, CustomAttributes, DateString, Oid, Ref, AssetStateValue } from "./types/asset";
export { ASSET_STATE_CODES, assetStateOf } from "./types/asset";
export { isOidToken, momentless, parseOid, toOid, typeOfOid } from "./types/oid";
export type { OidParts } from "./types/oid";
export type { AssetType, AttributeDefinition, AttributeLookup, AttributeType, AttributeTokenRef, AssetTypeToken, Metamodel } from "./types/metamodel";
export type * from "./types/assets/index";
export type { CreateType, From, RowOf, RowsOf, SelectKey, SelectPath, SelectValue, Selected, TypeOf } from "./types/query";

// The wire layer: one module per endpoint.
export { assetApi, rest1, meta, loc2, queryV1, attachment } from "./wire";
export type { Bytes, EmbeddedImage } from "./wire/attachment";
export * as select from "./wire/select";
export type { AssetApiResponse, Command, CommandBody, CommandFailureDetail, Outcome, CommandValue, CreateBody, ExecuteBody, QueryBody, UpdateBody, ReadOptions, RowContext, SendOptions } from "./wire/assetApi";
export { CommandFailureError, parseViolation } from "./wire/assetApi";
export type { Violation } from "./wire/assetApi";
export type { AssetDocument, AssetsDocument, ReadParams, ReadResult } from "./wire/rest1";
export type { Localizations, LocalizeOptions } from "./wire/loc2";

// Services: what to do.
export { Schema, TypeCache } from "./services/schema";
export { AttachmentUploadError, INLINE_LIMIT } from "./services/attachments";
export type { AddOptions as AttachmentAddOptions, AttachmentInfo } from "./services/attachments";
export { CHUNK as RESOLVE_CHUNK, NUMBER_ROOTS, isAssetNumber, resolveNumbers, resolveRef } from "./services/resolve";
export type { Resolution, ResolvedAsset } from "./services/resolve";
export { UNGUARDABLE_TYPES, UnguardableError, guard, sendGuarded, stampsOf, touchedBy, unguardable } from "./services/guard";
export type { GuardedResult, Unguardable } from "./services/guard";
export { BatchRecordError, BatchSendError, INVERSE, describe as describeBatch, namesOf, reverseOf, reversible, runBatch, snapshot } from "./services/batch";
export type { BatchOptions, Described, NameLookupFailure, Named, Receipt, Reverse } from "./services/batch";

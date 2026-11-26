export { AgilityApiClient } from "./client";
export type { ClientOptions, Me, Page, PagesOptions } from "./client";
export { ApiError, UsageError, WrappedError, apiErrorFromResponse, kindOf } from "./core/errors";
export type { ErrorKind } from "./core/errors";
export { createFetchTransport } from "./core/fetchTransport";
export type { FetchTransportConfig, UnauthorizedContext, UnauthorizedDecision } from "./core/fetchTransport";
export type { ClientConfig } from "./core/clientConfig";
export type { RequestBody, RequestOptions, ResponseType, Transport } from "./core/transport";

// The model: what things are.
export type { Asset, AttributeValue, CustomAttributes, DateString, Oid, Ref, AssetStateValue } from "./types/asset";
export { ASSET_STATE_CODES, assetStateKind, assetStateOf } from "./types/asset";
export { isOidToken, momentless, parseOid, toOid, typeOfOid } from "./types/oid";
export type { OidParts } from "./types/oid";
export type { AssetType, AttributeDefinition, AttributeLookup, AttributeType, AttributeTokenRef, AssetTypeToken, Metamodel } from "./types/metamodel";
export type * from "./types/assets/index";
export type { CreateType, CustomList, From, RowOf, RowsOf, SelectKey, SelectPath, SelectValue, Selected, TypeOf } from "./types/query";

// What a caller writes and what a batch answers (src/types/command.ts).
export type { Alias, Command, CommandBody, CommandFailureDetail, CommandValue, CreateBody, ExecuteBody, Outcome, Query, QueryBody, UpdateBody, Violation } from "./types/command";
export { parseViolation } from "./types/command";
export { CommandFailureError } from "./wire/assetApi";
export type { SendOptions } from "./wire/assetApi";
export { normalizeQuery } from "./wire/rest1";
export type { LooseQuery, OperationResult, ReadParams, ReadResult, Template } from "./wire/rest1";
export type { Bytes, EmbeddedImage } from "./wire/attachment";
export type { Localizations, LocalizeOptions } from "./wire/loc2";
export type { ConditionalOptions, Tagged } from "./wire/meta";
export type { QueryRejection } from "./wire/queryV1";
export type { FieldsOf } from "./services/fields";
export { importantName } from "./services/fields";
// The wire modules themselves (assetApi, queryV1, rest1, meta, loc2, attachment, fields, select) and the
// endpoints' envelope types are at "@versionone/agility-sdk/wire".

// Services: their errors, the types of what they answer, and the few pure helpers a client user reaches for.
// The services themselves, as free functions over a Transport, are at "@versionone/agility-sdk/services".
export { TypeCache } from "./services/schema";
export type { Schema } from "./services/schema";
export { AttachmentUploadError, INLINE_LIMIT } from "./services/attachments";
export type { AddOptions as AttachmentAddOptions, AttachmentFile, AttachmentInfo, GetOptions as AttachmentGetOptions, ListOptions as AttachmentListOptions, ListedAttachment } from "./services/attachments";
export { fromBase64, toBase64 } from "./wire/attachment";
export type { Explanation } from "./services/explain";
export { isAssetNumber } from "./services/resolve";
export type { Resolution, ResolvedAsset } from "./services/resolve";
export { ConflictError, GuardedPassError, UnguardableError, unguardable } from "./services/guard";
export type { GuardedOptions, GuardedResult, Unguardable, UnguardableCode } from "./services/guard";
export { BatchRecordError, BatchSendError, ReceiptVersionError, isReceipt } from "./services/batch";
export type { BatchOptions, Described, Drifted, NameLookupFailure, Named, Receipt, Reverse, ReversibleReceipt } from "./services/batch";

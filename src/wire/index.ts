/**
 * The wire layer: one module per endpoint, each knowing exactly what its
 * endpoint takes and returns and translating to and from the model. The
 * model (src/types) never learns an envelope; a caller never converts.
 */
export * as assetApi from "./assetApi";
export type { AssetApiResponse, Command, CommandBody, CommandValue, CreateBody, ExecuteBody, QueryBody, UpdateBody, CommandFailure, CommandError, OidTokens, SendOptions } from "./assetApi";

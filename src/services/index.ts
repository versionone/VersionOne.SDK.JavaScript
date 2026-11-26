/**
 * The services as free functions over a Transport, one namespace per
 * module: what the client's methods are built from. The client is the way
 * in for almost everyone; this path is for a caller that composes a
 * service differently (its own preview step, a schema it manages itself).
 * Their request sequences are internal: they may change between releases
 * in ways the client's methods do not.
 */
export * as attachments from "./attachments";
export * as batch from "./batch";
export * as explain from "./explain";
export * as fields from "./fields";
export * as guard from "./guard";
export * as lists from "./lists";
export * as resolve from "./resolve";
export * as schema from "./schema";
export * as search from "./search";

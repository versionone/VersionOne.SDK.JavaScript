/**
 * The vocabulary of a batch: the commands a caller writes (a query, a
 * create, an update, an operation) and what a batch did, in the model's
 * terms. One shape whichever endpoint carries it (spec 000 section 2):
 * query.v1 and api/asset take the same query, and a write's answer is an
 * Outcome, never an endpoint's envelope. The wire modules translate.
 */
import type { Asset, Oid, Ref } from "./asset";
import type { AttributeTokenRef } from "./metamodel";
import type { CreateType, From, SelectPath, TypeOf } from "./query";

// ---- what a caller writes -----------------------------------------------------

/** A value in a command as the MODEL writes it: scalars, Refs, lists of either, or a nested command. */
export type CommandValue = string | number | boolean | null | Ref | CommandValue[] | { [key: string]: CommandValue };

export interface CreateBody { AssetType: CreateType; [attribute: string]: CommandValue }
/**
 * A query. Written with a literal `from`, `select` completes from that
 * type's attributes and the rows come back typed by what was selected
 * (src/types/query.ts); written from variables, it is what it always was.
 */
export interface QueryBody<F extends string = string> {
  from: F | From;
  select?: (SelectPath<TypeOf<F>> | QueryBody)[];
  filter?: string[];
  where?: Record<string, string>;
  with?: Record<string, CommandValue>;
  sort?: string[];
  page?: { size: number; start: number };
  find?: string;
  findin?: string[];
  asof?: string;
  /** Group the rows by a relation: each result row is then a group, its rows under `_children` (translated like any row of `from`). */
  group?: (string | { from: string; [key: string]: unknown })[];
}
/**
 * A query as a read takes it: a QueryBody with its page. Every read is
 * bounded, and the type says so, so an unpaged read does not compile. (A
 * sub-select inside `select` is a plain QueryBody: it has no page.)
 */
export type Query<F extends string = string> = QueryBody<F> & { page: { size: number; start: number } };

/**
 * An update. Each key of `update` is an attribute; its value replaces a
 * scalar or a single relation (null clears it). A multi-value relation is
 * changed with `{ add: [...], remove: [...] }`. A plain list does NOT
 * replace a multi-value relation: the server ADDS its members, like rest-1's
 * `act: "add"` (seen live on the API-testing instance, 2026-11-07). To set one exactly,
 * remove what should go and add what should come. A change comment goes in
 * the update node as `ChangeComment`.
 */
export interface UpdateBody { from: From; filter?: string[]; where?: Record<string, string>; with?: Record<string, CommandValue>; update: Record<string, CommandValue> }
/**
 * An operation (QuickClose, Inactivate, Reactivate, Delete, …), optionally
 * with arguments. It cannot carry a change comment. Agility refuses to
 * Delete a closed asset (Violation'AssetCannotDeleteClosed): Reactivate it
 * first, as batch.reversible does.
 */
export interface ExecuteBody { from: From; filter?: string[]; where?: Record<string, string>; with?: Record<string, CommandValue>; execute: string | { op: string; args?: Record<string, CommandValue>; list?: Record<string, CommandValue>[] } }
export type CommandBody = CreateBody | QueryBody | UpdateBody | ExecuteBody;

/** An alias key: "@story". */
export type Alias = `@${string}`;
/** A command as sent: aliased ({ "@x": body }) or bare (the body itself). */
export type Command = { [alias: Alias]: CommandBody } | CommandBody;

// ---- what comes back -----------------------------------------------------------

/**
 * One failed command, normalised. `index` is the zero-based position, in
 * the batch as sent, of the command that produced the failure (the server's
 * sourceCommandIndex — the echoed alias is replaced by a generated one, so
 * the index is the only key back to the request); null when the server gave
 * none. Several failures can share one index: a failed create fails every
 * descendant it would have parented, and the first entry is the root cause.
 * `message` is the server's text, often an apostrophe-delimited token
 * ("Violation'Invalid'Epic.Scope") a caller can branch on or run through
 * loc-2 — but an unknown attribute reads differently in `select` and in
 * `where`, so match on text with care. stackTrace is never kept: only
 * internal development builds send it.
 */
export interface CommandFailureDetail {
  index: number | null;
  message: string;
  /**
   * The command as the server echoed it, under a generated alias: what a
   * caller resends after correcting it. Readable on every failure but not
   * enumerable, so a serialised failure (a receipt, a log line) carries
   * index, message and violation and not the whole command.
   */
  readonly echoed: Record<string, unknown>;
  /** The message read as a validation violation, when it is one. */
  violation: Violation | null;
}

/**
 * A validation failure as api/asset words it: `Violation'<Rule>'<tag>`,
 * where the rule is Required, Invalid, AssetCannotDeleteClosed, … and the
 * rest, when present, names what was violated. The attribute form is a
 * loc-2 tag (`AttributeDefinition'Scope'Story`, live 2026-11-12), which
 * `client.localize` turns into the attribute's label; an older spelling is
 * the token itself (`Epic.Scope`). Both read as `attribute: "Story.Scope"`.
 */
export interface Violation {
  rule: string;
  /** "Story.Scope" when the violation names an attribute; null otherwise. */
  attribute: AttributeTokenRef | null;
  /** The loc-2 tag naming what was violated (`AttributeDefinition'Scope'Story`), when the message carries one; null for the token spelling. */
  tag: string | null;
}

/** The violation a failure message describes, or null when it is not one. */
export function parseViolation(message: string): Violation | null {
  const parts = message.trim().split("'");
  if (parts[0] !== "Violation" || !parts[1]) return null;
  const rule = parts[1], rest = parts.slice(2).filter((p) => p !== "");
  if (rest[0] === "AttributeDefinition" && rest[1] && rest[2]) return { rule, attribute: `${rest[2]}.${rest[1]}`, tag: rest.join("'") };
  // The older spelling names the attribute by its token ("Epic.Scope"): not a loc-2 tag, so `tag` is null there.
  const token = rest.length === 1 && /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(rest[0]!) ? (rest[0] as AttributeTokenRef) : null;
  return { rule, attribute: token, tag: !token && rest.length > 1 ? rest.join("'") : null };
}

/** What a batch did, in the model's terms: the services read this, never the envelope. */
export interface Outcome<Row extends Asset = Asset> {
  /** The server's id for the request: what to quote when asking about a batch. Null for an outcome merged from several sends. */
  requestId: string | null;
  created: Oid[];
  modified: Oid[];
  operated: Oid[];
  failures: CommandFailureDetail[];
  /** One slot per query, in request order; null where the query failed. */
  queryResults: (Row[] | null)[];
  /**
   * Indexes, in the batch as sent, of updates and operations addressed to
   * one asset by its OID (`from: "Story:1"`) that matched nothing: the
   * asset is not in `modified` / `operated` and no failure names the
   * command. The server answers such a command with success and silence —
   * the asset is gone. (An operation its type does not have is a failure,
   * not this.) Empty for a command scoped by a query, where matching
   * nothing is an answer, and for a guarded send, which says `conflicts`.
   */
  unmatched: number[];
  durationSeconds: number | null;
}


# Changelog

Alpha releases may break between versions. Every breaking change is listed
here with the one-line migration a consumer applies. A renamed export keeps
its old name as a `@deprecated` alias for one alpha and is removed in the
next; `1.0.0` follows agility-rooms' adoption, and semver after that.

## 1.0.0-alpha.3 — the breaking batch (plan 005, step 2)

### Breaking

- **`client.assets.send` answers an `Outcome`, not the api/asset envelope.**
  `created`, `modified`, `operated` (momentless OIDs), `failures` (by index,
  each with its parsed `violation`), `queryResults` (one slot per query
  command, `null` where it failed), `durationSeconds`. Migration:
  `res.assetsCreated.oidTokens` → `res.created`;
  `res.commandFailures.count` → `res.failures.length`;
  `res.queryResult.results[i]` → `res.queryResults[i]`. The wire module
  `assetApi.send` still returns the envelope for a passthrough.
  `CommandFailureError` gains `outcome` beside `response`.
- **Every SDK error is an `ApiError` with a `kind`** (`auth`, `forbidden`,
  `notFound`, `invalid`, `transient`, `aborted`, `commandFailure`,
  `protocol`, `usage`, `unknown`). Mistakes caught before any request
  (an unpaged read, an empty batch, a bad OID token or asset number) throw
  `UsageError`, not `Error`/`TypeError`. `UnguardableError` is a
  `UsageError`; `GuardedPassError`, `BatchSendError`, `BatchRecordError`
  and `AttachmentUploadError` are `WrappedError`s carrying the cause's
  kind. Migration: a `catch` on `TypeError` becomes `instanceof
  UsageError`; a branch on `status === 401` can become `kind === "auth"`.
- **rest-1 reads take a query's spelling**: `client.data.list(type, {
  select, filter, … })`. `sel` and `where` still work this alpha
  (deprecated) and go in the next.

### Deprecated (removed in the next alpha)

- `client.queryV1.query` / `.queries` → `client.query` / `client.queries`.
- `client.assets.query` / `.queries` → `client.query` / `client.queries`
  (or `client.queryPage` for a total).
- `client.attachments.url`, `client.embeddedImages.url` →
  `client.urls.attachment`, `client.urls.embeddedImage`.
- rest-1 `sel` / `where` → `select` / `filter`.

### Added

- Reads on the client: `client.query`, `queries` (query.v1: read-only,
  retried like a GET), `client.get(oid, select)`, `client.queryPage(q)`
  (total and `more`, via api/asset), `client.pages(q, { limit })` and
  `client.all(q, { limit })` (page by page up to a limit, default 1000),
  `client.me()` (the member the credentials belong to).
- Typed queries: a literal `from` completes `select` from the type's
  attributes, and rows are typed by what was selected (`row.Name` a
  string, `row.Nmae` a compile error, `Status.Name` unknown, an aggregate
  a number). An OID as `from` types by its type. `from` still takes an
  alias or an unknown type; variables and `query<Story>` work as before.
- `client.urls.asset(oid)`: the asset's page (`assetdetail.v1?oid=`).
- `parseViolation(message)` and `CommandFailureDetail.violation`: the
  rule, attribute token and loc-2 tag of a validation failure.
- `kindOf(status, code)`, `ErrorKind`, `UsageError`, `WrappedError`.

## 1.0.0-alpha.2

- Releases are staged with `npm stage publish` and approved by a
  maintainer with 2FA.

## 1.0.0-alpha.1

- Batch reverse uses the type's operations and the close cascade; the
  guard sends a second command on one asset as a second pass; Moment is
  never a guard stamp.

## 1.0.0-alpha.0

- First publish: `AgilityApiClient`, wire modules for api/asset,
  query.v1, rest-1 reads, meta.v1, loc-2.v1 and attachments; services for
  schema, resolve, guard, batch, attachments and embedded images.

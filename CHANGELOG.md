# Changelog

## 1.0.0-alpha.7 — what a browser app consumer asked for

Nothing breaks in this alpha. Each entry says what a consumer changes, if
anything.

### Added

- **`client.attachments.list` / `page` take a `select`**: more to read
  with each attachment, as a query's `select` on Attachment
  (`Category.Name`, `Asset.Number`, a sub-select). Each answer then
  carries those values under `selected`, keyed as selected, translated
  like any row and typed by what was selected. Without a `select` the
  answer is the metadata alone, as before. Migration: a second query for
  an attachment's other attributes becomes `list(asset, { select })`.
- **A one-request read for a small attachment**:
  `client.attachments.get(id, { inline: true })` reads the metadata and
  the bytes in one query.v1 request (the Attachment's `Content` comes
  back as Base64 beside its row) where the default is two (the row, then
  attachment.img). For small files: the response is a third larger than
  the file and is held in memory whole. `contentType` is then the
  recorded one. Migration: none; add `{ inline: true }` where a thumbnail
  or a small text file is read.
- **`normalizeQuery(query)`**: a query written with rest-1's spellings
  becomes the `QueryBody` every read takes — `sel` → `select`, a textual
  `where` → `filter`, comma-joined `select` / `sort` / `findin` → lists,
  a `"size,start"` page → `{ size, start }`, sub-selects the same way. A
  `QueryBody` comes back equal. Saying one thing twice (`sel` and
  `select`) or asking for `deleted` is a `UsageError`. `QueryBody` itself
  gains no alias. Migration: a consumer's own `sel`-to-`select` shim
  becomes `client.query(normalizeQuery(q))`.
- **`@versionone/agility-sdk/testing`** exports `FakeAgilityClient`: a
  real `AgilityApiClient` over a transport that sends nothing. A test
  scripts answers in the model's shape (`onQuery("Story", rows)`,
  `onSend(outcome)`, `onRequest(path, answer)` for any other endpoint)
  and asserts on what was asked (`asked`, `sent`, `requests`). A scripted
  list is paged by the fake, a write answers OIDs without a script, and a
  read nothing was scripted for throws a `UsageError` instead of reading
  as empty. It evaluates no filter and applies no write. Migration: a
  hand-written fake client or fake Transport in a consumer's tests can be
  replaced by it; nothing requires that.
- **`apiErrorFromResponse(status, data)`**: the `ApiError` the fetch
  transport throws for a refused response, exported for a custom
  `Transport` to throw, so message, `kind` and `details` are the same
  whichever transport sent the request. Migration: a custom transport's
  `new ApiError(text, status)` becomes `apiErrorFromResponse(status,
  body)`.
- **`@versionone/agility-sdk/wire`**: the wire modules (`assetApi`,
  `queryV1`, `rest1`, `meta`, `loc2`, `attachment`, `fields`, `select`)
  under their own import path. The root still exports them in this
  alpha and stops in the next. Migration: `import { assetApi } from
  "@versionone/agility-sdk"` → `from "@versionone/agility-sdk/wire"`.

### Documented

- `Page.more` is the pager's signal: with a total it is exact; when
  `total` is null it is whether the page came back full, so a pager
  offers "next" on `more`, never on `total`.
- `kind: "usage"` (on `ApiError.kind`): the SDK refused the call before
  sending anything — no request reached the server and `status` is 0.
- `ClientConfig.baseUrl` with a custom `Transport`: the transport alone
  decides where requests go; `baseUrl` is then used only for the links
  the client builds (`client.urls.*`, `embeddedImages.normalize`), so
  give it the instance's public URL.
- `client.query`'s doc said a resend needed `retries` raised from 0 and
  that `details` was the whole error document; both changed in alpha.5
  and the doc now says so.

## 1.0.0-alpha.6

- The generated model is refreshed from meta.v1 26.3.2.13 (was
  26.3.1.13): no type, attribute, flag or operation changed between the
  two; only the version stamp moved.

### Breaking

- **Node 22 or later** (`engines.node` is `>=22`, was `>=18`), and `dist`
  is now built for Node 22+ (tsup's `target` was `node18`). Node 18
  reached end of life in April 2025 and Node 20 in April 2026; neither
  gets security fixes. CI tests the maintained LTS lines, 22, 24 and 26,
  so a consumer on 18 or 20 was already untested. (The chat-bot consumer
  runs 24 and the CLI consumer requires 22; the browser app consumer
  does not run on Node.)

## 1.0.0-alpha.5

### Added

- **Conditional schema reads** (for a browser app consumer). meta.v1 sends one
  strong ETag for the whole schema (`"26.3.1.13.<stamp>"`, the same on
  the document, a type and an attribute) and honours `If-None-Match` with
  a 304. `client.meta.read({ ifNoneMatch })` and `readType(token, {
  ifNoneMatch })` answer `{ value, etag }`, or null without a download when
  the tag still matches; `client.meta.etag()` reads the tag alone from
  the smallest resource. `TypeCache.etag` remembers the tag the loaded
  types came with, and `client.schema.revalidate()` asks the server in
  one small read and drops the loaded types only when the tag moved —
  what a browser app's metamodel store does by hand. Transport: a request with
  `acceptNotModified` resolves to undefined on a 304 after `onResponse`
  sees it.

### Changed

- **Idempotent requests are resent once by default** (`retries` now
  defaults to 1, was 0): a GET, a query.v1 read or a guarded batch that
  says so, after a network failure or a 5xx, 150 ms later. A plain write
  is never resent, as before. Pass `retries: 0` for the old behaviour.
  (a CLI consumer: the doc promised a retry the default never made.) A 429 counts
  as transient like a 5xx — the instance throttles per token — and a
  Retry-After is honoured when sent, up to 30 s.
- **A rejected query's `details` are the exceptions alone**
  (`{ type, message }[]`, exported as `QueryRejection`), not query.v1's
  whole error document; `message` is unchanged. (a CLI consumer: a formatter that
  printed details printed a JSON document.)
- **`CommandFailureDetail.echoed` is not enumerable**: still readable on
  every failure for a corrected resend, but a serialised failure (a
  receipt, a log line, a bot's result) carries index, message and
  violation only. (chat-bot and CLI consumers: re-mapping failures to keep results
  small.)
- **The committed `metamodel.json` names no instance**: every `href` is
  spelled from `/meta.v1/` (`scripts/download-metamodel.mjs` rewrites
  them on a pull). The generated types are unchanged; nothing in the SDK
  reads an href.

## 1.0.0-alpha.4 — what the three adoptions asked for

### Added

- **Two narrow rest-1 paths** (for a browser app consumer): `client.data.operate(oid,
  op)` runs an operation for its result — api/asset performs a Copy but
  reports only the source; rest-1 answers the copy's OID — and
  `client.copy(oid)` is that for Copy. `client.data.template(type, {
  ctx })` reads `New/<Type>?ctx=`: what the type's initializer fills in
  for a context (a Timebox's next name and dates, schedule, state and
  owner; a Story's carry-over from a Request), translated like a row,
  without an `_oid`. Neither sends attribute values: rest-1 still carries
  no update path.
- **`client.fields`**: `describe(type, scope)` joins what a form needs —
  the attributes the server requires on a create (meta), the ones the
  product shows for the type in that scope (`api/visibleFields`, custom
  fields included once configured), and the scope's scheme's important
  fields with whether they are enforced at close; `visible(types,
  scopes)` and `visibleByAsset(oid)` are the endpoints alone. New wire
  module `fields`.
- **`client.urls.asset` takes an asset Number** as well as an OID
  (`assetdetail.v1?Number=S-01001`): the readable form a CLI prints and a
  chat message shows (a CLI consumer, a chat-bot consumer).
- **`Outcome.requestId`**: the server's id for a batch, worth logging
  (a chat-bot consumer). Null for an outcome merged from several sends.
- `outcomeOf` tolerating a partial envelope is now a stated contract
  with a test: consumers' fakes may send only the fields they need.

### Fixed

- `parseViolation`: `tag` is null for the token spelling
  (`Violation'Invalid'Epic.Scope`); it was the token, which is not a loc-2
  tag (a CLI consumer).
- `CHANGELOG.md` ships in the npm package.
- Doc notes: `kind: "usage"` means nothing was sent (status 0), so an
  error formatter should not blame the server; `client.query`'s resend
  after a failure needs `retries` above its default of 0; the deprecation
  notes on `queryV1` and `assets.query` say where each endpoint is.

### Migration note (from alpha.3's read path)

- A rejected query through `client.query` is an `ApiError` with kind
  `invalid` and code `QUERY_REJECTED`; `message` holds the server's
  sentences and `details` its whole error document. A formatter that
  printed `details` for api/asset's `CommandFailureError` now prints a JSON
  document; print `message`.

Alpha releases may break between versions. Every breaking change is listed
here with the one-line migration a consumer applies. A renamed export keeps
its old name as a `@deprecated` alias for one alpha and is removed in the
next; `1.0.0` follows the browser app consumer's adoption, and semver after that.

## 1.0.0-alpha.3 — the breaking batch

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

- The generated model is refreshed from meta.v1 26.3.1.13 (it was a
  0.0.0.0 dev build): `Workflow`, `TeamWorkflow` and `WorkflowTransition`
  arrive, with `Status.AllowedStatusTransitions`,
  `Status.WorkflowStatusTransitions`, `Role.AllowedStatusTransitions` and
  `Team.TeamWorkflows`. Nothing was removed or changed.
  `scripts/download-metamodel.mjs` now strips an instance's own
  definitions and reports them, so a refresh is reviewable.
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
- Custom list types (`Custom_<Name>`, the one custom asset type Agility
  allows, a subtype of List) type as `CustomList`: List's attributes and
  the type's own token as `AssetType`, as a `from` or as an OID. Custom
  attributes (`Custom_…`) and the reciprocal side of a custom relation
  (`ReciprocalOf_…`, which the server adds on the related type) are
  accepted on every type as attribute values.
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

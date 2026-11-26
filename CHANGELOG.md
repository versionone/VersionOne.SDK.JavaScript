# Changelog

## 1.0.0-alpha.9

### Breaking

- **`client.data.list` is removed, and `client.data` with it.** Its uses
  have named calls. Migration:
  - a text search across asset types → `client.search(text, { types, … })`
    (below);
  - a search within one type or family, or any other list →
    `client.query` / `client.queryPage` (with `find` and `findin` for a
    search);
  - deleted assets → `client.deleted(type, params)`;
  - rest-1's list itself, for a caller that wants the endpoint:
    `import { rest1 } from "@versionone/agility-sdk/wire"` and
    `rest1.list(client.transport, type, params)`, unchanged.
- **A Ref is `{ _oid }` on every read; rest-1's unasked display columns
  are dropped, no longer put on the Ref.** `client.history`,
  `client.template`, `client.deleted`, `client.search` and `rest1.list` /
  `rest1.get` from `/wire` used to answer `Owners: [{ _oid, Name,
  Nickname }]` for a selected relation, because rest-1 sends those columns
  beside it; the query endpoints never did, so the same select gave two
  rows. Migration: select the path you read (`"Owners.Name"`,
  `"Status.Name"`, `"Scope.Name"`) and read it at `row["Owners.Name"]` (an
  array parallel to `row.Owners` for a multi-value relation). Nothing
  errors if you do not: `ref.Name` is simply undefined, so search your
  code for a name read off a relation. A read with no select at all (a
  template) keeps every column the server sent, each under its own key
  (`template["Scope.Name"]`), and its Refs are bare too. (a CLI consumer.)
- **A date has one spelling on every read**: `"2026-09-06T13:52:51.903"`,
  three decimals, with a `Z` on a UTC attribute: the standard's date-time
  format, which `new Date(value)` reads in any engine. The endpoints
  differ, and rows used to carry whichever spelling the endpoint behind
  the call used: `query` and `get` answered seven decimals
  (`"…51.9030000"`), `queryPage` dropped trailing zeros (`"…51.903"`,
  `"…14.6"`), and `history`, `template` and the rest-1 reads answered
  three decimals and a midnight as the date alone (`"2011-09-20"`). So
  this changes the default read path too. The SDK cuts to the
  millisecond, by design: the server's stored resolution is about three
  milliseconds (in a live sample of 400 timestamps, every digit past the
  third was zero and the third was only ever 0, 3 or 7), so nothing
  observed is lost; if an instance ever carries finer digits they are
  dropped. Migration: code that compares date strings against stored
  ones, or slices them by position, should parse them (`new Date(value)`,
  now portable), take the day with `value.slice(0, 10)`, or expect the
  one spelling; a consumer's own normalising of fractions can go.
  `rest1.list` / `get` / `history` / `template` from `/wire` spell dates
  this way when given `{ lookup: client.schema }`, and as rest-1 sent
  them without. (a CLI consumer and a browser-app consumer.)
- **A read with an empty `find` throws a `UsageError`** (`kind: "usage"`,
  nothing is sent), on `query`, `queries`, `queryPage`, `pages`, `all` and
  `deleted`. It used to answer no rows, because that is what the server
  answers to a search for nothing, and no rows read as "nothing matches".
  Migration: when the search box is empty, leave `find` out of the query
  (or do not send the read).

### Changed

- **`client.explain`: a rule the instance has no sentence for is for a
  developer, not a user.** Its explanation is the rule's name spelled out
  ("Refused (asset cannot inactivate closed)."), which is a name and not a
  sentence written for a person, and can read as the opposite of what
  happened ("Refused (message must not be sent)." is said of a message
  that was). `audience` is now `"developer"` for these; the sentence,
  `rule` and `echoed: false` are unchanged. Migration: none if you show
  only `audience: "user"` sentences; such a failure now gets your own
  wording.

### Added

- **`client.search(text, { types, select?, findin?, filter?, where?,
  with?, sort?, page })`**: text search across asset types, answered as
  `{ rows, total, more }`: one page of mixed rows in one server-side
  order. `types` is required: concrete types, or a family by its
  abstract type (`"Workitem"`). `select` and `findin` take plain attribute
  names, and each row has every selected key under that name: its value
  if the row's type defines the attribute, `null` if not, so a Story and a
  Request both have `Number`, and a name none of the searched types has
  is `null` on every row (only a name that is no attribute of anything is
  refused). Nothing type-qualified is written or read
  in a select; `filter` is sent as written and may be type-qualified,
  since a condition across types has no plain spelling.
  A consumer that built this from `client.data.list("BaseAsset", …)` with
  one `<Type>.Number` select per type replaces it with one call.
  (a CLI consumer and a chat-bot consumer.)
- **`client.deleted(type, params)`**: deleted assets of a type, as
  `{ rows, total, more }`.
- `FakeAgilityClient.onSearch(rows)` and `fake.searched`, to test code
  that searches, through the fake or through a client built on
  `fake.transport`.
- The subpaths' types resolve under TypeScript's `moduleResolution:
  "node"` (node10), which ignores `exports`: `package.json` has a
  `typesVersions` entry for `/wire`, `/services` and `/testing`. A
  consumer's ambient `declare module` bridge for them can go.
  (a browser-app consumer.)
- `@versionone/agility-sdk/services` has `search`. The root exports the
  types `SearchOptions`, `SearchResult`, `SearchRow`.

### Documented

- README, "Searching": a search within one type or family is
  `client.query` with `find` and `findin`; across types it is
  `client.search`. The server's matching rules are stated (every word,
  whole words, stemming, `*`, the few seconds the text index trails a
  write), each proved by a live test.

### Repository

- The repository has runnable examples, one per task, in `examples/`
  (they are not in the published package). They are compiled by
  `npm run typecheck` and run by the integration tier.

## 1.0.0-alpha.8 — the last breaking batch before 1.0

Each entry has the line a consumer follows to migrate.

### Breaking

- **Writes are on the client itself**: `client.assets.send` →
  `client.send`; `client.assets.preview` → `client.preview`;
  `client.assets.sendGuarded` → `client.sendGuarded`. `client.assets` is
  gone. Migration: delete `.assets`.
- **The wire modules are at `@versionone/agility-sdk/wire` only.** The
  root no longer exports `assetApi`, `queryV1`, `rest1`, `meta`, `loc2`,
  `attachment`, `fields`, `select`, nor the endpoints' envelope types
  (`AssetApiResponse`, `AssetDocument`, `AssetsDocument`, `RowContext`,
  `ReadOptions`). Migration: `import { assetApi } from
  "@versionone/agility-sdk/wire"`. What a caller writes and reads stays
  on the root: `QueryBody`, `Command`, `CreateBody`, `UpdateBody`,
  `ExecuteBody`, `Outcome`, `CommandFailureDetail`, `Violation`,
  `CommandFailureError`, `parseViolation`, `normalizeQuery`.
- **The aliases deprecated in alpha.3 are removed**:
  - `client.queryV1.query` / `.queries` → `client.query` /
    `client.queries`
  - `client.assets.query` / `.queries` → `client.query` /
    `client.queries`, or `client.queryPage` for a total
  - `client.attachments.url`, `client.embeddedImages.url` →
    `client.urls.attachment`, `client.urls.embeddedImage`
  - rest-1 `sel` / `where` on `client.data.list` and `history` →
    `select` / `filter`
  - `new AgilityApiClient(config, transport)` → `new
    AgilityApiClient(config, { transport })`
- **A read's `page` is required by the type.** `client.query`,
  `queries`, `queryPage`, `pages` and `all` take a `Query` (a `QueryBody`
  with its page), so an unpaged read no longer compiles; it threw a
  `UsageError` at run time before, and still does for a caller the types
  do not reach — now before any request, a schema load included.
  Migration: add `page: { size, start }`; a variable typed `QueryBody`
  that is passed to a read becomes `Query`. A sub-select stays a
  `QueryBody`.
- **`needTotal` is no longer a key of `QueryBody`.** `client.queryPage`
  is how a total is asked for. Migration: remove the key; call
  `queryPage`.
- **One way to hand the client its types**: `ClientOptions.metamodel` and
  `ClientOptions.schema` are gone; `types` (a `TypeCache`) stays.
  Migration: `{ metamodel }` → `{ types: TypeCache.fromMetamodel(metamodel)
  }`; `{ schema }` → `{ types: schema.cache }`.
- **Error codes are spelled one way**: `code: "CommandFailure"` →
  `"COMMAND_FAILURE"`. `kind` (`"commandFailure"`) is unchanged and is
  what to branch on. Migration: a comparison with the old code string
  changes; one on `kind` or `instanceof CommandFailureError` does not.

- **The guard compares Moments, and a conflict is said out loud.**
  `sendGuarded` and `batch.run` guard each asset on its `Moment` together
  with `RetireDateUTC=''` (an exact compare-and-set; the evidence is on
  issue #51), where they compared a `ChangeDate` literal. What changes for
  a caller:
  - `sendGuarded`'s result is flat: the `Outcome`'s own fields
    (`created`, `modified`, `operated`, `failures`, `queryResults`,
    `requestId`) plus `touched`, `conflicts` and `details`. Migration:
    `res.outcome.modified` → `res.modified`; `res.skipped` →
    `res.conflicts`; `res.projected` / `res.sent` / `res.stamps` →
    `res.details.projected` / `.sent` / `.stamps`.
  - `conflicts` holds only the assets whose command matched nothing
    (changed since they were read, or gone). An asset whose command
    failed is in `failures` and no longer also listed as skipped; a
    command that matched and changed no value is a success.
  - With `throwOnFailure`, a conflict throws a `ConflictError` (`kind:
    "conflict"`, code `CONFLICT`) carrying the result. Migration: a
    caller that passes `throwOnFailure` and wants conflicts returned
    catches it, or stops passing the option.
  - Stamps are Moments (digits), not timestamps: `details.stamps`,
    `Receipt.stamps`, `Receipt.after`, and `was` / `now` in
    `batch.reversible`'s `drifted`. For a readable time use
    `Receipt.changedAt[oid]`, `before[oid].ChangeDate`, and
    `drifted[i].wasChangedAt` / `nowChangedAt`.
- **`batch.run` takes `guard: true | false` and has no default** (it
  defaulted to true). Migration: `client.batch.run(commands)` →
  `client.batch.run(commands, { guard: true })`.
- **Receipts are `receipt: 2`**: `skipped` → `conflicts`; new `stamps`,
  `changedAt` and `stopped`; and the assets a receipt names are rows,
  like every other asset the SDK answers: in `created` and `touched`,
  `oid` → `_oid`, `type` → `AssetType`, `number` → `Number`, `name` →
  `Name` (`touched` gains `AssetType`); in `names[oid]`, `number` →
  `Number`, `name` → `Name`. **A stored `receipt: 1` cannot be checked
  for drift**: `batch.reversible` throws a `ReceiptVersionError` (`kind:
  "usage"`, code `RECEIPT_VERSION`) for it. Migration for a holder of old
  receipts: reverse one with `{ force: true }`, which sends its reverse
  without checking whether anyone changed the assets since; or run the
  batch again and keep the new receipt. `isReceipt(value)` tells a
  current receipt from anything else before calling. `batch.reversible`
  now requires the receipt's `receipt` field in what it is given: pass
  the whole receipt, or pick `receipt` along with `reverse`, `after` and
  `changedAt`.
- **An unguardable reason has a `code`** (`aliasedWrite`,
  `bareAliasFrom`, `inlineCreate`, `noMoment`). Migration: branch on
  `reason.code`, not on the words of `reason.reason`.

- **Idempotent requests are resent once with any Transport, not only the
  built-in one.** The rule (a GET, a query.v1 read or a guarded batch
  with no creates is sent once more after a network failure, a timeout,
  a 5xx or a 429; `retries` says how many times, default 1) was the fetch
  transport's; it is now the client's, applied around a custom
  `Transport`. A plain write is never resent, nor a 401 or 403
  (re-authentication is the transport's own business), nor any other 4xx,
  nor an aborted request. **This changes behaviour for a consumer with a
  custom Transport**: its reads start being resent once. Migration:
  nothing, if that is welcome. To keep the old behaviour, pass `retries:
  0` in the client's config. A transport that shows an error to the user
  before it throws (an interceptor's toast) will have shown the first
  failure of a request that then succeeded: either pass `retries: 0` for
  that client, or move the reporting to the client's new `onError`, which
  is told only about a request that finally failed. A custom transport
  that already resends on its own should pass `retries: 0` or stop doing
  so, or a read is tried up to four times.
- **One rule for every row, on every read path**: a relation you select
  is a Ref; a path you select by name is at `row[path]`; nothing arrives
  that you did not select. query.v1 and api/asset rows already followed
  it. On rest-1 (`client.data.list`, `client.history`) the display
  columns the server adds beside a selected relation (`Owners.Name`,
  `Owners.Nickname`) are now on the Refs only; their dotted keys are gone
  from the row unless the path is in `select`. Migration: read
  `row.Owners[i].Name`, or add `"Owners.Name"` to `select` to keep
  `row["Owners.Name"]`. A dotted or type-qualified key with no Ref to
  fold onto is kept as sent.
- **rest-1's other reads are on the client itself**:
  `client.data.history` → `client.history`; `client.data.template` →
  `client.template`; `client.data.operate` → `client.operate`.
  `client.data.get` is gone (`client.get` reads one asset).
  `client.data.list` stays where it is.
- **The services as free functions are at
  `@versionone/agility-sdk/services`**, one namespace per module
  (`guard`, `batch`, `resolve`, `schema`, `attachments`, `fields`). The
  root no longer exports `sendGuarded`, `guard`, `stampsOf`, `touchedBy`,
  `UNGUARDABLE_TYPES`, `runBatch`, `reversible`, `reverseOf`, `snapshot`,
  `describeBatch`, `namesOf`, `INVERSE`, `resolveNumbers`, `resolveRef`,
  `NUMBER_ROOTS`, `RESOLVE_CHUNK`, `importantName`, nor `Schema` as a
  value (its type stays). Migration: `import { guard } from
  "@versionone/agility-sdk/services"` and call `guard.sendGuarded(…)`;
  or use the client's method, which is the same thing. The root keeps
  the client, the model, every error class, `unguardable`, `isReceipt`,
  `isAssetNumber`, `TypeCache` and the helpers below.
- **A refused rest-1 read is a `QUERY_REJECTED`** like a refused
  query.v1 read: `details` is the exceptions (`{ type, message }[]`) and
  `message` their sentences, led by rest-1's own ("Invalid WHERE
  parameter; …"). It was a plain `ApiError` with the whole error document
  as `details`. Migration: a formatter that special-cased rest-1 can
  print `message` for both.
- **Row types**: a sub-select is typed as rows of the related type with
  what it selected (it was typed as bare Refs, which was wrong); a
  selected key is its value or null and never `undefined` (a row has the
  keys that were selected); and a
  single relation is always `| null` on a row, also where the metamodel
  calls it required (the asset it pointed at may be gone). Migration: a
  cast that worked around the old sub-select type can go; code that read
  a required single relation without a null check gets a compile error
  and needs the check.

- **`client.attachments.add` no longer answers `CreateDate` and
  `"CreatedBy.Name"`.** They were always null there (the server's stamps
  are not read back after a create), which in a row read as "this
  attachment has no creator or date". The answer's type is
  `AddedAttachment`, and so is `AttachmentUploadError.attachment`.
  Migration: read them with `client.attachments.info(id)` or from a
  `list`. (a browser app consumer.)
- **A resolved asset is a row**: `client.resolve.numbers` and `ref`
  answer `{ _oid, AssetType, Number, Name, AssetState }`, the names every
  row uses. Migration: `oid` → `_oid`; `type` → `AssetType`; `number` →
  `Number`; `name` → `Name`; `assetState` → `AssetState`.

### Added

- **`ClientConfig.onError(error, request)`**: told about every request
  that finally failed, after any resend, with any Transport. It
  observes: the error is still thrown. For an app-wide toast or a log
  line, without a wrapper Transport.
- **`onUnauthorized` may answer `"retry-write"`**: after
  re-authenticating, send the refused request once more even when it is
  a plain write. Opt-in, and the default is unchanged: a write is never
  resent, and `"retry"` still resends idempotent requests only. By
  answering it the hook asserts that on its server a refusal with one of
  `unauthorizedStatuses` (an expired session) means nothing in the
  request was executed. **The SDK does not and cannot check that**: its
  tests run where every request is authenticated, so this premise is the
  consumer's to hold, for its own server. Honoured once per request.
- **`RequestOptions.reauthorize: false`**: a refusal of that request is
  answered straight away, without calling the transport's
  `onUnauthorized` hook. For the request a hook itself sends to ask
  whether the session is alive, which would otherwise wait on itself.
- `withRetry(transport, retries)`: the resend rule as a function, for a
  caller that uses a Transport without a client.
- **`client.explain(error)`**: an error said to a person. One
  `Explanation` per failed command (from a `CommandFailureError`, an
  `Outcome` or its `failures`), or one for any other error: a short
  `sentence` ("Project is required.") with the instance's own labels for
  the attribute and the asset type, the parts it was made from (`rule`,
  `attribute`, `attributeLabel`, `typeLabel`), and the server's own
  `localized` sentence where it has one. `Resolution'…` failures are read
  too, with the related type they name (`relatedType`,
  `relatedTypeLabel`). `audience` says who the sentence is for —
  `"user"` when it was made for a person and can be shown, `"developer"`
  when it is about the call itself or is the server's raw text — and
  `echoed` is true when nothing was explained, so a caller can explain
  any error and show only what is for a user. A rule the instance has no
  words for is never answered as its bare token. Migration: a consumer's
  own failure patterns and three-tag loc-2 lookups can go.
- **`transportConformance(make)`** from `@versionone/agility-sdk/testing`:
  the SDK's expectations of a `Transport` as a list of named checks,
  runnable against a custom transport with any test runner (path inside
  the base URL, body encodings, response types, `onResponse`, a 304 with
  `acceptNotModified`, errors worded as `apiErrorFromResponse` words
  them, abort and connection failure, `BAD_JSON`). `fetchFrom(server)`
  adapts the suite's stand-in network for a transport built on fetch. The
  SDK's own fetch transport runs it. A new duty of a Transport is from
  now on a new check here and a "Breaking" line. (a browser app consumer
  with an axios transport.)
- `meta.readMetamodelDocument({ ifNoneMatch })` and
  `meta.readAssetTypeDocument(token, { ifNoneMatch })` in
  `@versionone/agility-sdk/wire`: meta.v1's own document form with the
  conditional read, for a caller whose code parses the document.
  (`client.meta` answers the model's `Metamodel` and is unchanged.)
- **`FakeAgilityClient` at the transport's level too**: `new
  FakeAgilityClient({ metamodel })` gives the fake's instance the asset
  types of meta.v1 documents (only the types the code under test
  touches are needed), so a response captured from a server and
  scripted with `onRequest` reads translated, for the fake and for any
  client built on `fake.transport`; and `onList(type, rows)` scripts
  `client.data.list` in the model's shape. `sendGuarded` and `batch.run`
  work on the fake for assets addressed by OID that a row was scripted
  for: it keeps a moment per asset, `fake.touch(oid)` is someone else
  changing it (a conflict for a write stamped earlier, drift for a
  receipt's reverse) and `fake.remove(oid)` is it being deleted. Its
  preview projects a scalar update as the server does (`{ add, remove
  }`), and what a scripted Ref carries stays on it in a rest-1 list. (a
  chat-bot consumer and a CLI consumer, whose tests replay captured
  responses and fake a batch by hand.)
- **`client.resolve.refs(specs)`**: numbers and OID tokens mixed, each
  one read, in two requests at most; what names nothing is `missing`.
- **`Outcome.unmatched`**: the indexes of updates and operations
  addressed to one asset by OID that did nothing and reported nothing,
  because the asset is gone. The server answers such a command with
  success; a caller that checked `operated.length === 0` by hand reads
  this instead. (A command that applied without changing a value, and
  one the server refused, are not in it.) It is filled by `client.send`
  and on the receipt of an unguarded `batch.run`, for aliased commands
  by OID as for bare ones.
- `assetStateKind(value)`: an AssetState name or code as `"open"`
  (Active, and only Active), `"future"` (Future: not begun),
  `"closed"` (Closed), `"template"` (code 200) or `"deleted"`
  (Deleted), each checked against a server, and `"other"` for every
  other state: it does not guess at Dead or a split story.
- The fetch transport calls the global `fetch` as it is at each request
  (it captured it when the transport was made), so a stub installed
  later is used without passing `fetchImpl`.
- A read's explicit row type can be the caller's own: `client.query<Card>(…)`
  needs only `_oid` on `Card`, not the SDK's `Asset`.
- `@versionone/agility-sdk/package.json` resolves, by `require` and by
  `import`: the exports map did not list it, so a tool reading the
  package's version that way was refused.
- `ReadResult.more` on rest-1 reads, as on `queryPage`.
- `toBase64` / `fromBase64` on the root; an inline attachment read also
  answers `base64`, the content as it arrived.
- **`sendGuarded(commands, { moments })`**: guard an asset on the moment
  the caller read earlier (select `Moment` with the row a person is
  shown), so a change made since they saw it is a conflict.
- `Receipt.stopped` says why nothing was sent: `"nothing"`, `"dryRun"` or
  `"declined"`.
- `ErrorKind` gains `"conflict"`.

### Changed

- The guard's blind spot is documented: a change that makes no new
  version of an asset (a child added to it) is invisible to it.
- `FakeAgilityClient.requests` leaves out the client's own unscripted
  meta.v1 type loads: it lists what the code under test asked for.
- The `Ref` type's doc said a dotted path lands on the Ref; it does not.
  A sub-select puts attributes on a Ref; a path selected by name arrives
  under its own key.

## 1.0.0-alpha.7 — what a browser app consumer asked for

One breaking change, to attachments; everything else is additive. Each
entry says what a consumer changes, if anything.

### Breaking

- **An attachment is answered as a row of the Attachment type**, under
  meta.v1's attribute names like every other row, plus `id`. It was the
  one place the SDK had a vocabulary of its own. This holds for
  `client.attachments.list`, `page`, `info`, `get` and `add`, and for
  `AttachmentUploadError.attachment`. Migration, field by field:
  - `oid` → `_oid`
  - `id` → `id` (unchanged: the number attachment.img addresses)
  - `name` → `Name`; `filename` → `Filename`; `description` →
    `Description`; `createDate` → `CreateDate`
  - `contentType` → `ContentType` (the recorded one)
  - `createdBy` → `["CreatedBy.Name"]` (the select path, as selected)
  - on `get`: `contentType` (the served type, falling back to the
    recorded one) → `servedContentType ?? ContentType`;
    `recordedContentType` → `ContentType`
  `add`'s options (`filename`, `contentType`, `name`, `description`,
  `inlineLimit`) are unchanged. The row type is closed (it does not
  extend `Asset`): it has these keys and the ones a `select` named, so a
  read the migration missed (`row.filename`) is a compile error rather
  than `undefined`.

### Added

- **`client.attachments.list` / `page` take a `select`**: more to read
  with each attachment, as a query's `select` on Attachment
  (`Category.Name`, `Asset.Number`, a sub-select). Each row then carries
  those keys too, as selected, translated like any row and typed by what
  was selected. Migration: a second query for an attachment's other
  attributes becomes `list(asset, { select })`.
- **A one-request read for a small attachment**:
  `client.attachments.get(id, { inline: true })` reads the metadata and
  the bytes in one query.v1 request (the Attachment's `Content` comes
  back as Base64 beside its row) where the default is two (the row, then
  attachment.img). For small files: the response is a third larger than
  the file and is held in memory whole. `servedContentType` is then
  null. Migration: none; add `{ inline: true }` where a thumbnail
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
  as empty. `resolve.numbers` finds a number among the scripted rows,
  a query from a create's alias reads the created asset back, `localize`
  echoes a tag `onLocalize` did not script, and `fake.transport` can
  serve a client the code under test builds itself. It evaluates no
  filter and applies no write. Migration: a
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

### Fixed

- **`Outcome.requestId` after `assets.sendGuarded` and `batch.run`** is
  the server's id when the batch went out in one request (the usual
  case); it was always null. It stays null when the batch took several
  sends. (a CLI consumer.) Migration: none.

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
- **For authors of a custom `Transport`** (this should have been under
  "Breaking" in alpha.5): a request with `acceptNotModified` must
  resolve to `undefined` on a 304, after calling `onResponse` with the
  304's status and headers, instead of rejecting. `client.meta.etag`,
  `meta.read`, `meta.readType` and `schema.revalidate` send such
  requests. And `retries` / `timeoutMs` configure the built-in fetch
  transport only: a client given its own Transport resends nothing unless
  that transport does.
- `client.meta` answers the model's `Metamodel` / `AssetType`
  (references as tokens), not meta.v1's own document; its doc said
  "raw".
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
- **`client.urls.asset` throws a `UsageError` for anything that is
  neither an OID token nor an asset Number** (it built a URL from any
  string before). This was a breaking change and was not listed as one
  when alpha.4 shipped. Migration: validate, or catch the `UsageError`.
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

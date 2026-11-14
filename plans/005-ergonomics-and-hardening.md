# Plan 005: Ergonomics and hardening before agility-rooms adopts the SDK

Refined 2026-11-12 against this repo at `2841655` (`1.0.0-alpha.2`). The
first draft was written in a brainstorming session without the code; this
version checks every item against `src/`, `test/`, `specs/000-layers.md`
and plans 001–004, keeps what is still open, marks what is already done,
and ranks the findings by how much friction each causes. The consumer
repos (gh-v1, k6i-agility-slack-bot, agility-rooms) are not re-read here;
what they need comes from plan 001's surveys, plans 002–004, and the SDK
fixes their adoptions forced (#42–#45, #50, #52).

## Context, corrected

- **What exists.** One client (`AgilityApiClient`) over a pluggable
  `Transport`; wire modules for api/asset, query.v1, rest-1 (reads only),
  meta.v1, loc-2.v1 and attachments; services for schema (lazy, shareable
  `TypeCache`), resolve (numbers → assets), guard (ChangeDate
  compare-and-set), batch (receipt and reverse), attachments and embedded
  images. 165 generated asset types (`AssetTypeName`,
  `ConcreteAssetTypeName`, `AssetTypeMap`). ~8,000 lines of source, 131
  unit tests, 33 integration tests on `v1sdktesting`, CI on Linux and
  Windows, staged publishing to npmjs. Spec 000 holds the invariants.
- **Who depends on it.** gh-v1 (vendored ESM build, hash-checked, pinned
  `1.0.0-alpha.0`+) and the slack bot (exact pin) are done; agility-rooms
  (plan 004) has not started, and its first step is a decision on rooms'
  rest-1 writes, `?op=Copy` and `New/{T}` templates.
- **What adoption already taught.** gh-v1's C2–C3 forced six fixes
  (aliased-only batches, `BatchRecordError`, `names` before confirm,
  `NULL` relations, Rank as number); the bot's B2/B4 forced group-row
  translation, `TypeCache`, absent-root memory and the `Template` state.
  Each was a real gap the fakes had not shown, which is the argument for
  doing this pass before rooms' 111 api/asset call sites move.

## Goals (unchanged)

- Common tasks simple, hard tasks possible.
- Types that guide a person or an agent to correct use.
- Close the gaps the slack bot, the CLI and rooms expose.

## Review 1: Ergonomics — findings, ranked by friction

Read-only pass, done. Each finding names the code and the fix. **B** marks
a breaking change; those go out together (see Sequencing).

1. **`assets.send` returns the api/asset envelope** (`AssetApiResponse`:
   `assetsCreated.oidTokens`, `queryResult.results`, `requestId`…) while
   `batch.run` returns `Outcome` in model terms. Spec 000 §2 says a caller
   never sees an envelope; the client's own `send` hands one over, and a
   caller must know `outcomeOf` exists. **B:** `send` returns `Outcome`
   (with the envelope reachable for the passthrough case).
2. **Nothing typed guides a query.** `QueryBody.from` and `select` are
   `string`; `query<Story>(…)` is a caller's assertion, not a derivation,
   so a typo in `select` compiles and `row.Name` is typed as if the
   whole asset were selected. `AssetTypeName`/`AssetTypeMap` are exported
   and unused. Fix: `from: AssetTypeName | (string & {})` (completion
   without closing the door on an OID or alias), rows typed from
   `AssetTypeMap[F]`, and first-hop `select` completion from the type's
   keys; the same for `CreateBody` (required attributes are already
   non-optional in the generated types). Not breaking if done as
   overloads; verify with gh-v1's JSDoc consumers.
3. **A caller chooses the endpoint.** `client.assets` (api/asset),
   `client.queryV1`, `client.data` (rest-1), `client.meta`: the namespaces
   are the API's history, and the same read is written three ways with
   three parameter spellings — api/asset `select`/`filter`/`with` vs
   rest-1 `sel`/`where`/`with` (and `where` means a filter list there, a
   map on api/asset). **B:** one `QueryBody` everywhere (the rest-1 wire
   module translates to `sel`); `client.query`/`queries` as the default
   read path (query.v1: read-only, retryable), `client.assets` for
   batches, `client.history` for rest-1's Hist. `client.localize` is a bare
   method beside namespaces; fold URL builders into one place (finding 9).
4. **Errors are typed, not classified.** `ApiError` carries `status`,
   `code?`, `details`; codes exist for the transport (ABORTED, TIMEOUT,
   NETWORK_ERROR, BAD_JSON), queries (QUERY_REJECTED, BAD_RESPONSE),
   attachments (NOT_FOUND, TOO_LARGE) and `CommandFailure` (status 200,
   which surprises), but nothing says "auth", "permission", "not found",
   "invalid" or "transient": the bot switches on `status === 401` itself,
   `schema.load` on `404`. Programmer mistakes (an unpaged query, an empty
   batch, a bad OID) are plain `Error`/`TypeError`. Validation failures are
   text tokens (`Violation'Required'…'Content'`) nobody parses. Fix: a
   `kind` on every SDK error (`auth | forbidden | notFound | invalid |
   transient | conflict | usage`), a `UsageError` class for mistakes the
   SDK catches before any request, and a parser for the violation tokens
   (attribute, rule) that loc-2 can label. Messages already say how to fix
   most things; keep that bar.
5. **Totals and paging stop at the wire.** `page` is required and spelled
   the same everywhere (good). But `client.assets.query` returns bare rows;
   the total and "more?" live only in `assetApi.queryPage` (not on the
   client, and it needs the schema passed as `lookup`), `rest1.list`'s
   `ReadResult`, and `attachments.page`. Fix: `client.queryPage` on the
   client, and `client.pages(q, { limit })` as an async iterator with a
   hard cap, so no consumer writes its own loop.
6. **Common tasks take hand-assembled calls.** Counted against the code:
   - one asset by OID with chosen fields: a query with `from: "Story:1"`
     and a mandatory `page` (or rest-1 `data.get`). Add `client.get(oid,
     select)` → one translated row or null.
   - create a story in a status by name: query StoryStatus, query Scope,
     then create — three calls and knowledge of list types. See Review 2.1.
   - comment on an asset: one batch (Conversation + Expression under an
     alias) but the shape (`Author`, `BelongsTo`, `Content`, `Mentions`)
     is folklore; and `Author` needs the current Member, which nothing
     returns. Add `client.me()` and a conversations service (Review 2.3).
   - a link to an asset's page: none; gh-v1 kept `permalink` local.
7. **Two APIs ship from one entry.** `src/index.ts` exports every wire
   module (`assetApi`, `rest1`, …), `select`, `AttributeLookup`,
   `Schema.ensureFor`: the low-level API beside the model one. It is
   needed (gh-v1's `gh v1 api` passthrough, custom transports, the bot's
   fixtures) but it doubles what an editor completes. Decide (Open
   Questions): keep both, move the wire layer to a `./wire` subpath
   export and mark it advanced.
8. **Naming, smaller.** `attachments.remove` beside `execute: "Delete"`;
   `info`/`get`/`list`/`page` on attachments vs `query`/`queries` on
   assets; `resolve.ref` vs `resolve.numbers`; `batch.reversible` is a
   builder, `batch.run` a sender. Settle one verb set (`get`, `list`,
   `page`, `create`, `update`, `remove`, `run`) in the breaking batch and
   keep the old names as deprecated aliases for one alpha.
9. **Three URL builders, two homes.** `attachments.url`,
   `embeddedImages.url`, and (missing) the asset page. One `client.urls`
   namespace: `asset(oid)`, `attachment(id)`, `embeddedImage(id)`.
10. **What is fine and should not move.** `page` shape; `Ref` as the one
    relation shape; `with` variables for user text; reads that throw on a
    failed query; guard/receipt semantics; `TypeCache` sharing; the
    doc-comment density on public types. Spec 000 stays the gate.

## Review 2: Capabilities consumers need

Checked against meta.v1's actual document (`metamodel.json`) and the code.

1. **Asset type metadata — half there.** `schema.load(type)` already gives
   each attribute's `AttributeType`, `IsRequired`, `IsReadOnly`,
   `IsMultivalue`, `RelatedAsset`, `DisplayByAttribute`, and the type's
   `Operations`. Missing: allowed values for a list relation (`Status` →
   rows of `StoryStatus`, which is a `List`: `Name`, `Order`, `Inactive`,
   `SelectedInSchemes`; the right rows depend on the project's scheme),
   and what an operation takes (meta names only a `Validator` attribute
   per operation, `CheckQuickClose`; argument shapes are not in meta and
   must be documented by hand). Build `schema.describe(type)` (attributes
   grouped: required, writable, relations with their value type, custom)
   and `lists.values(type, attribute, { scope })` that resolves the scheme.
   Consumers: slack (Gap 1), CLI (Refinement 3), rooms forms.
2. **Type discovery — only the 7 MB read.** `meta.metamodel()` is the
   single listing; `AssetTypeName` is compile-time only. Rooms loads
   per type with ETag revalidation; the transport has no `If-None-Match`.
   Build `schema.types()` (token, DisplayName, Abstract, Base) from a
   seeded metamodel, a `download:metamodel`-style cache helper with ETag
   support in the fetch transport, and document seeding the client with
   the committed `metamodel.json` for apps that can ship it.
3. **Conversations and expressions — types only.** Generated types exist;
   the batch service knows a Conversation has no `Delete` (the server
   removes it with its last Expression) and `Expression` has one. No
   service; issue #37 (2017) is the same pain in the old SDK. Build
   `conversations`: `post(asset, content, { mentions, inReplyTo })`,
   `thread(asset, page)`, `reply(expression, content)`, `remove(expression)`,
   with `client.me()` for `Author`. Verify live what `AuthoredAt` and
   `Mentions` accept. Consumer: slack (thread sync, summary comments);
   rooms shows conversations today.
4. **Search — building blocks exist.** `find`/`findin` on `QueryBody` and
   rest-1 `ReadParams`; spec §5 records full-text index lag. Add
   `client.search(text, { types, scope, page })` over `find` with a
   documented caveat (a just-created asset is not indexed yet), and a
   duplicate-candidate helper that ranks by name similarity client-side.
   Consumer: slack (Gap 8).
5. **Webhooks — nothing.** The bot handles its webhook notification
   itself. Survey its handler and the Agility webhook/subscription
   payloads live before designing; then a `webhooks.parse(body)` that
   yields `{ event, oid, type, changes }` and a verified fixture per
   event. Smallest consumer count; last.
6. **Asset links — nothing.** Review 1.9. Take gh-v1's `permalink`
   implementation (`assetdetail.v1?oid=`), verify it opens on
   `v1sdktesting`. Three consumers; first.

## Review 3: Agent-friendliness

1. **Doc comments: present and dense** on every public type and method,
   with live-verified behaviours dated. Keep; add `@example` blocks to
   the dozen entry points agents reach first (`query`, `send`,
   `sendGuarded`, `batch.run`, `resolve.numbers`, `attachments.add`).
2. **Examples: one, in the README.** Add `examples/` (runnable against
   `V1_URL`/`V1_ACCESS_TOKEN`, each under a minute, fixtures named
   `sdk-integration …` and deleted): paged query with sub-selects, create
   with relations, guarded update, batch with receipt and reverse,
   attachments, a comment, browser cookie auth with `onUnauthorized`, a
   server with one `TypeCache` per instance, error handling by `kind`.
3. **Failure messages: mostly specific.** Gaps are in Review 1.4 (kinds,
   violation tokens). The CommandFailureError message already reads like
   the server's words, root cause first; keep.
4. **A guide for agents.** The consumer repos use `AGENTS.md`; this repo
   has none, and `.claude/` holds only settings. Write `AGENTS.md`
   (how to read spec 000, the two test tiers, where writes may go,
   "values travel as `with` variables") and a consumer-facing skill
   (`skills/agility-sdk/SKILL.md`, publishable) that teaches the model
   API, the error kinds and the five examples above. Consider a generated
   compact API summary (from `dist/index.d.ts`) for context windows.

## Review 4: Quality and release

1. **Coverage, per module** (unit / integration tests): assetApi 15/6,
   batch 14/6, attachment 14/2, guard 8/4, queryV1 8/4, resolve 7/2,
   translate 7, select 8, loc2 6/2, fetchTransport 6 + auth 8, schema 5/2,
   rest1 5/3 (history: one each), meta 4/0, typeCache 3, oid 4, cjs 2,
   layers 3, generate-types 4. Thinnest: rest-1, meta, the client's own
   composition (`client.ts` is exercised only through other suites), and
   the transport's retry/5xx path live. Add: a client suite (ensureFor
   before every read, `withSignal`, option spellings), rest-1 history and
   `needTotal`, meta error shapes, and recorded responses for the awkward
   cases spec §2a lists (dropped result slots, `NULL` relations, group
   rows, state `200`). Add `scripts/record-fixture.mjs` so a fixture is
   captured, not typed. Run the integration tier on a schedule (weekly,
   environment-gated secrets) so live drift shows up before a consumer
   does.
2. **Versioning policy — write it down.** Today: alphas on the `alpha`
   dist-tag, README says "may change between them", no CHANGELOG. Policy:
   every alpha has a `CHANGELOG.md` entry with a migration line per
   breaking change; `1.0.0` after rooms D1–D2 are merged; semver after
   that; a renamed export keeps its old name as a `@deprecated` alias for
   one minor; the breaking batch below is the last planned one before
   `1.0.0`.
3. **Upgrading consumers.** gh-v1 re-vendors on a pin change
   (`npm run vendor:sdk`, hash-checked); the bot and rooms pin exact
   versions. The breaking batch therefore ships as one alpha (`alpha.3`)
   with a handoff per consumer, and rooms starts D1 on it, never on
   `alpha.2`.
4. **Publishing — done.** npmjs under `@versionone/agility-sdk`, trusted
   publishing from a `v*` tag, staged and approved with 2FA (plan 001
   A6, #53–#54). Nothing to decide.

## Sequencing

1. **Findings pass** — this file. Read-only, done 2026-11-12.
2. **Breaking batch → `1.0.0-alpha.3`** — done and published 2026-11-12
   (`alpha` dist-tag; tag `v1.0.0-alpha.3` at `071f0d5`), one release
   before rooms D1: Review 1.1 (Outcome from `send`), 1.3 (one query
   shape; `client.query` the default read path, rest-1 behind `data`),
   1.4 (error kinds, `UsageError`, parsed violations; spec 000 §7), 1.5
   (`queryPage`/`pages`/`all` on the client), 1.6 (`get`, `me`), 1.9 and
   2.6 (`urls`), 1.2 (typed `from`/`select`). 1.8's verb review kept the
   existing names: the only renames are the read path and the URL
   builders, each with a deprecated alias for this alpha. `CHANGELOG.md`
   carries the migration lines; handoffs: `plans/handoffs/alpha-3-gh-v1.md`
   and `plans/handoffs/alpha-3-k6i-agility-slack-bot.md`, started
   2026-11-14 as sessions `session_016NSWj9RUo5RDw3AvSzQbUd` (gh-v1) and
   `session_016NSWj8xjTv47UXheToZpGg` (slack bot, against `main`:
   `bolt-migration` is merged).
3. **Rooms D1 on `alpha.3`.** Plan 004's first decision (rest-1 writes,
   Copy, `New/{T}`) and the live friction list from writing rooms' top
   flows (board load, status change, attachment, conversation) come back
   here as a second findings pass.
4. **Capabilities, by consumer count:** `urls.asset` (in step 2) →
   `schema.describe` and `lists.values` (slack, CLI, rooms) → conversations
   (slack, rooms) → search (slack) → ETag and `schema.types()` (rooms) →
   webhooks (slack; survey first).
5. **Agent and docs track, alongside:** `AGENTS.md`, examples, the skill,
   `@example` blocks, CHANGELOG discipline.
6. **Quality track, alongside:** client suite, rest-1/meta tests, fixture
   recorder, scheduled integration run.

## Findings from the adoption sessions (the second pass)

**agility-rooms, 2026-11-14** (live on v1sdktesting, alpha.3; plan 004's
first decision). Rooms' rest-1 writes are 6 attribute posts, 2
`?op=Copy`, 1 `New/Timebox?ctx=` template read, and 2 plain reads.

1. **Attribute posts: covered.** `update` with `{ add }` / `{ remove }`
   on a multi-value relation and a scalar set or `null` clear do what the
   posts do; `client.get` reads it back. Rooms moves them to
   `client.assets.send` in D2. No SDK change.
2. **Copy: api/asset discards the result.** `execute: "Copy"` performs
   the copy but the envelope reports only `assetsOperatedOn: [source]`;
   `assetsCreated` is empty and `args: { Name }` is ignored, so the new
   OID is unobservable. rest-1 `?op=Copy` answers `{ id: "Story:…:…" }`.
   Querying "newest by CreatedBy" is a race, and CreateDate is stamped in
   instance-local time, so a since-now filter misses it. **Requested:** a
   narrow rest-1 operation path, `client.data.operate(oid, "Copy")`
   answering `{ oid }` momentless (or `client.copy(oid)`): the one POST
   whose return value api/asset drops, not a general rest-1 write path.
3. **`New/{T}?ctx=`: no api/asset equivalent.** The template carries
   server-computed defaults nothing else exposes (next sprint name,
   dates after the schedule's last timebox, Schedule, State, Owner);
   `assets.preview` echoes the command and meta.v1 carries no defaults.
   **Requested:** `client.data.template(type, { ctx })` (GET, idempotent),
   answered like `data.get` (Refs, translated scalars, `act` wrappers
   dropped). One rooms site uses it.
4. **Reads: covered** by `client.data.list` / `data.get` / `client.get`.
   Observation: a rest-1 row spells a nested select twice (`Parent: {
   _oid, Name }` and `"Parent.Name"`), which `client.get` does not. That
   is `fromAssetDocument`'s documented fold; worth deciding whether the
   dotted key should go once rooms is on `client.get` (Review 1.3).

Decided 2026-11-14 (Jim): grow the two narrow rest-1 paths. Done in
alpha.4 as `client.data.operate` / `client.copy` and
`client.data.template`. Read in Core (`versionone/Core`, attached to the
SDK session read-only that day): rest-1's `New` is
`NewAssetQueryProcessor` → `Services.GetNewAsset(assetType, ctx)`, which
builds a `CandidateAsset` and runs the type's registered
`IAssetInitializer.InitializeNewAsset(asset, context, …)` (Meta.xml's
`<Initializer>`; `TimeboxInitializer` is what names the sprint and dates
it); a type without one gets only its primary relation to the context's
type set, which is why a Story in a Scope gets just `Scope`. api/asset's
`ctx` on a create applies the same initializer but does not echo the
values. The docs page is `apis/rest-1/new-asset-templates` in
`digital-ai/docs-agility-api`.

**Fields for a form, 2026-11-14 (Jim):** required, visible and important
attributes given an asset's Scope. Three sources, now one call,
`client.fields.describe(type, scope)`: meta's `IsRequired` (writable
attributes), `api/visibleFields?scopeOid=…&assetTypeToken=…` (both keys
repeat; one entry per type; custom fields once configured; a global
type ignores the scope and mixing global and non-global is 400 — Core's
`DisplayedFieldsController`, docs `apis/field-visibility/visible-fields`),
and `Scope.Scheme.ImportantFields` (a multi-value Text of attribute
tokens — selecting it with a sub-select, as if a relation, crashes the
server with a NullReferenceException) with `Scheme.IsRequiredAtClose`.
`api/visibleFieldsByAsset?oidToken=` answers 500 for an asset of a
global type (a Member) on v1sdktesting; `api/customFields` is a POST.
Not yet covered: the "required at close" enforcement details
(`ImportantEnforcementController`) and `api/customFields`; the testing
instance's schemes name no important fields, so that path is proven on
shape only.

**Totals (Jim, 2026-11-14):** api/asset reports the total of a paged
query (`needTotal`) beside the rows; query.v1's response is a bare list
of row lists with nowhere to put it. That was a reason consumers routed
reads through api/asset. The client keeps both: `query` on query.v1 for
rows, `queryPage` on api/asset for a total; `pages`/`all` stop at a short
page and need no total. The client's doc comment says so.

**gh-v1, 2026-11-14** — on alpha.3 in versionone/gh-v1#64 (175 tests,
typecheck, live smoke; CLI output unchanged). Nothing in gh-v1 caught
`TypeError` or read more than one page, so `UsageError` and `client.all`
had nothing to replace there. Seven findings:

1. **`parseViolation.tag` on the token spelling** gave the token
   (`Link.Asset`), which is not a loc-2 tag. Fixed: null there.
2. **`urls.asset` takes only an OID**; the CLI links by Number
   (`assetdetail.v1?Number=S-1`), the readable form every command prints,
   so it keeps its own builder. Done in alpha.4: `urls.asset` takes
   either (docs `apis/asset-permalinks`: both forms 302 to the detail
   page; a signed-out reader lands there after login).
3. **The npm package shipped no CHANGELOG**; migration lines had to be
   read off the deprecation notes in `index.d.ts`. Fixed: `files` includes
   it.
4. **A rejected query surfaces differently** on the new read path: an
   `ApiError` kind `invalid`, code `QUERY_REJECTED`, `details` the whole
   error document, where api/asset gave a `CommandFailureError` whose
   message was the token. A caller that prints `details` now prints a
   JSON blob; `message` already holds the server's sentences. Add the
   migration line (alpha.4) and consider trimming `details` to the
   exceptions.
5. **`queryV1` is the deprecated name while `client.query` is what goes
   to query.v1**, and the deprecation note on `assets.query` says "read
   through query.v1", which reads as pointing at `queryV1`. Sharpen the
   notes (alpha.4).
6. **`CommandFailureDetail.echoed`** rides on every failure, so a caller
   that serialises failures gets the echoed body; gh-v1 re-maps. Note it;
   maybe make it lazy or optional later.
7. **"Retried like a GET" needs `retries > 0`**, which defaults to 0; the
   doc comment on `client.query` promises a retry the default config never
   makes. Say so in the comment, or default `retries` to 1 for idempotent
   requests (alpha.4, a behaviour change to call out).

**k6i-agility-slack-bot, 2026-11-14** — on alpha.3 in
digital-ai/k6i-agility-slack-bot#63 against `main` (175 tests, typecheck,
live smoke: mention resolve, find, createWithNumber, update,
QuickClose/Reactivate, a Required violation, a UsageError; fixtures
deleted by OID). The deprecated aliases carried it; the only breaking
surprise was envelope → Outcome in writes (7 tests, all where expected).

1. **CHANGELOG not in the tarball** — same as gh-v1's 3; fixed.
2. **Asset URL by Number** — same as gh-v1's 2, now two consumers: cards
   and find results link `assetdetail.v1?Number=S-01022`, what the user
   typed. First item of alpha.4.
3. **A UsageError reads like a server failure** to a wrapper that formats
   every ApiError as "Agility <op> failed: <status> <message>" (status 0).
   The bot special-cases `instanceof UsageError`. Add a doc line: `kind:
   "usage"` means nothing was sent; and consider a `sent: boolean` or
   excluding status 0 from such formats in the README example.
4. **Violation localization works** end to end (`client.localize([tag])`
   → "Project"); not yet wired into a reply.
5. **`outcomeOf` tolerates a partial envelope** (a fake sending only
   `queryResult`); the bot's fakes depend on it. Make it a stated
   contract (it is: every field is read with a default) and a test.
6. **Outcome has no `requestId`** — added in alpha.4.
7. **Testing-instance data:** `v1sdktesting` has no StoryStatus rows, so a
   Story status change cannot be exercised live there (spec §5 already
   notes the empty instance). Seed a few, or test on a Defect/Epic status.

**agility-rooms R1, 2026-11-14** — digital-ai/agility-rooms#1464
(`r1/narrow-axios-surface`, against `main`): every Agility data-endpoint
call now goes through one helper module per endpoint under `src/utils`
(api/asset, query.v1, rest-1 with `executeCopy` and
`getNewAssetTemplate`, meta with ETag, loc-2, embedded images); the
`/api/asset` interceptor gap is fixed. D1 keeps `executeCopy` and
`getNewAssetTemplate` on rest-1 through the transport adapter until
alpha.4 is on npm, then moves them to `client.copy` /
`client.data.template`. Flagged early for D1: rooms re-parses the
metamodel only when meta.v1's ETag changes; `client.meta.metamodel()`
cannot surface that header today, so rooms either keeps its own meta
instance for that one read or the SDK grows `meta.metamodel({
ifNoneMatch })` answering `{ metamodel, etag }` and null on 304 (Review
2.2's ETag item, now concrete; alpha.5).

**alpha.5, started 2026-11-14** with the ETag-aware schema reads rooms
asked for. Live: meta.v1 sends one strong ETag for the whole schema
(release plus a change stamp), identical on the document, a type and an
attribute; `If-None-Match` with the exact tag is a 304 with no body (a
weak form is not matched); Cache-Control is public, max-age under an
hour. Core sets the same kind of tag on loc-2 (`BaseLocalizationHandler`),
a later item. Shipped: `client.meta.read` / `readType` (`{ value, etag }`
or null), `client.meta.etag()`, `TypeCache.etag`,
`client.schema.revalidate()`, and `RequestOptions.acceptNotModified` on
the transport. The three leftovers followed the same day: `retries`
defaults to 1 for idempotent requests, a rejected query's `details` are
the exceptions alone, and `echoed` is readable but not enumerable on a
failure.

**alpha.4 (2026-11-14)** — published the same day (`latest` and
`alpha`; tag `v1.0.0-alpha.4` at `f77e8d5`), smoke-tested from a fresh
consumer against v1sdktesting (copy, template, fields, Number URL,
requestId, CHANGELOG in the tarball) — carries all of the above that was marked
alpha.4, plus the two rest-1 paths and `client.fields`. Still open from
the lists: trimming `QUERY_REJECTED` details, `echoed` on every failure,
defaulting `retries` for idempotent requests.

## Open questions, with answers where the code gives one

- **Least polished today:** rest-1 (reads only, its own parameter
  spelling, thinnest tests), meta/schema discovery (no listing short of
  the whole document, no ETag), the client's composition (untested on its
  own), and the three absent capabilities (conversations, webhooks,
  links).
- **Low-level and high-level, or one?** Both already ship from one entry.
  Recommendation: keep both; the model API is the main entry, the wire
  layer moves to `@versionone/agility-sdk/wire` and is documented as the
  passthrough and transport-author surface. Decide in step 2.
- **Auth and configuration across consumers:** `ClientConfig` takes
  `accessToken` (Bearer; gh-v1 from env or `~/.v1config`, the bot per
  workspace), `authorization` (a ready header; Basic on dev instances), or
  cookie `credentials` with `onUnauthorized` and `unauthorizedStatuses`
  (rooms, SSO popup). A server building a client per user shares one
  `TypeCache` per instance. Not covered: OAuth refresh (the bot's Flow 4
  stays in the bot) and ETag caching. Enough for the three consumers;
  document it in one place.
- **Who else** (answered 2026-11-12): the Agility MCP server is Python, so
  not a consumer; this SDK is the reference for updated Python bindings
  (its layers, one-shape model, error kinds and guard are the parts worth
  carrying over). Nearer-term TypeScript surfaces: a Microsoft Teams app
  and a VS Code extension, both shaped like the slack bot (token per
  user, one `TypeCache` per instance) and the CLI respectively; a Claude
  mod is possible. Also ossum-ui (named in `src/types/oid.ts`), Core's
  gulp `v1api` helper, and any customer integration now the package is
  public.
- **An API console is a surface too**, and a demanding one: it would
  exercise the schema service, the error kinds and the typed query shape
  directly, and surface gaps faster than an app with a fixed set of
  queries. Two pieces exist: `src/wire/select.ts` resolves select paths
  hop by hop against meta (dotted paths, downcasts, filters, aggregates),
  which is the seed of a type-ahead for `select`; and api/asset's
  `previewOnly` with `sendYaml` parses a batch server-side. The `filter`
  grammar is not parsed client-side at all. A browser-safe parser for both
  grammars (`V1Query.g` as the docs publish it), driven by meta, with
  completion of attributes, operators and list values, is a candidate
  module (`services/grammar`, say) that the console, rooms' query builders
  and the typed-query work would share. Add it to Review 2 as 2.7 once a
  first consumer commits to it.
- **The committed metamodel was behind the hosted instance** — refreshed
  2026-11-12 to meta.v1 26.3.1.13 (from `v1sdktesting`; the diff was
  three Workflow types and four attributes, nothing removed). The
  download script now strips instance-specific definitions and reports
  them, so the pull is reviewable from a hosted instance as well as from
  a dev instance on a blank database (Core's gulp task). Refreshing is a
  step of each release; the README names the version. Custom list types (`Custom_<Name>`, Base List) and custom
  attributes (`Custom_…`, and `ReciprocalOf_…` on a custom relation's
  target) are instance-specific by design and handled without generation.
- **Still open from #51:** an exact guard stamp (Moment is not one;
  ChangeDate as a literal is). Not blocking; the guard works.

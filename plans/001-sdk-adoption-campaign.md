# Plan 001: TypeScript SDK campaign and adoption

A parallel campaign, run from a cloud agent session on this repo, alongside
daily work. Goal: take `@versionone/sdk` from a verified starter (layers,
api/asset + rest-1 + meta.v1 wire modules, schema-driven translation, 49 unit
tests green) to a package that three surfaces depend on:

| Surface | Repo | Kind | Pace |
|---|---|---|---|
| CLI | `versionone/gh-v1` | Node CLI | first |
| Messaging | `digital-ai/k6i-agility-slack-bot` | Slack app (Node 24, plain ESM JS) | first |
| Rooms | `digital-ai/agility-rooms` | React/Vite SPA, same-origin cookie auth | slow, later |

The SDK's goal is one abstraction around every part of changing an asset —
its attributes, its relations, its operations, and the files attached to
it (attachments, embedded images) — so no consumer talks to an endpoint
directly for any of them. gh-v1 (`gh v1 attach`) and agility-rooms both
handle attachments today, each on its own.

Specs (`specs/`) hold invariants; plans (`plans/`) hold sequencing and are
allowed to go stale once done.

Reference: the Agility API documentation is public at
https://docs.digital.ai/agility-api/ (as of 2026-11-04). Cite it in specs
and handoffs in place of the older GitHub Pages copy. It is not reachable
from the cloud environment (allowed 2026-11-04); `llms-full.txt` there is
the whole site as one text file, the fastest way to check a claim. Live
behaviour is still settled by the integration tier.

Findings from the testing instance worth carrying into later milestones:

- api/asset answers a body it cannot parse with **400** and one message
  in `Exceptions` (changed 2026-11; the docs' errors page says so). The
  transport reads that shape into `ApiError.message`.
- A value containing an em dash (—) fails as a `filter` literal and in
  `where` (`Invalid QueryFilter2 token …`), while `é` passes; the same
  value as a `with` variable (`Name=$n`) works. Services that build filters
  from user text (A5 `resolve`, gh-v1's `--filter`, the bot's search) should
  pass values through `with`, not splice them into the filter string.
  Possibly a server bug worth a defect.
- A failed query's slot is **dropped** from `queryResult.results` (later
  ones shift up); the docs promise only that empty matches keep theirs.
  `send` now restores the slot as `null`. Worth a line in the docs'
  Queries page. Consumers that index results positionally after a partial
  failure (the bot's `results[2]`, rooms' `getApiResults`) are exposed
  until they move to the SDK.
- Number roots differ from gh-v1's hand list: Epic, Theme and TestSet are
  Workitems now (resolved by the Workitem query); Milestone, Okr
  (KeyResult, OkrObjective), OkrSession, Environment, Grant and
  ExternalActionInvocation carry numbers too. Grant has no Name and
  ExternalActionInvocation neither Name nor AssetState. `resolve` derives
  all of this from the metamodel, under test.
- Number matching is case-insensitive on the server.
- **ChangeDate as a `with` variable never compares equal** — not even the
  value just read back — while the same value as a filter literal does.
  The guard therefore splices ChangeDate as a literal (after a strict
  timestamp check); gh-v1 already did, which is why its guard works. A
  likely server defect, alongside the em-dash one.
- **`Moment=` in a filter is an as-of selector**, not a comparison: an
  earlier Moment of the asset matches and returns the asset as it was
  then, and an update scoped by it lands on the current asset. Never use
  Moment as a compare-and-set stamp.
- Preview projects even a scalar update in add/remove form
  (`Estimate: { add: ["2"], remove: [] }`); sent back as a real update, it
  applies.
- A StoryStatus create requires `RollupState` (`"Active"` and `64` both
  accepted).
- An api/asset update that gives a multi-value relation as a plain list
  **adds** to it (like rest-1's `act: "add"`); it does not replace the list
  (slack bot, 2026-11-07).
- **Agility refuses to Delete a closed asset**
  (`Violation'AssetCannotDeleteClosed`); reactivate first. The batch
  service's reverse does this (`reversible` reports `reactivated`), and the
  guard sends a second command on one asset as a second pass.

## What the consumers do today (surveyed 2026-11-04)

**k6i-agility-slack-bot.** Every Agility call goes through one seam,
`lib/v1api.js` (axios, Bearer token, a 401 interceptor that calls
`authenticationFailureHandler` to restart setup). It uses five endpoints:
`query.v1` (most reads, query bodies in `lib/queries.js`), `api/asset`
(bulk, `execute` QuickClose/Reactivate), `rest-1.v1` (create and update with
the `Attributes` envelope via `lib/transformDataToAsset.js`; `findAssets`
reads with `find`/`findin`/`page`), and `loc-2.v1`. Its `AGENTS.md` already
plans for this: the Bolt migration's Phase 2 rewrites the seam as
`services/v1.js` on native `fetch` "so it can migrate into `@versionone/sdk`".
It hand-decodes string scalars in 3 places (`"Team.HasProcess" === "True"`,
`IsKanban.toLowerCase() === "true"`) — exactly what spec 000 §2a removes.

**agility-rooms.** `src/utils/axios.tsx` builds a same-origin axios instance
(`X-Requested-With`, cookie auth, an `axios-auth-refresh` interceptor that
opens the SSO login popup on 401/403 and retries, a response interceptor
that turns api/asset `commandFailures` into a localized snackbar and a
thrown error). `src/utils/bulkApiService.tsx` wraps query/create/modify/
remove. 67 files import axios; `api/asset` appears 96 times, `query.v1` 29,
`meta.v1` 20, `rest-1.v1` 5, `loc-2.v1` 3, plus a few `*.mvc` routes. It
hand-decodes string booleans in 48 places (including `getApiResults`
patching `IsReadOnly`), and `src/metaAssetStore/` keeps its own per-type
field knowledge that overlaps the SDK's `schema` service.

Re-surveyed 2026-11-07 at `main` `0874590` (read-only):

- **HTTP.** One default axios instance (`src/utils/axios.tsx`) plus
  `getAxiosInstance(...)` variants, a bare `meta` instance and a plain
  `axios.create` in `src/navigation/routes.tsx`; several skip the
  auth-refresh and snackbar interceptors. 88 production files import axios.
  Cookie auth only. On 401/403 an SSO popup (`Account.mvc/Login`), then
  replay. Cancellation by `AbortController` in a few places; no retries.
  The commandFailures snackbar runs only when the URL is exactly
  `/api/asset`; 9 calls written `api/asset` (no slash) bypass it.
- **Endpoints.** api/asset (111 call sites, 57 files), query.v1 (16),
  rest-1.v1 reads (4) **and writes** (5 `Data/{T}/{id}` posts with
  `{ Attributes: { X: { value, act } } }`, plus 2 `?op=Copy`), meta.v1,
  loc-2.v1, `loc.v1`, `config.v1`, `attachment.img`, `embedded.img`,
  `EmbeddedImage.mvc/Upload`, about 15 other `*.mvc` routes and about 20
  custom `api/*` routes (reports, tags, watch, rooms2config, LLM).
- **Writes.** `metaAssetSlice` updates multi-value fields as
  `{ X: { [value]: "add" | "remove" } }`, sends a cleared relation as
  `"NULL"`, updates optimistically and reverts on error. Execute ops with
  and without `args` (Convert). No change comments, no ChangeDate checks.
- **Reads.** 34 explicit pages, but some board and `ID=$Oids` reads are
  unbounded. Positional `results[n]` with index constants
  (`metaAssetStore/constants.ts`). No `group` queries.
- **Decoding.** 46 `"True"`/`"False"` comparisons; `NULL_OID` referenced
  118 times; `massageApiAssetResponseObject` unwraps single relations by
  meta. meta.v1 is loaded by `store/metaDefinition/useMetaDefinitionStore.ts`
  (per type, in-flight dedupe, ETag revalidation), not by `metaAssetStore/`.
- **Tests.** Jest (222 files) mocks modules; no MSW. The AI domain's
  injected `IHttpClient` / `FakeHttpClient` is the cleanest seam for a swap.
  Playwright (79 specs) runs against a live server, including attachment CRUD.

**gh-v1** (surveyed 2026-11-04 at `41fe333`). A `gh` extension in plain
CommonJS Node (≥20), no runtime dependencies, `node --test` with 99 passing
tests. One seam, `lib/api.js` (native `fetch`, `Authorization` header from
config), required by 22 modules. It is already the SDK's design in JS form:

- `query`/`queries` over api/asset with a default page on every query;
  `asset` throws on `commandFailures` with the failures kept structured
  (`err.failures`); `attempt` tolerates them and reports each by
  `sourceCommandIndex` — this *is* gap 4 below, already proven.
- `rest` flattens rest-1's `Attributes` and refuses a read without a page
  (what `src/wire/rest1.ts` already does); `meta` and `localize` (loc-2.v1);
  `blob` get/post for attachment.img; `raw` for the `gh v1 api` passthrough.
- `lib/resolve.js` — numbers → assets: one bounded `Workitem` query for
  every number, then one rest-1 `BaseAsset` read with type-qualified wheres
  for the non-workitem numbered types; plus room and project-path lookup
  with interactive disambiguation (`lib/prompt.js`).
- `lib/batch.js` — the receipt pipeline behind `gh v1 bulk`/`apply`:
  preview (projection), hydrate, before-snapshot, **`guarded()`** (each
  projected update/execute rewritten as a query-scoped command filtered on
  `ID` and the snapshot's `ChangeDate` — a per-request compare-and-set, the
  "guard" spec 000 §6 means), send, and a best-effort reverse batch.
- `lib/guard.js` is CLI policy for `gh v1 api` (endpoint allowlist,
  unbounded-request detection, secret redaction) — not the §6 guard.
- It also hand-decodes string booleans (`isTrue` in `api.js`, `meta.js`,
  `resolve.js`, `board.js`) and keeps its own `momentless`/`oidOf`.

So gh-v1 is the *source* for A2, A5 and parts of A3, and the most natural
first consumer: same runtime, same `fetch`, no framework migration in
flight.

## Gaps the consumers expose in the SDK

Found by reading the code above against `src/`:

1. **Browser auth.** The transport has no `credentials` option and no way
   to send same-origin cookies; rooms needs `credentials: "include"` (or
   `same-origin`) and `X-Requested-With`. (The 2.x SDK had `withImplicitAuth`
   for this.) `defaultHeaders` covers the header; credentials is missing.
2. **Auth-failure hook.** Both consumers react to 401 (slack: re-run setup;
   rooms: SSO popup, then retry). Transport needs an `onUnauthorized`
   callback that can resolve "retry once" or "fail" — without breaking §6
   (a retried api/asset write is still never automatic).
3. **Cancellation.** No caller `AbortSignal` on `RequestOptions`; rooms
   cancels in-flight requests on navigation.
4. **Command failures.** api/asset returns 200 with `commandFailures`.
   Rooms treats any failure as an error; slack ignores them. The SDK should
   return failures typed (it does) and offer `throwOnFailure` producing an
   `ApiError` subclass carrying `sourceCommandIndex` per failure.
5. **Missing wire modules** named in spec 000 but not built: `loc2` (both
   consumers), `queryV1` (slack's main read path), `attachment`/
   `EmbeddedImage` (rooms). `queryV1` is built (2026-11-06) and kept on
   purpose even though api/asset can run the same queries: query.v1 is
   read-only by construction and answers with rows alone, so it is the safe,
   simple place to explore a query (and its requests may be retried).
6. **rest-1 writes — not needed.** Settled from the docs
   (apis/asset-bulk/updating-assets, creating-assets): api/asset carries a
   change comment as `ChangeComment` inside an update's `update` node, or
   at the root of a create command; `execute` commands cannot carry one.
   So the bot's `update(oid, data, comment)` moves to api/asset and the SDK
   grows no rest-1 write path.
7. **Services.** `resolve` (number → asset), `guard` (ChangeDate
   compare-and-set), `batch` (preview/snapshot/receipt/reverse) — port from
   gh-v1's `resolve.js` and `batch.js`, minus the prompting and file I/O,
   which stay in the CLI.
8. **Distribution.** No CI in this repo, no publish target, version 0.1.0.
   Source is browser-safe already (no `node:` imports, no `Buffer`).
9. **CommonJS consumers — done.** `test/unit/cjs.test.ts` builds the CJS
   bundle, installs it as `node_modules/@versionone/sdk`, and has a plain
   `.cjs` script `require` and use it. The exports map now gives each
   condition its own types (`.d.cts` for require), which a CJS caller
   type-checking with NodeNext (gh-v1 after G2) needs.

## Track A — SDK (this repo, this session)

Each milestone is one commit series on `proposed_type_script_api_version`,
`npm run verify` green, spec updated in the same commit where an invariant
moves.

- **A1 Transport for real callers** — gaps 1–3: `credentials`,
  `onUnauthorized` (retry-once semantics, idempotency rules unchanged),
  `signal`. Unit tests with the fake fetch. Unblocks rooms and slack auth.
- **A2 Command-failure ergonomics** — gap 4: `CommandFailureError`,
  `send(..., { throwOnFailure })`, `sourceCommandIndex` preserved.
- **A3 loc2 wire module** — gap 5, smallest consumer-shared endpoint.
- **A4 Slack-shaped reads** — done: a `queryV1` wire module and
  `client.queryV1.query`/`queries`, rows translated through the same
  schema as api/asset (the integration tier proves both endpoints give the
  same rows). The bot keeps query.v1 for its reads. (No `rest1` writes:
  gap 6 is settled.)
- **A5 Services port** — gap 7. `services/resolve` first (gh-v1's
  `resolveAssets`; slack's `queryForAssetByNumber` needs it too), then
  `services/guard` (`guarded()`), then `services/batch` (preview, describe,
  snapshot, reverseOf — a receipt as data; writing it to disk stays in
  gh-v1). gh-v1's tests for these move with them, rewritten against recorded
  responses.
- **A6 CI and packaging** — GitHub Actions running `npm run verify` on PRs;
  publish prereleases (`0.x`, `next` tag) to GitHub Packages under the
  `@versionone` scope (or npmjs — decision below). Until then consumers pin a
  git SHA or a tarball from `npm pack`.
- **A7 Attachments and embedded images** — gap 5's `attachment`/
  `EmbeddedImage`, as part of the asset-update abstraction, not a side
  channel. Two consumers to serve: gh-v1's `gh v1 attach` (list, get, add,
  put) and agility-rooms' attachment handling (survey it first: where it
  uploads, which `*.mvc` routes it uses, how rich text embeds images).
  Shape, from the docs and gh-v1's working code:
  - wire: `attachment.img/<id>` (and the embedded-image endpoint) — bytes
    in and out, addressed by the numeric id, not the OID token; a body as
    `Uint8Array`, `Blob` or `FormData` so it works in Node and the browser;
    the endpoint's statuses (404 missing, 413 too large) as typed errors.
  - service: `client.attachments.list(asset)` (metadata only — never
    select `Content` across many: it Base64s every blob into one
    response), `get(id)` → bytes + content type, `add(asset, bytes,
    { filename, contentType, name, description })` as the docs prescribe
    (create the Attachment with empty `Content`, then POST the bytes; on a
    failed upload, report the created-but-empty asset rather than hide it),
    `put(id, bytes)` to replace.
  - batches: an Attachment create inside `assets.send`/`batch.run` stays an
    ordinary create; the bytes are a second step the service owns, and a
    receipt's reverse deletes the asset.
  Integration tests on v1sdktesting with `sdk-integration` fixtures,
  deleted by OID.

  Verified live (2026-11-07): an Attachment create **requires** `Content`
  (empty is allowed; absent is `Violation'Required'…'Content'`); Base64
  `Content` in the create stores the bytes in one request; `attachment.img`
  GET answers the bytes with their type and `Content-Disposition`, 404 when
  missing, and POST replaces them. `EmbeddedImage.mvc/Upload` accepts token
  auth and answers `<textarea>{"Url":…,"Key":"EmbeddedImage:<id>"}</textarea>`.
  **An EmbeddedImage cannot be deleted** (`Unknown Operation
  'EmbeddedImage.Delete'`), so its live test is opt-in
  (`SDK_TEST_EMBEDDED_IMAGES=1`) and leaves one image per run.

  What rooms does today (survey 2026-11-07), which A7 must cover:
  - **Upload** is one api/asset create with the bytes inline: `{ AssetType:
    "Attachment", Asset, ContentType, Filename, Name, Content: <Base64> }`
    (`MultiValueRelations/Attachments.tsx`). The UI caps a file at 4 MB and
    has no 413 handling. So `add` needs both modes: inline Base64 for small
    files (one request, what rooms does) and create-then-POST-bytes for
    large ones (what the docs and gh-v1 do), chosen by size.
  - **Preview** of an image re-reads `Content` for one row and builds a
    `data:` URL; **download** opens `attachment.img/<id>` from the app root.
    So `get` returns bytes and type, and the service exposes the
    `attachment.img` URL for a browser to open.
  - **Delete** is `execute: "Delete"` on the Attachment.
  - **Embedded images** (TinyMCE paste) post multipart to
    `EmbeddedImage.mvc/Upload` with fields `image` and `oidToken`; the
    answer is HTML with `<textarea>{ "Url": … }</textarea>`. Stored HTML
    references `embedded.img/<id>`, rewritten to app-root URLs. So:
    `embeddedImages.upload(asset, blob)` → `{ id, url }`, parsing that
    response, and a helper that normalises `embedded.img` URLs.

## Track B — k6i-agility-slack-bot (fast, on `bolt-migration`)

Target branch: `bolt-migration`, not `main`. There, Bolt Phase 2 has already
replaced the axios `lib/v1api.js` with `services/v1.js` —
`createV1Client({ url, accessToken })` on native `fetch`, throwing
`AuthFailureError` on 401 (caught by `withV1()`, auth Flow 4) — and its
tests (`test/v1-service.test.js`) stub global `fetch` exactly as gh-v1's do.
So the SDK swap is internal to `createV1Client`; listeners do not move.
The 401 mapping is a `catch (e) { if (e.status === 401) throw new
AuthFailureError(...) }` around SDK calls, so **B does not need A1**.

Calls the client still makes on `bolt-migration`: `query.v1` (most reads,
bodies in `lib/queries.js`), api/asset (`bulk`, `createWithNumber`,
`exec`), rest-1 writes (`create`/`update` with `?comment=` through
`lib/rest1DataTransformer.js`), rest-1 `findAssets`, loc-2.

- **B0 Pre-SDK migrations in the bot's own session** (S1–S4 under
  *Consumer migrations* below). They shrink what the SDK must support:
  once S2 pages every read, B1's reads move to `client.queryV1` as they
  are; A4's rest-1-writes question is closed (gap 6).
- **B1 Client swap.** `createV1Client` keeps its surface; inside, one
  `AgilityApiClient({ baseUrl: url, accessToken })`. `query` →
  `client.queryV1.queries`; `bulk`/`exec` → `client.assets.*`;
  `fetchLocalizations` → `loc2` (A3).
  `test/v1-service.test.js` stays the parity proof.
- **B2 Delete the decodes.** Rows arrive translated: `"True"` comparisons,
  `IsKanban.toLowerCase()`, `toMomentless` and positional
  `results[0][0]`/`results[2]` handling go.
- **B3 Writes.** `create`/`update` → `assets.send` (api/asset), the change
  comment as `ChangeComment` in the `update` node (gap 6);
  `rest1DataTransformer.js` is deleted.
- **B4 Number resolution.** `queryForAssetByNumber` → `resolve` (A5).

Gate per step: `npm test`, then a sandbox-workspace smoke (asset mention,
`/agility find`, backlog-item status change, webhook notification).

## Track C — gh-v1 (fast, first consumer)

Its 99 tests stub global `fetch`, so the swap can be proven without a live
instance: same requests out, same rows in.

- **C1 Seam swap.** Re-implement `lib/api.js`'s exported surface (`query`,
  `queries`, `asset`, `attempt`, `rest`, `meta`, `localize`, `raw`, `blob`,
  `permalink`) on the SDK, imported from a vendored copy of its ESM build
  (gh installs extensions without npm; see plan 002, *Dependency*). Callers
  unchanged; all tests green. Needs A2, A3 (loc2).
- **C2 Delete the decodes.** With rows translated by the schema, `isTrue`
  and `oidOf` drop out of `meta.js`, `resolve.js`, `board.js`; `momentless`
  comes from the SDK.
- **C3 Invert the services.** A5 is done, so `resolve.js` and `batch.js`
  keep only prompting, console rendering, permalinks and receipt files:
  `resolveAssets` → `client.resolve.numbers` (its `missing` drives the
  "not found — skipped" lines); `run()` → `client.batch.run` with
  `confirm` as the prompt and the receipt written as returned;
  `--reverse` → `client.batch.reversible` (+ `--force`). Two deliberate
  differences to carry over: the SDK refuses an unguardable batch unless
  `guard: false` (gh-v1 sent it as written with a note — keep that UX by
  checking `unguardable()` first), and its number roots are wider than
  gh-v1's list.
- **C4 Attachments on the SDK.** Once A7 lands, `gh v1 attach` moves onto
  `client.attachments` and `blob` leaves `lib/api.js`. `raw` stays CLI-local:
  it is the `gh v1 api` passthrough.

`lib/guard.js` stays in gh-v1: it is policy for a terminal passthrough, not
SDK behaviour.

## Track D — agility-rooms (slow)

Open questions from the 2026-11-07 survey: rooms still writes through
rest-1 (5 attribute posts, 2 `?op=Copy`) and reads `rest-1.v1/New/{T}`
templates, which gap 6's "no rest-1 writes" did not foresee; decide whether
those move to api/asset (Copy as an execute?) or the SDK grows a narrow
rest-1 write path. Its commandFailures policy should apply to every
api/asset call, not only URLs spelled `/api/asset`.

Strangler, starting below the call sites so nothing user-visible moves:

- **D1 SDK under the existing axios.** Implement a `Transport` that
  delegates to rooms' current axios instance (keeps the SSO refresh
  interceptor and snackbar). Point `bulkApiService.tsx` at
  `client.assets.*`. Rows arrive translated, so `getApiResults`' `IsReadOnly`
  patch goes. This is the whole first PR. Needs A2 for parity of the
  command-failure snackbar.
- **D2 Domain by domain.** Start with `src/domains/ai` (it already has
  adapters and architecture tests), then retire string-boolean decodes per
  feature (48 today). Jest + Playwright gate each PR.
- **D3 Native transport.** Swap the axios-backed Transport for
  `createFetchTransport` with `credentials` + `onUnauthorized` (needs A1).
- **D4 Schema convergence.** Evaluate replacing parts of
  `src/metaAssetStore/` field knowledge with the SDK `schema` service.

## Consumer migrations (run in each repo's own session)

Modernisation the consumers should adopt *independently of* the SDK, run
from the sessions already focused on those repos, not from this one. Each
is sized to one PR and has a paste-ready prompt in `plans/handoffs/`. They
are ordered so that, by the time the SDK swap (Tracks B/C/D) arrives, it is
a change of one file.

**gh-v1** (`plans/handoffs/gh-v1.md`)

- **G0 Runs anywhere.** The `gh-v1` bin is committed without its executable
  bit (`100644`), so installing the extension fails on macOS/Linux; and
  config comes only from `~/.v1config/v1api/config.json`. Fix the mode and
  accept `V1_URL` + `V1_ACCESS_TOKEN` from the environment, so cloud
  sessions and CI can run it.
- **G1 CommonJS → ESM.** gh-v1 is the one consumer still on `require`
  (`"type"` unset, `module.exports` in every `lib/` file, the `gh-v1` bin
  script). Convert to `"type": "module"`, `import`/`export`, `node:`
  specifiers, `import.meta`-based paths where `__dirname` is used. Its
  tests stub global `fetch`, so ESM conversion is provable offline. Do this
  before C1 so the seam swap is written once, in its final syntax.
- **G2 Type checking without a build.** `jsconfig.json` with `checkJs`,
  `module`/`moduleResolution: NodeNext`, `target: ES2022`, and JSDoc on
  `lib/api.js`'s surface — so SDK types flow into the CLI with no compile
  step. `tsc --noEmit -p jsconfig.json` as a test-time check.
- **G3 One page policy.** Lift the scattered `page: { size: 20, start: 0 }`
  defaults into one constant, matching the SDK's refusal of unpaged reads.

**k6i-agility-slack-bot**, on `bolt-migration` (`plans/handoffs/k6i-agility-slack-bot.md`)

The runtime is already ESM (`"type": "module"`, no `require`), so "move to
ESM" here means finishing the edges:

- **S1 Finish ESM tooling.** `jsconfig.json` still says `module: commonJS`,
  `target: es6`; set `NodeNext`/`ES2022` and turn on `checkJs` so editors
  and `tsc --noEmit` see the real module system (and, later, SDK types).
- **S2 Page every read.** Reads stay on query.v1 (read-only, simplest
  responses). Add an explicit `page` to every body in `lib/queries.js`,
  as the SDK's `queryV1` refuses an unpaged query.
- **S3 Close Bolt Phase 2.** Drop `botkit`, `botbuilder-*`,
  `botkit-plugin-cms` and `axios` from `package.json` once nothing imports
  them; delete `lib/v1api.js` and the `plugins/` Botkit modules that
  `listeners/` replaced. (AGENTS.md: "axios is dropped then.")
- **S4 Record real responses.** Replace hand-written fixtures in
  `test/v1-service.test.js` and `test/queries.test.js` with responses
  captured from the local dev instance (spec 000 §2a: fakes send what the
  server sends — api/asset spells `"True"`, not `true`).

**agility-rooms** (slow; no handoff yet)

- **R1** Narrow the axios surface: route the 67 axios importers through
  `utils/bulkApiService.tsx` and a small set of helpers, so D1 swaps one
  module. Start when Track A2 lands; write the handoff then.

## Operating model for the campaign

- **Home:** this cloud session on `proposed_type_script_api_version`. One
  milestone per request ("do A1"), each ending with verify green, a commit,
  and a push. Consumer work happens on a feature branch in each consumer repo
  (proposed: `sdk-adoption`), never on their default branches, PRs only on
  request.
- **Order here:** A2 → A3 → C1 → C2 → B1 → B2 → A5 → C3 → B3/B4 → A6 → A1 →
  A7 → C4 → D1 → D2+. A7 starts with the rooms attachment survey, so
  rooms' needs shape the module before gh-v1 moves onto it. gh-v1 first: no framework migration, and stubbed-fetch tests
  prove parity offline. A1 (browser credentials, onUnauthorized) waits for
  rooms; the bot maps `ApiError.status === 401` itself.
- **In parallel, elsewhere:** G0–G3 in the gh-v1 session, S1–S4 in the
  slack-bot session (on `bolt-migration`). C1 starts after G1 merges; B1
  after S2 and S3.
- **Hand-offs:** this session writes the prompt (`plans/handoffs/*.md`);
  you paste it into the repo's session. Results come back as merged
  commits that this session reads before starting the dependent milestone.
- **Status:** this file's checklist below is the source of truth; update it
  in the commit that finishes a milestone.

## Decisions needed

- ~~Publish target~~ — decided 2026-11-07: public npmjs, as
  `@versionone/sdk` (the `@versionone` org already publishes there), starting
  at `1.0.0-alpha.0` on the `alpha` dist-tag so `latest` is never a
  prerelease. Not `v1sdk` 3.x: the 2.x package (`v1sdk`, last published
  2022) stays as it is, because a new major of the same name would imply a
  compatibility this SDK does not aim for. Publishing needs an `@versionone`
  org owner to set up a token or trusted publisher.
- Dependency audit before the first publish — done 2026-11-07: no runtime
  dependencies, and the built bundle imports nothing. `npm audit` found 13
  issues, all in dev tooling (vitest/vite, tinypool, tsup/esbuild,
  rimraf/glob); fixed by in-range updates plus vitest 3 → 5 and tsup 8 → 9.
  `npm audit` is clean; unit and integration tiers pass on the new tools.
- ~~Live instance for the integration tier from a cloud session~~ — done
  2026-11-04: `V1_URL`/`V1_ACCESS_TOKEN` point at the API-testing instance
  `https://www14.v1host.com/v1sdktesting`; `npm run test:integration` is
  green there (custom fields skip: hosted).

## Checklist

- [x] A1 transport: credentials, onUnauthorized (idempotent requests resent once; writes never), signal (`RequestOptions.signal`, `client.withSignal`)
- [x] A2 command-failure error (`CommandFailureError`, `throwOnFailure`, reads always throw)
- [x] A3 loc2 (`loc2.localize`, `client.localize`; GET, POST past 2000 encoded chars, culture via Accept-Language)
- [x] A4 slack-shaped reads — `queryV1` wire module, `client.queryV1.query`/`queries` (read-only, idempotent, same row translation as api/asset)
- [x] A5 services port from gh-v1 — `resolve` (`client.resolve.numbers`/`.ref`), `guard` (`client.assets.sendGuarded`), `batch` (`client.batch.run`/`.reversible`)
- [x] A7 attachments and embedded images — `attachment` wire module (`attachment.img` bytes, `EmbeddedImage.mvc/Upload`, URL helpers, browser-safe Base64), `client.attachments` (list/info/get/add/put/remove/url; inline up to `INLINE_LIMIT`, two-step above) and `client.embeddedImages` (upload/url/normalize)
- [ ] A6 CI + prerelease publish — CI (`.github/workflows/ci.yml`: verify on Node 20/22/24, `npm pack` artifact), git-SHA installs (`prepare`) and the dependency audit done; publish `@versionone/sdk@1.0.0-alpha.0` to npmjs with `--tag alpha` next (needs an org owner's token or trusted publisher)
- [x] G0–G3 gh-v1 migrations — versionone/gh-v1#29–#32
- [x] S1–S4 slack-bot migrations — digital-ai/k6i-agility-slack-bot#21–#24 (on `bolt-migration`)
- [x] B1 slack bot client swap — digital-ai/k6i-agility-slack-bot#29
- [x] B2 slack bot decodes deleted; reads through `client.queryV1` with a schema — digital-ai/k6i-agility-slack-bot#30
- [x] B3 slack bot writes on `client.assets.send` (rest-1 writes gone) — digital-ai/k6i-agility-slack-bot#32
- [x] B4 slack bot number lookups on `client.resolve.numbers` — digital-ai/k6i-agility-slack-bot#34 (SDK #44 adopted in #33: pin `785b4c9`, a `TypeCache` per instance)
- [x] C0 gh-v1 surveyed (2026-11-04)
- [x] C1 gh-v1 seam swap — versionone/gh-v1#33, with the vendored SDK's hashes, CI and Node 22 floor in #35
- [x] C2 gh-v1 rows translated through the schema; `isTrue`/`oidOf` gone — versionone/gh-v1#36
- [x] C3 gh-v1 resolve and batch on `client.resolve`/`client.batch` — versionone/gh-v1#37 (with the SDK fixes from #43)
- [ ] C4 gh-v1 attachments on `client.attachments` (unblocked: A7 done); `raw` stays CLI-local
- [ ] D1–D4 agility-rooms

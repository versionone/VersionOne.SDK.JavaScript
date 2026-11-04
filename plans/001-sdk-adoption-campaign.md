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

Specs (`specs/`) hold invariants; plans (`plans/`) hold sequencing and are
allowed to go stale once done.

Reference: the Agility API documentation is public at
https://docs.digital.ai/agility-api/ (as of 2026-11-04). Cite it in specs
and handoffs in place of the older GitHub Pages copy. It is not reachable
from the cloud environment (allowed 2026-11-04); `llms-full.txt` there is
the whole site as one text file, the fastest way to check a claim. Live
behaviour is still settled by the integration tier.

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
   consumers), `queryV1` (slack's main read path — or migrate slack to
   api/asset queries instead; see B3), `attachment`/`EmbeddedImage` (rooms).
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
9. **CommonJS consumers.** gh-v1 is `require`-based; the SDK's `dist/index.cjs`
   must keep working (a unit test that `require`s the built bundle).

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
- **A4 Slack-shaped reads** — decide queryV1-module vs. api/asset-only by
  porting `lib/queries.js` bodies into integration tests against the dev
  instance; whichever reads translate cleanly wins. (No `rest1` writes:
  gap 6 is settled.) If the bot's S2 lands first, this is only the
  translation check.
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
  once S2 moves reads to api/asset, the SDK needs no `queryV1` module and
  A4 collapses to "verify the bot's query bodies translate" — and A4's
  rest-1-writes question is closed (gap 6).
- **B1 Client swap.** `createV1Client` keeps its surface; inside, one
  `AgilityApiClient({ baseUrl: url, accessToken })`. `query`/`bulk`/`exec`
  → `client.assets.*`; `fetchLocalizations` → `loc2` (A3).
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
  `permalink`) on `AgilityApiClient`, `require`d from the CJS build. Callers
  unchanged; all 99 tests green. Needs A2, A3 (loc2), gap 9.
- **C2 Delete the decodes.** With rows translated by the schema, `isTrue`
  and `oidOf` drop out of `meta.js`, `resolve.js`, `board.js`; `momentless`
  comes from the SDK.
- **C3 Invert the services.** Once A5 lands, `resolve.js` and `batch.js`
  keep only prompting, rendering and receipt files; the logic is imported.
- **C4 Passthrough.** `raw`/`blob` stay CLI-local unless an `attachment`
  wire module (gap 5) is built for rooms — then `gh v1 attach` uses it.

`lib/guard.js` stays in gh-v1: it is policy for a terminal passthrough, not
SDK behaviour.

## Track D — agility-rooms (slow)

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
- **S2 query.v1 → api/asset reads.** Same query bodies; the endpoint is
  `api/asset` and results come from `queryResult.results` (positional, one
  array per query). Add an explicit `page` to every body. Removes the
  SDK's need for a `queryV1` module.
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
  D1 → D2+. gh-v1 first: no framework migration, and stubbed-fetch tests
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

- Publish target: GitHub Packages (`@versionone` scope, org auth required
  for consumers in CI) vs. npmjs public. Rooms and slack both build in GitHub
  Actions under `digital-ai`, so cross-org package read access matters.
- Live dev instance for the integration tier from a cloud session
  (`test/integration/instance.ts`) — needed for A4's translation check.

## Checklist

- [ ] A1 transport: credentials, onUnauthorized, signal
- [x] A2 command-failure error (`CommandFailureError`, `throwOnFailure`, reads always throw)
- [ ] A3 loc2
- [ ] A4 slack-shaped reads (queryV1 or api/asset)
- [ ] A5 services port from gh-v1
- [ ] A6 CI + prerelease publish
- [ ] G0–G3 gh-v1 migrations (gh-v1 session)
- [ ] S1–S4 slack-bot migrations (slack-bot session, `bolt-migration`)
- [ ] B1–B4 slack bot SDK swap
- [x] C0 gh-v1 surveyed (2026-11-04)
- [ ] C1–C4 gh-v1
- [ ] D1–D4 agility-rooms

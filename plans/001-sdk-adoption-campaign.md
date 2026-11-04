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

**gh-v1.** Not reachable from this session (the GitHub credential has no
access to `versionone/gh-v1`). `src/client.ts` already says the `resolve`,
`guard` and `batch` services "arrive as the port from gh-v1 lands", so gh-v1
is both a source for Track A2 and a consumer. Everything below about gh-v1
is a placeholder until it can be read.

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
6. **rest-1 writes.** Slack updates with `?comment=` (a change comment).
   Confirm on a dev instance whether api/asset can carry a change comment;
   if not, `rest1` grows `create`/`update` with the `Attributes` envelope
   built in the wire module (translation once, per §2).
7. **Services.** `resolve` (number → OID), `guard`, `batch` — port from
   gh-v1 (blocked on access).
8. **Distribution.** No CI in this repo, no publish target, version 0.1.0.
   Source is browser-safe already (no `node:` imports, no `Buffer`).

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
  instance; whichever reads translate cleanly wins. Add `rest1` writes only
  if gap 6 proves api/asset cannot carry a change comment.
- **A5 Services port** — gap 7, once gh-v1 is readable. `resolve` first
  (both slack's `queryForAssetByNumber` and gh-v1 need it).
- **A6 CI and packaging** — GitHub Actions running `npm run verify` on PRs;
  publish prereleases (`0.x`, `next` tag) to GitHub Packages under the
  `@versionone` scope (or npmjs — decision below). Until then consumers pin a
  git SHA or a tarball from `npm pack`.

## Track B — k6i-agility-slack-bot (fast)

Ride the Bolt migration rather than rewriting the seam twice: Phase 2's
`services/v1.js` is built *as* a thin adapter over `AgilityApiClient`.

- **B0 Pin behaviour.** Extend `test/queries.test.js` into contract tests
  for every `v1api` method with recorded live responses (spec 000 §2a: fakes
  send what the server sends).
- **B1 Transport swap.** `new AgilityApiClient({ baseUrl: team.v1_url,
  accessToken })`, `onUnauthorized → authenticationFailureHandler`. Needs A1.
  axios leaves the dependency list (already a standing decision).
- **B2 Reads.** Query bodies move to `client.assets.query`; delete the three
  string-boolean decodes; positional result handling (`results[0][0]`,
  `results[2]`) becomes typed rows. Needs A4.
- **B3 Writes.** `quickClose`/`reactivate` → `assets.send` execute;
  `create`/`update` → api/asset (or `rest1` writes per gap 6);
  `transformDataToAsset.js` deleted.
- **B4 Search and localization.** `findAssets` → `client.data.list` with
  `find`/`findin`/`page`; `fetchLocalizations` → `loc2`. Needs A3.
- **B5 Number resolution.** `queryForAssetByNumber` →
  `resolve` service. Needs A5.

Gate per step: `npm test`, then a sandbox-workspace smoke (mention an asset,
`/v1` search, backlog-item status change, webhook notification).

## Track C — gh-v1 (fast, blocked)

Blocked on read access. Once readable:

- **C0** Inventory its Agility client and which pieces are the `resolve` /
  `guard` / `batch` originals (feeds A5).
- **C1** Invert the dependency: gh-v1 imports those services from the SDK
  instead of owning them; its own transport becomes `createFetchTransport`.
- **C2** Command-by-command migration behind its existing tests.

If gh-v1 is not TypeScript/Node, C1–C2 change shape (the SDK becomes the
reference implementation and a contract-test source rather than a
dependency) — revisit after C0.

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

## Operating model for the campaign

- **Home:** this cloud session on `proposed_type_script_api_version`. One
  milestone per request ("do A1"), each ending with verify green, a commit,
  and a push. Consumer work happens on a feature branch in each consumer repo
  (proposed: `sdk-adoption`), never on their default branches, PRs only on
  request.
- **Order:** A1 → A2 → A3 → B0/B1 → A4 → B2–B4 → A6 → D1 → (A5, B5, C* when
  gh-v1 is readable) → D2+.
- **Status:** this file's checklist below is the source of truth; update it
  in the commit that finishes a milestone.

## Decisions needed

- Grant this session access to `versionone/gh-v1` (Claude GitHub App
  installation on that repo) — unblocks A5, B5, Track C.
- Publish target: GitHub Packages (`@versionone` scope, org auth required
  for consumers in CI) vs. npmjs public. Rooms and slack both build in GitHub
  Actions under `digital-ai`, so cross-org package read access matters.
- Live dev instance for the integration tier from a cloud session
  (`test/integration/instance.ts`) — needed to settle gap 6 and A4.

## Checklist

- [ ] A1 transport: credentials, onUnauthorized, signal
- [ ] A2 command-failure error
- [ ] A3 loc2
- [ ] A4 slack-shaped reads (queryV1 or api/asset)
- [ ] A5 services port from gh-v1
- [ ] A6 CI + prerelease publish
- [ ] B0–B5 slack bot
- [ ] C0–C2 gh-v1
- [ ] D1–D4 agility-rooms

# Plan 002: gh-v1 adopts `@versionone/agility-sdk` (Track C)

Brief for a session on `versionone/gh-v1`. Source plan:
`plans/001-sdk-adoption-campaign.md`, Track C.

**Status (2026-11-07): done.** C1–C4 merged (versionone/gh-v1#33, #35–#38);
gh-v1 then moved to the renamed, published package (#39, #40). gh-v1
reaches Agility only through the vendored SDK, apart from the `gh v1 api`
passthrough. The rest of this brief is the record of how.

## Goal

gh-v1 talks to Agility only through `@versionone/agility-sdk`. CLI behaviour and
output stay the same; the code that duplicates the SDK goes.

## Where things stand (checked 2026-11-06, gh-v1 `2c58c7e`)

- G0–G3 are merged: executable bin, `V1_URL`/`V1_ACCESS_TOKEN` config, ESM
  (`"type": "module"`), `jsconfig.json` + `npm run typecheck`, one paging
  module (`lib/paging.js`).
- The bin `gh-v1` is now a `sh` launcher that runs `gh-v1.js` with the real
  node (bypassing Volta's shim, which mangles arguments on Windows). The
  swap does not touch either; keep `test/launcher.test.js` green.
- One seam: `lib/api.js` exports `api(cfg)` returning `query`, `queries`,
  `asset`, `attempt`, `rest`, `meta`, `localize`, `raw`, `blob`,
  `permalink`, typed by the `Api` JSDoc typedef. Its tests under `test/`
  stub global `fetch`.
- String-boolean and OID helpers (`isTrue`, `oidOf`, `momentless`) are used
  in `lib/api.js`, `meta.js`, `resolve.js`, `board.js`, `batch.js`, and
  `commands/apply.js`, `bulk.js`, `board.js`.

## Dependency: vendored

gh installs a script extension with a plain `git clone` and never runs npm,
so gh-v1 cannot rely on `node_modules` at run time. The SDK is still a
runtime dependency, but its code ships inside the repo:

- `vendor/versionone-sdk/` holds the SDK's ESM build (`index.js`, which
  imports nothing) and types (`index.d.ts`), plus `SOURCE.json` naming
  the version they came from and each file's SHA-256. `lib/api.js`
  imports from there.
- `package.json` lists `@versionone/agility-sdk` under `devDependencies`,
  pinned to an exact published version (`1.0.0-alpha.0` today; before the
  first publish it was a git commit), so the lockfile records exactly what
  was vendored.
- To move the pin: change it in `package.json`, then
  `npm install && npm run vendor:sdk`, and commit the copy.
  `test/vendor.test.js` fails if the copy, `SOURCE.json` and the pin
  disagree.
- The SDK is on npmjs (plan 001, A6); that changed only where the pin
  points. The copy stays, because gh never runs npm.

## Steps, one PR each, on branch `sdk-adoption`

1. **C1 Seam swap** (`lib/api.js`) — done in versionone/gh-v1#33. Keep `api(cfg)` and the `Api` typedef.
   Inside, build one `AgilityApiClient({ baseUrl: cfg.v1Url, accessToken })`.
   Map: `query`/`queries` → `client.assets.query`/`queries`;
   `asset` → `client.assets.send(cmds, { throwOnFailure: true })`
   (a `CommandFailureError` carries `failures` by index — keep `err.failures`);
   `attempt` → `client.assets.send` (failures returned, not thrown);
   `rest` → `client.data.list`/`get`; `meta` → `client.meta.*`;
   `localize` → `client.localize`. `raw`, `blob`, `permalink` stay local.
   Rows now arrive translated (`true`, numbers, single relations as one
   Ref), so update the fixtures in tests that assert raw strings, and add
   the meta fixture the schema needs (`test/meta-fixture.js`, or seed
   `ClientOptions.metamodel`).
2. **C2 Delete the decodes.** Remove `isTrue`/`oidOf` call sites listed
   above; import `momentless` from the SDK.
3. **C3 Invert the services.** `resolveAssets` → `client.resolve.numbers`
   (its `missing` drives the "not found — skipped" lines). `batch.run` →
   `client.batch.run`, with `confirm` as the prompt and the receipt written
   as returned. `--reverse` → `client.batch.reversible` (`--force` passes
   `force`). Keep the CLI's UX for an unguardable batch by checking
   `unguardable()` first, then sending with `guard: false` and the existing
   note. Prompting, rendering, permalinks and receipt files stay in gh-v1.
4. **C4 Attachments on the SDK** (after plan 001's A7). `gh v1 attach`
   (`list`, `get`, `add`, `put`) moves onto `client.attachments`; `blob`
   leaves `lib/api.js`. File I/O, `--out`, the content-type guess and the
   CLI's messages stay in gh-v1. `raw` (the `gh v1 api` passthrough) and
   `lib/guard.js` stay: they are CLI policy, not SDK behaviour.

## Rules

- Requests out must match today's, apart from what translation changes.
  Add a test that asserts the request body where it differs, and say why.
- Every query keeps an explicit page (the SDK refuses one without).
- Live Agility calls go only to the API/SDK testing instance,
  `https://www14.v1host.com/v1sdktesting` (`V1_URL`). Writes are allowed
  there and nowhere else: name fixtures `sdk-integration …` and delete them
  by exact OID when done. Every query sets an explicit page size and stays
  well under 20 s of server work.

## Done when

- `npm test` and `npm run typecheck` pass on each PR.
- `lib/api.js` has no `fetch` call except in `raw`/`blob`.
- No `isTrue`/`oidOf`/local `momentless` remain in `lib/`.
- `lib/resolve.js` and `lib/batch.js` keep only prompting, rendering and
  file I/O.
- Plan 001's checklist line `C1–C4 gh-v1` is ticked, with the PR links.

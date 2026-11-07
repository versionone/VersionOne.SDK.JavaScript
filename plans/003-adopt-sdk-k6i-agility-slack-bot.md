# Plan 003: k6i-agility-slack-bot adopts `@versionone/agility-sdk` (Track B)

Brief for a session on `digital-ai/k6i-agility-slack-bot`. Start once the
SDK PR that adds this file has merged into `proposed_type_script_api_version`.
Source plan: `plans/001-sdk-adoption-campaign.md`, Track B. Work on
`bolt-migration` (branch `sdk-adoption` from it), never `main`.

## Goal

`services/v1.js`'s `createV1Client` runs on `@versionone/agility-sdk`, with the same
exported surface, so listeners and features do not change. The bot's
hand-decoding and rest-1 write path go.

## Where things stand (checked 2026-11-06, `bolt-migration` `4d77693`)

- `createV1Client({ url, accessToken })` uses native `fetch` and throws
  `AuthFailureError` on 401. Its methods: `query` (query.v1), `bulk`,
  `createWithNumber`, `exec`/`quickClose`/`reactivate` (api/asset),
  `create`/`update` (rest-1 writes via `lib/rest1DataTransformer.js`),
  `findAssets` (rest-1 `find`/`findin`, `page` up to 200),
  `fetchLocalizations` (loc-2), and `queryFor*` helpers built on
  `lib/queries.js`. `test/v1-service.test.js` stubs global `fetch`.
- **S1–S4 are not done yet**: `jsconfig.json` still says `commonJS`/`es6`;
  query bodies have no explicit page; `axios`, `botkit*`, `botbuilder-*` are
  still dependencies and `lib/v1api.js` still exists. These come first.

## Dependency

No registry package yet. Pin a commit:
`"@versionone/agility-sdk": "github:versionone/VersionOne.SDK.JavaScript#<merge sha>"`.
The SDK's `prepare` script builds `dist` on install. The bot is ESM, so
`import { AgilityApiClient } from "@versionone/agility-sdk"`.

## Steps, one PR each

0. **S1–S4 first**, as written in `plans/handoffs/k6i-agility-slack-bot.md`.
   B1 needs at least S2 (every read paged) and S3 (axios and Botkit gone).
   If the bot's own session already merged them, skip.
1. **B1 Client swap** (`services/v1.js`). Inside `createV1Client`, build one
   `new AgilityApiClient({ baseUrl: url, accessToken })`. `query` →
   `client.queryV1.queries` (the bot's reads stay on query.v1: read-only,
   simplest responses; a refused query throws with the server's message); `bulk`/`exec`/`createWithNumber` →
   `client.assets.send`; `fetchLocalizations` → `client.localize`;
   `findAssets` → `client.data.list("BaseAsset", { find, findin, where,
   sort, page, deleted: false })`. Map `ApiError` with `status === 401`
   to `AuthFailureError` in one place. The SDK's `onUnauthorized` is not
   needed. `test/v1-service.test.js` stays the parity proof.
2. **B2 Delete the decodes.** Rows arrive translated: drop the
   `"Team.HasProcess" === "True"` and `IsKanban.toLowerCase() === "true"`
   comparisons, local `toMomentless` (use the SDK's `momentless`), and the
   `results[1]`/`results[2]` guessing in `queryForPrimaryWorkitemByOid` and
   `queryForTeamRoomContext`.
3. **B3 Writes on api/asset.** `create`/`update` → `client.assets.send`,
   with the change comment as `ChangeComment` inside the `update` node (or
   at the root of a create). `execute` cannot carry a comment. Delete
   `lib/rest1DataTransformer.js` and its test.
4. **B4 Number resolution.** `queryForAssetByNumber` →
   `client.resolve.numbers([n])`; a miss is `missing`, not an empty row.

## Rules

- Every api/asset query keeps an explicit `page` (the SDK refuses one
  without). Values from user text go in `with` variables, not spliced into
  `filter`/`where` (an em dash breaks a literal).
- Fixtures send what the server sends (S4): `"True"`, not `true`.
- Live Agility calls go only to the API/SDK testing instance,
  `https://www14.v1host.com/v1sdktesting` (`V1_URL`). Writes are allowed
  there and nowhere else: name fixtures `sdk-integration …` and delete them
  by exact OID when done. Every query sets an explicit page size and stays
  well under 20 s of server work.

## Done when

- `npm test` passes on each PR; S1's `npm run typecheck` passes.
- `services/v1.js` makes no `fetch` call of its own; reads go through
  `client.queryV1` (or `client.data` for `find`), and nothing writes through
  rest-1.
- No string-boolean comparisons or local `toMomentless` remain.
- Sandbox-workspace smoke passes: asset mention, `/agility find`,
  backlog-item status change, webhook notification.
- Plan 001's checklist lines `S1–S4` and `B1–B4` are ticked, with PR links.

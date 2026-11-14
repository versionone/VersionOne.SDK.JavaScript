# Plan 004: agility-rooms adopts `@versionone/agility-sdk` (Track D)

Started 2026-11-14 on `1.0.0-alpha.3` (plan 005's breaking batch), as a
session from the SDK session.

Brief for a session on `digital-ai/agility-rooms`, a React/Vite SPA that
runs inside Agility (same-origin, cookie auth). Source plan:
`plans/001-sdk-adoption-campaign.md`, Track D. gh-v1 (plan 002) and the
slack bot (plan 003) have finished their adoptions; this is the last
consumer, and the slowest: a strangler that starts below the call sites so
nothing user-visible moves.

## Goal

Rooms talks to the Agility data endpoints (api/asset, query.v1, rest-1,
meta.v1, loc-2, attachments, embedded images) only through
`@versionone/agility-sdk`. Rows arrive translated, so its hand-decoding
goes. UI behaviour stays the same. Rooms' own routes (`api/*` reports,
tags, watch, rooms2config, LLM; `*.mvc` pages) are out of scope unless the
SDK already covers them.

## Where things stand (surveyed 2026-11-07 at `main` `0874590`, read-only)

Full survey: plan 001, *What the consumers do today*, the agility-rooms
re-survey paragraph. In short:

- **HTTP.** `src/utils/axios.tsx` builds the default instance (`baseURL`
  the app root, `X-Requested-With`, cookie auth; on 401/403 an SSO popup
  via `Account.mvc/Login`, then axios-auth-refresh replays). A response
  interceptor turns api/asset `commandFailures` into a localized snackbar
  and throws — but only when the URL is exactly `/api/asset`; 9 calls
  written `api/asset` bypass it. `getAxiosInstance(...)` variants, a bare
  `meta` instance and a plain `axios.create` in `src/navigation/routes.tsx`
  skip some interceptors. 88 production files import axios.
- **Endpoints.** api/asset (111 call sites in 57 files), query.v1 (16),
  rest-1 reads (4) **and writes** (5 `Data/{T}/{id}` attribute posts, 2
  `?op=Copy`, plus `New/{T}?ctx=` templates), meta.v1, loc-2, `loc.v1`,
  `config.v1`, attachments (`MultiValueRelations/Attachments.tsx`: inline
  Base64 create, `attachment.img` download), embedded images
  (`useImageUpload.ts` → `EmbeddedImage.mvc/Upload`).
- **Reads.** Positional `results[n]` with index constants
  (`metaAssetStore/constants.ts`); some board and `ID=$Oids` reads are
  unbounded (the SDK refuses an unpaged query).
- **Decoding.** 46 `"True"`/`"False"` comparisons; `NULL_OID` used 118
  times; `massageApiAssetResponseObject` unwraps single relations. meta.v1
  is loaded by `store/metaDefinition/useMetaDefinitionStore.ts`.
- **Tests.** Jest (222 files, module mocks, no MSW); the AI domain's
  injected `IHttpClient` / `FakeHttpClient` is the cleanest seam.
  Playwright (79 specs) runs against a live server.

## What the SDK offers rooms (1.0.0-alpha.3, on npmjs as `latest`)

- `AgilityApiClient` with a pluggable `Transport` (D1 wraps rooms' axios),
  or `createFetchTransport` with `credentials: "same-origin"` and
  `onUnauthorized` (resend an idempotent request after re-auth; a write is
  never resent), `signal` / `client.withSignal` for cancellation.
- One query body, the client picks the endpoint: `client.query` /
  `queries` (query.v1, read-only, retried like a GET; rows translated
  through the schema; a failed query throws), `client.get(oid, select)`,
  `client.queryPage(q)` (rows, total, more), `client.pages` / `client.all`
  (page by page up to a limit), `client.me()`. A literal `from` completes
  `select` from the type's attributes and types the rows by what was
  selected; `Custom_` list types read as `CustomList`; custom and
  `ReciprocalOf_` attributes are accepted on every type.
- `client.assets.send` answers an `Outcome` (`created`, `modified`,
  `operated`, `failures` with each `violation` parsed — rule, attribute
  token, loc-2 tag for the snackbar — and `queryResults`), never the
  envelope; `throwOnFailure` throws a `CommandFailureError` carrying the
  same Outcome. `client.assets.sendGuarded`, `client.batch`.
- Every error is an `ApiError` with `kind` (`auth`, `forbidden`,
  `notFound`, `invalid`, `transient`, `aborted`, `commandFailure`,
  `protocol`, `usage`): the one switch the interceptor needs.
- `client.data` (rest-1 reads, query spelling), `client.localize`,
  `client.schema` / `TypeCache`, `client.resolve`, `client.attachments`
  (list/page/info/get/add/put/remove; inline Base64 up to 1 MB as rooms
  does, two-step above), `client.embeddedImages` (upload/normalize),
  `client.urls` (asset page, attachment, embedded image).
- Browser-safe: no `node:` imports, no Buffer. Install
  `npm install @versionone/agility-sdk@1.0.0-alpha.3` (an exact pin; it is
  an alpha). `CHANGELOG.md` in the SDK repo lists each change with its
  migration line; the generated model is meta.v1 26.3.1.13.

## First: a decision for Jim

Rooms writes through rest-1 (attribute posts with `act`, `?op=Copy`) and
reads `New/{T}` templates, which plan 001 assumed no consumer needed.
Before D1, find out (live, on v1sdktesting) whether api/asset covers each:
an update for the attribute posts (likely), an `execute: "Copy"` or similar
for Copy, and whether `New/{T}` has an api/asset equivalent. Report what you
find to the SDK session and Jim, with a recommendation: move them to
api/asset, or have the SDK grow a narrow rest-1 write path.

## Steps, one PR each against `main`, from its own branch

1. **R1 Narrow the axios surface.** Route the axios importers through
   `utils/bulkApiService.tsx` and a small set of helpers, so D1 swaps one
   module. Fix the `api/asset` vs `/api/asset` interceptor gap on the way.
2. **D1 SDK under the existing axios.** A `Transport` that delegates to
   rooms' axios instance (keeps the SSO refresh and the snackbar); point
   `bulkApiService.tsx` at `client.assets.*`. Rows arrive translated, so
   `getApiResults`' `IsReadOnly` patch goes.
3. **D2 Domain by domain.** Start with `src/domains/ai`, then retire the
   string-boolean and `NULL_OID` decodes per feature; attachments onto
   `client.attachments`, embedded images onto `client.embeddedImages`;
   positional `results[n]` onto named or `queries` results; page every read.
4. **D3 Native transport.** Replace the axios-backed Transport with
   `createFetchTransport({ credentials: "same-origin", onUnauthorized })`,
   the SSO popup as the hook.
5. **D4 Schema convergence.** Evaluate replacing parts of
   `src/metaAssetStore/` and `useMetaDefinitionStore` with the SDK's
   `schema` / `TypeCache`.

## Rules

- Jest and the existing Playwright gates pass on every PR. No behaviour or
  UI change unless a step says so.
- Live Agility calls go only to `https://www14.v1host.com/v1sdktesting`
  (`V1_URL`, token in `V1_ACCESS_TOKEN`; Node's fetch needs
  `NODE_USE_ENV_PROXY=1`). Writes are allowed there and nowhere else: name
  assets `sdk-integration …` and delete them by exact OID. Every query is
  small and explicitly paged. Point Playwright at nothing else.
- An EmbeddedImage cannot be deleted; upload one only when a test needs it.
- If the SDK lacks something, don't work around it in rooms: tell the SDK
  session (`session_016NSWj6mJotpoJ4FontE4Kg`, `send_message`) with what
  you need and why; the friction you hit writing real rooms code is the
  next findings pass of plan 005. Don't request reviewers; Jim picks.

## Done when

- Rooms reaches the data endpoints only through the SDK; no file outside
  the transport adapter imports axios for them.
- No `"True"`/`"False"` comparisons or `NULL_OID` checks on SDK rows remain.
- Attachments and embedded images go through the SDK.
- Plan 001's checklist line `D1–D4 agility-rooms` is ticked, with PR links
  (tell the SDK session as each merges).

# Handoff: gh-v1 moves to `@versionone/agility-sdk@1.0.0-alpha.3`

Paste everything below the line into the session working on
`versionone/gh-v1`. Source: `plans/005-ergonomics-and-hardening.md` and
`CHANGELOG.md` in `versionone/VersionOne.SDK.JavaScript`.

---

Context: the SDK's breaking batch (`1.0.0-alpha.3`) changes what
`client.assets.send` returns, how errors are classified, and where reads
live. gh-v1 vendors the SDK, so this is one PR: move the pin, re-vendor,
adapt `lib/api.js`, keep every test green and the CLI's behaviour and
output unchanged. `npm test` and `npm run typecheck` gate it.

1. **Pin and vendor.** `package.json` devDependency
   `@versionone/agility-sdk` → `1.0.0-alpha.3`; `npm install && npm run
   vendor:sdk`; commit `vendor/versionone-sdk/` and `SOURCE.json`
   (`test/vendor.test.js` checks the hashes).
2. **`asset` / `attempt` read an Outcome.** `client.assets.send` now
   answers `{ created, modified, operated, failures, queryResults,
   durationSeconds }` instead of the api/asset envelope. Wherever
   `lib/api.js` or its callers read `assetsCreated.oidTokens`,
   `commandFailures`, `queryResult.results`, read `created`, `failures`,
   `queryResults`. `attempt` reports each failure by `index` as before;
   each failure also carries `violation` (`rule`, `attribute`, `tag`) if
   the message was a `Violation'…` token — use it for the "not found —
   skipped" and required-attribute lines if that reads better. If a
   caller needs the raw envelope (the `gh v1 api` passthrough does not;
   it is `raw`), the wire module `assetApi.send` still returns it.
3. **Reads.** `client.assets.query` / `queries` are deprecated (removed
   next alpha): move `query` / `queries` to `client.query` /
   `client.queries`. These read through query.v1 (read-only, retried like
   a GET); rows translate identically (the SDK's integration tier proves
   it). A command that needs the total of a query uses
   `client.queryPage`; one that walks a whole result uses `client.all(q,
   { limit })`, which replaces any paging loop in `lib/paging.js` that
   reads more than one page.
4. **Errors.** Every SDK error is an `ApiError` with `kind`. Where gh-v1
   catches `TypeError` from `resolve` or `parseOid`, catch `UsageError`
   (or `kind === "usage"`). Where it branches on `status === 401`, `kind
   === "auth"` is equivalent and also covers the transport's own codes.
5. **Permalinks.** `client.urls.asset(oid)` builds the same
   `assetdetail.v1?oid=` URL gh-v1's `permalink` does; keep `permalink`
   as the CLI's name but let it call the SDK.
6. **rest-1 reads** (`rest` in `lib/api.js`): `client.data.list` takes
   `select`/`filter` now; `sel`/`where` work this alpha and go next.

Report back with the PR link, and anything in the SDK that got in the
way: that list is the next findings pass.

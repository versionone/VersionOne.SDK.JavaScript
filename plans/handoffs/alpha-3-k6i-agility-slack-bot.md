# Handoff: the slack bot moves to `@versionone/agility-sdk@1.0.0-alpha.3`

Paste everything below the line into the session working on
`digital-ai/k6i-agility-slack-bot` (branch `bolt-migration`). Source:
`plans/005-ergonomics-and-hardening.md` and `CHANGELOG.md` in
`versionone/VersionOne.SDK.JavaScript`.

---

Context: the SDK's breaking batch (`1.0.0-alpha.3`) changes what
`client.assets.send` returns, how errors are classified, and where reads
live. The bot pins an exact version, so this is one PR on
`bolt-migration`: move the pin, adapt `services/v1.js`, keep
`test/v1-service.test.js` as the parity proof and the sandbox smoke green
(asset mention, `/agility find`, backlog-item status change, webhook
notification).

1. **Pin.** `"@versionone/agility-sdk": "1.0.0-alpha.3"`.
2. **`bulk` / `exec` / `createWithNumber` / `create` / `update` read an
   Outcome.** `client.assets.send` answers `{ created, modified,
   operated, failures, queryResults, durationSeconds }`, not the envelope:
   `assetsCreated.oidTokens` → `created` (momentless OIDs already),
   `commandFailures` → `failures` (by `index`, with `violation` parsed:
   `rule`, `attribute` such as `Story.Scope`, and `tag`, which
   `client.localize([tag])` turns into the attribute's label — the right
   text for a "Scope is required" reply).
3. **Reads.** `client.queryV1.query` / `queries` are deprecated (removed
   next alpha): rename to `client.query` / `client.queries`; same
   endpoint, same rows, nothing else changes. `findAssets` on
   `client.data.list`: `where` → `filter` (`where` still works this
   alpha). A `/agility find` that wants the total can use
   `client.queryPage`.
4. **Errors.** `AuthFailureError` is thrown where the bot sees `status
   === 401`; `err.kind === "auth"` is the same test and also names the
   transport's cases. A caller mistake (an unpaged query body, a bad
   number) is now a `UsageError`, not a `TypeError`.
5. **Links.** Cards and messages that build an asset URL use
   `client.urls.asset(oid)`.
6. **New, for later features:** `client.me()` (the bot's member, for a
   comment's `Author` once conversations land), `client.get(oid, select)`,
   `client.all(q, { limit })`.

Report back with the PR link and anything in the SDK that got in the
way: that list is the next findings pass.

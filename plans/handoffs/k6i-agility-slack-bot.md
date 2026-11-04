# Handoff: k6i-agility-slack-bot migrations S1–S4

Paste everything below the line into the session working on
`digital-ai/k6i-agility-slack-bot`. Source: `plans/001-sdk-adoption-campaign.md`
in `versionone/VersionOne.SDK.JavaScript` (branch
`proposed_type_script_api_version`), section *Consumer migrations*.

---

Context: after the Bolt migration, `services/v1.js` (`createV1Client`) will
be re-implemented on `@versionone/sdk`, the TypeScript rewrite of the
Agility JS SDK, keeping its exported surface. These four migrations come
first, so that swap is one file. Work on (or branch from) `bolt-migration`,
not `main`. One PR each, `npm test` green, and follow AGENTS.md and
`docs/auth-flows.md` as usual.

**S1 — Finish ESM tooling.** The runtime is already ESM (`"type": "module"`,
no `require`). `jsconfig.json` still declares `module: commonJS`,
`target: es6`. Set `module`/`moduleResolution` to `NodeNext`, `target` to
`ES2022`, add `checkJs: true` and `noEmit: true`, and an
`npm run typecheck` (`tsc -p jsconfig.json`; `typescript` is already a
devDependency). Start non-strict; fix or annotate what it finds.

**S2 — Reads from query.v1 to api/asset.** In `services/v1.js`, `query()`
posts to `query.v1`. Post the same bodies to `api/asset` instead and read
`queryResult.results` (one array per query, positional, an empty array
for a query that matched nothing) so callers still receive an array of
result arrays. Add an explicit `page: { size, start }` to every body in
`lib/queries.js` (api/asset reads should never be unbounded). Note that
api/asset returns every scalar as a string (`"True"`, `"5"`) and a
single relation selected with a sub-select as a one-element list — check
each call site's comparisons against a real response. Update
`test/v1-service.test.js`.

**S3 — Close Bolt Phase 2.** AGENTS.md says axios is dropped in Phase 2.
Once nothing imports them, remove `axios`, `botkit`,
`botbuilder-adapter-slack`, `botbuilder-storage-mongodb`,
`botkit-plugin-cms` from `package.json`, and delete `lib/v1api.js` and
the Botkit-era `plugins/` modules that `listeners/` replaced. Keep
`bot.js` only if something still runs it; otherwise `main` should point at
`app.js`. If anything blocks removal, list it rather than forcing it.

**S4 — Fixtures from real responses.** Replace the hand-written payloads
in `test/v1-service.test.js` and `test/queries.test.js` with responses
captured from the local dev instance (`http://localhost/VersionOne.Web/`),
committed under `test/fixtures/`. A fake must send what the server sends.

Open question to answer while doing S2/S3 (do not change behaviour for
it): does an api/asset `update` accept a change comment equivalent to
rest-1's `?comment=` used by `update()`? Record what you find in the PR.

Do not add `@versionone/sdk` yet (milestone B1, run from the SDK session
after S2 and S3 merge). Report back with the PR links.

# Handoff: gh-v1 migrations G1–G3

Paste everything below the line into the session working on
`versionone/gh-v1`. Source: `plans/001-sdk-adoption-campaign.md` in
`versionone/VersionOne.SDK.JavaScript` (branch
`proposed_type_script_api_version`), section *Consumer migrations*.

---

Context: gh-v1 will become the first consumer of `@versionone/sdk` (the
TypeScript rewrite of the Agility JS SDK). Before that swap, gh-v1 should
adopt three migrations so the swap later touches only `lib/api.js`. Do them
as three separate PRs, in order, each with `npm test` green (99 tests
today) and no change in CLI behaviour or output.

**G1 — CommonJS to ESM.**
- `package.json`: `"type": "module"`. Convert every `require`/`module.exports`
  in `gh-v1` (the bin script), `lib/`, `lib/commands/` and `test/` to
  `import`/`export`, keeping `node:` specifiers.
- Known snags, found by survey:
  - `test/apply.test.js` (around line 104) replaces `lib/commands/bulk` via
    `require.cache`. ESM has no module cache to patch. Prefer making the
    dependency injectable (pass the bulk runner into the apply command, with
    the real one as default) over `mock.module`, which needs
    `--experimental-test-module-mocks`.
  - `test/prompt.test.js` builds a child-process script that `require`s
    `lib/prompt.js` by `__dirname` path; switch to an `import()` of a
    `file://` URL built from `import.meta.url`.
  - Commands that are loaded by name in `lib/cli.js` become dynamic
    `import()`s; keep loading lazy so startup stays fast.
- Check `gh extension` dispatch still works on Windows (the README has a
  section on argument mangling there): the bin script keeps its
  `#!/usr/bin/env node` shebang.

**G2 — Type checking without a build step.**
- Add `jsconfig.json`: `checkJs: true`, `module` and `moduleResolution`
  `NodeNext`, `target: ES2022`, `strict: false` to start, `noEmit: true`.
- JSDoc types on the object returned by `api()` in `lib/api.js` (`query`,
  `queries`, `asset`, `attempt`, `rest`, `meta`, `localize`, `raw`,
  `blob`, `permalink`) and on `resolveAssets`. That surface is the contract
  the SDK swap must preserve.
- Add `typescript` as a devDependency and an `npm run typecheck`
  (`tsc -p jsconfig.json`); fix what it finds or `// @ts-expect-error`
  with a reason. Runtime dependencies stay at zero.

**G3 — One paging policy.**
- `page: { ... }` literals appear in ~16 files under `lib/`. Introduce one
  module-level default (and named sizes where a command deliberately uses a
  different one) so every read is visibly bounded from one place. No
  change in the pages actually sent; the tests that assert request bodies
  should not change.

Do not start the SDK swap itself (that is milestone C1, run from the SDK
session after G1 merges). Report back with the PR links.

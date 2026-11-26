# AGENTS.md

For a coding agent (or a person) about to change this repository. It says
where things are, what must stay true, and how to check your work. It is
kept short on purpose: the rules live in the documents it points to, and
this file must stay true as they change. If you change how the repository
works, change this file in the same pull request.

## What this is

`@versionone/agility-sdk`: a TypeScript client for the Digital.ai Agility
(VersionOne) API. No runtime dependencies. Node 22 or later and browsers;
ESM and CommonJS. It is published to npm and this repository is public.

## Read first

1. `specs/000-layers.md` — the invariants: the layers and which may import
   which, one shape for every object, how rows are translated, the two test
   tiers, what is never sent unbounded, one error type. A change to an
   invariant changes that file in the same commit.
2. `CONTRIBUTING.md` — what may be committed to a public repository and how
   to refer to things (no consumer project, hosted instance, session or
   person is ever named in the tree, in a commit message or in a pull
   request).
3. `CHANGELOG.md` — what each release changed, each change with the line a
   consumer follows to migrate.
4. `README.md` — the public API as a consumer meets it.

## Where things are

```
src/core       HTTP transport, errors. Knows nothing about assets.
src/types      The model. src/types/assets is GENERATED: never edit by hand.
src/wire       One module per endpoint: its envelope and the translation to the model.
src/services   What to do with assets: schema, resolve, guard, batch, attachments, fields.
src/client.ts  The client: binds the layers.
src/index.ts   The package's public exports.
test/unit          Runs with nothing. A fake Transport answering what the server answers.
test/integration   The same modules against a real instance. Writes fixtures.
scripts        Metamodel download, type generation, the integration launcher.
metamodel.json The product's metamodel for one release; the generated types come from it.
```

## Commands

```bash
npm ci
npm run verify            # typecheck, build, unit tests. Run before every push.
npm run test:integration  # the live tier; skips with a message when no instance is configured
npm run generate:types    # after metamodel.json changes
```

`npm run verify` includes three structural tests that will fail a careless
change, by design: `layers.test.ts` (imports point down the layer table),
`publicTree.test.ts` (nothing private in the tree) and
`generate-types.test.ts` (the generated types match the metamodel).

## Rules that are easy to break

- **Prove it live before you build on it.** The API's real behaviour is not
  what its documentation or a plausible fake says. A new claim about the
  server gets an integration test, with a control beside every "it
  returned rows" that expects zero rows. A unit-test fake sends what the
  server sends, copied from a live response with identities replaced.
- **Live calls go only where fixtures may be written**: a local dev
  instance, or a hosted instance set aside for API testing and named in
  `SDK_TEST_ALLOWED_INSTANCES`. Fixtures are named `sdk-integration …` and
  deleted by exact OID by the test that made them. Every query is paged.
- **Nothing private in the tree.** See `CONTRIBUTING.md`. A URL in an
  example uses `agility.example.com`.
- **A failure never reads as an empty result**, and no read is unbounded
  (spec 000 §6).
- **Everything thrown is an `ApiError` with a `kind`** (spec 000 §7).
- **Names are meta.v1's names** (spec 000 §3): no renaming, no aliases.
- **A change a consumer can see gets a changelog entry with its migration
  line.** Until 1.0.0, breaking changes are allowed between alphas and are
  listed under "Breaking".

## Pull requests and releases

- Branch from `master`, open the pull request against `master`, and say
  in it what you verified and how.
- A release is a pull request that bumps `package.json`'s version and
  writes the changelog section. A maintainer merges it, pushes the tag
  `v<version>` and approves the staged publish (`README.md`, "Releasing").
  Nothing else publishes.
- CI (`.github/workflows/ci.yml`) runs `npm run verify` on the supported
  Node lines. The integration tier runs on a schedule and on demand
  (`.github/workflows/integration.yml`) against the API-testing instance.

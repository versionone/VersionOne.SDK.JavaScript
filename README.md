# @versionone/agility-sdk

TypeScript SDK for the Digital.ai Agility (formerly VersionOne) API. It works in Node (ESM or CommonJS) and the browser, ships its own types, and has no runtime dependencies.

Not to be confused with `v1sdk`, the 2.x JavaScript SDK: this is a new API, not a compatible successor.

## Install

Alpha releases are for feedback; the API may change between them.

```bash
npm install @versionone/agility-sdk@alpha
```

```ts
import { AgilityApiClient } from "@versionone/agility-sdk";

const client = new AgilityApiClient({ baseUrl: "https://www14.v1host.com/v1sdktesting", accessToken: process.env.V1_ACCESS_TOKEN });
const stories = await client.query({ from: "Story", select: ["Name", "Estimate"], page: { size: 10, start: 0 } });
// stories[0].Estimate is a number | null; stories[0].Nmae does not compile
```

## Working on the SDK

```bash
npm install
npm run build
npm test
```

## Development scripts

- `npm run dev` - watch build
- `npm run build` - build ESM + CJS + declarations
- `npm run typecheck` - run TypeScript type checks
- `npm run verify` - run typecheck + build + tests
- `npm run test` - run unit tests
- `npm run download:metamodel -- <baseAgilityUrl>` - refresh `metamodel.json` from an instance on the current release (instance-specific definitions stripped; `--raw` keeps them), then `npm run generate:types`. The cleanest source is a dev instance on a blank database (Core's gulp task for that); a hosted instance on the release gives the same file. The generated model is from meta.v1 **26.3.1.13** (hosted, 2026-11-12)

## Public API

Changes between alphas are in `CHANGELOG.md`, each with its migration line.

- `AgilityApiClient` - the client. One query body everywhere; the client picks the endpoint:
  - `query` / `queries` - rows, translated (numbers as numbers, booleans as booleans, a single relation as one `Ref`), through query.v1: read-only, so a request is retried like a GET. A page is required; a refused query throws, never an empty result. Written with a literal `from`, `select` completes from the type's attributes and the rows are typed by what was selected
  - `get(oid, select)` - one asset or null; `queryPage(q)` - rows with the total and whether more follow; `pages(q, { limit })` / `all(q, { limit })` - page by page up to a limit (default 1000); `me()` - the member the credentials belong to
  - `assets.send` - an api/asset batch, answered as an `Outcome` (`created`, `modified`, `operated`, `failures` with parsed violations, `queryResults`); `throwOnFailure` throws a `CommandFailureError` carrying the same Outcome. `assets.preview` - the projection. `assets.sendGuarded` - a batch as a compare-and-set on each asset's ChangeDate; changed assets come back `skipped`
  - `batch.run` / `batch.reversible` - preview, snapshot, (confirm,) send guarded, and a receipt with a reverse batch; undo reactivates a closed asset before deleting it and reopens what a close cascaded to
  - `resolve.numbers` / `resolve.ref` - asset numbers and OID tokens to assets, in one request
  - `attachments.list` / `page` / `info` / `get` / `add` / `put` / `remove` - files attached to an asset; `add` sends a small file inline and a large one in two steps, and a failed upload throws `AttachmentUploadError` naming the empty attachment it left
  - `embeddedImages.upload` / `normalize` - images in rich text; they cannot be deleted
  - `copy(oid)` - the Copy operation, answering the copy's OID (api/asset performs it but never says what it made); `data.operate(oid, op)` is the general form
  - `fields.describe(type, scope)` - what a form needs: required attributes (meta), the ones the product shows there (`api/visibleFields`, custom fields included), the scheme's important fields and whether they are enforced at close
  - `urls.asset(oidOrNumber)` / `attachment` / `embeddedImage` - where a browser opens each
  - `data.list` / `get` / `history` / `template` - rest-1 reads: deleted assets, history, and a new asset's template for a context (`New/<Type>?ctx=`); `meta.*` - meta.v1 raw; `schema` - the translated, cached view; `localize` - loc-2 labels for tags (a violation's `tag` is one)
- Errors: everything thrown is an `ApiError` with a `kind` (`auth`, `forbidden`, `notFound`, `invalid`, `transient`, `aborted`, `commandFailure`, `protocol`, `usage`, `unknown`). A mistake caught before any request is a `UsageError`
- `TypeCache` - one instance's loaded type definitions, shared by many clients (`new AgilityApiClient(config, { types })`)
- `createFetchTransport` - configurable HTTP transport: `credentials` for same-origin cookie auth, `onUnauthorized` to re-authenticate on a 401 (resends idempotent requests once), and a per-request `signal`; `client.withSignal(signal)` ties a whole client to one
- The wire modules (`assetApi`, `queryV1`, `rest1`, `meta`, `loc2`, `attachment`) are exported for passthroughs and transport authors; they speak the endpoints' own shapes

API reference: https://docs.digital.ai/agility-api/

## Extend with new APIs

1. Add a new folder under `src/apis/`.
2. Add request/response types under `src/types/`.
3. Implement methods using `Transport.request`.
4. Export from `src/index.ts`.
5. Add tests under `test/`.

## Installing before a release

No registry package yet. Pin a commit: `npm install github:versionone/VersionOne.SDK.JavaScript#<sha>` builds `dist` on install (the `prepare` script). CI also uploads an `npm pack` tarball on every run.

## Releasing

Versions are published to npmjs by `.github/workflows/publish.yml` when a
tag `v<version>` is pushed; the tag must equal `package.json`'s version. A
prerelease (`1.0.0-alpha.0`, `-beta.N`, `-rc.N`) goes out on its own
dist-tag (`alpha`, `beta`, `rc`). Until `1.0.0`, a maintainer moves
`latest` to the newest alpha by hand (`npm dist-tag add
@versionone/agility-sdk@<version> latest`), so a bare `npm install` gets
the current API rather than the first publish; from `1.0.0` on, `latest`
is never a prerelease.

```bash
npm version 1.0.0-alpha.2 --no-git-tag-version   # bump, commit, merge
git tag v1.0.0-alpha.2 && git push origin v1.0.0-alpha.2
```

The workflow does not publish directly: it runs `npm stage publish`, which
puts the version in the registry where nobody can install it yet, and prints
its stage ID in the run's summary. A maintainer then approves it with 2FA,
which is what publishes it:

```bash
npm stage view <stage-id>      # what was staged
npm stage approve <stage-id>   # publish it (asks for 2FA)
npm stage reject <stage-id>    # discard it
```

or approves it on the package's page on npmjs. `npm stage` needs npm
11.15.0 or later.

Authentication is npm trusted publishing: on npmjs, the package's settings
link this repository, `publish.yml` and the GitHub environment `npm`, with
the `npm stage publish` permission (leave plain `npm publish` off, as npm
recommends), and no token is stored. A trusted-publisher link expires; an
expired one must be deleted and created again, and until then the workflow
fails with `ENEEDAUTH`. The `npm` environment (repository settings) requires
an approval, so a pushed tag waits for a maintainer before it stages. A
package must exist before it can be linked, so the very first version was
published once by hand by an `@versionone` org member.

## Before PR

- Run `npm run verify` to validate typecheck, build, and tests before opening a pull request.
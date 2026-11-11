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
const stories = await client.queryV1.query({ from: "Story", select: ["Name", "Estimate"], page: { size: 10, start: 0 } });
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
- `npm run download:metamodel -- <baseAgilityUrl>` - download meta model for a given Agility instance

## Public API

- `AgilityApiClient` - top-level SDK client (`meta`, `data` for rest-1, `assets` for api/asset, `localize` for loc-2, `schema`), and the services on it:
  - `queryV1.query` / `queryV1.queries` - reads through query.v1: the same query bodies as `assets.query`, rows translated the same way, but the endpoint is read-only and answers with rows alone, so it is the safe place to explore a query
  - `resolve.numbers` / `resolve.ref` - asset numbers and OID tokens to assets, in one request
  - `assets.sendGuarded` - a batch as a compare-and-set on each asset's ChangeDate; changed assets come back `skipped`
  - `attachments.list` / `page` / `info` / `get` / `add` / `put` / `remove` / `url` - files attached to an asset: metadata on the Attachment asset, bytes through attachment.img; `page` adds the total and whether more pages follow; `get`'s `contentType` is the type the server sent the bytes with; `add` sends a small file inline (Base64, one request) and a large one in two steps (create, then upload), and a failed upload throws `AttachmentUploadError` naming the empty attachment it left
  - `embeddedImages.upload` / `url` / `normalize` - images in rich text: upload returns the `<img src>` URL; `normalize` rewrites `embedded.img` references to this instance's URL. They cannot be deleted
  - `batch.run` / `batch.reversible` - preview, snapshot, (confirm,) send guarded, and a receipt with a reverse batch. Undo (`batch.reversible`) reactivates a closed asset before deleting it, and a second command on one asset is sent as a second guarded pass. The reverse uses only operations the type has in meta (a created Conversation, which has no `Delete`, is a note), and undoing an `Inactivate` or `QuickClose` reopens the descendants that close cascaded to (`receipt.openDescendants`, `receipt.cascaded`), parent first. A command the server reports as failed lands in `receipt.failed`, not `skipped`. `confirm` sees the touched assets' names; aliased updates/executes are sent as written with `guard: false`; a failure after the send throws `BatchRecordError` carrying the receipt
- `TypeCache` - one instance's loaded type definitions, shared by many clients (`new AgilityApiClient(config, { types })`): a server that builds a client per user fetches each type once
- `createFetchTransport` - configurable HTTP transport: `credentials` for same-origin cookie auth, `onUnauthorized` to re-authenticate on a 401 (resends idempotent requests once), and a per-request `signal`; `client.withSignal(signal)` ties a whole client to one
- `ApiError` - typed API error; `CommandFailureError` - an api/asset batch in which commands failed (`failures` by index, plus the `response`)

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
dist-tag (`alpha`, `beta`, `rc`), so `latest` is never a prerelease.

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
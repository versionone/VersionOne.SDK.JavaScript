# VersionOne SDK (TypeScript starter)

Minimal TypeScript SDK starter for building JavaScript bindings to external APIs.

## Quick start

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
  - `batch.run` / `batch.reversible` - preview, snapshot, (confirm,) send guarded, and a receipt with a reverse batch. Undo (`batch.reversible`) reactivates a closed asset before deleting it, and a second command on one asset is sent as a second guarded pass. `confirm` sees the touched assets' names; aliased updates/executes are sent as written with `guard: false`; a failure after the send throws `BatchRecordError` carrying the receipt
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

## Before PR

- Run `npm run verify` to validate typecheck, build, and tests before opening a pull request.
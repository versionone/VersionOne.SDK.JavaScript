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

- `AgilityApiClient` - top-level SDK client (`meta`, `data` for rest-1, `assets` for api/asset, `schema`)
- `createFetchTransport` - configurable HTTP transport
- `ApiError` - typed API error; `CommandFailureError` - an api/asset batch in which commands failed (`failures` by index, plus the `response`)

API reference: https://docs.digital.ai/agility-api/

## Extend with new APIs

1. Add a new folder under `src/apis/`.
2. Add request/response types under `src/types/`.
3. Implement methods using `Transport.request`.
4. Export from `src/index.ts`.
5. Add tests under `test/`.

## Before PR

- Run `npm run verify` to validate typecheck, build, and tests before opening a pull request.
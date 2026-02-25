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
- `npm run verify` - run lint + build + tests
- `npm run test` - run unit tests
- `npm run lint` - run ESLint

## Public API

- `VersionOneClient` - top-level SDK client
- `createFetchTransport` - configurable HTTP transport
- `ApiError` - typed API error

## Extend with new APIs

1. Add a new folder under `src/apis/`.
2. Add request/response types under `src/types/`.
3. Implement methods using `Transport.request`.
4. Export from `src/index.ts`.
5. Add tests under `test/`.

## Before PR

- Run `npm run verify` to validate lint, build, and tests before opening a pull request.
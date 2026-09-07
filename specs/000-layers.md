# Spec 000: Layers

Invariants for how this SDK is arranged. A change that creates, alters, or
removes one of these changes this file in the same commit.
`test/unit/layers.test.ts` enforces the mechanical parts.

## 1. Three layers, one direction

```
src/types      what things are        imports: nothing above it
src/wire       endpoint envelopes     imports: types, core
src/services   what to do             imports: types, wire, core
src/core       transport, errors      imports: nothing above it
```

- **`types`** is the vocabulary: the asset types generated from meta.v1
  (`src/types/assets/`, one file per asset type, the `extends` chain from
  the metamodel's `Base` chain) and the hand-written roots in
  `src/types/asset.ts` (`Asset`, `Ref`, `Oid`, `DateString`,
  `AssetStateValue`, `CustomAttributes`).
- **`wire`** is one module per endpoint (`assetApi`, `rest1`, `queryV1`,
  `meta`, `loc2`, `validValues`, `attachment`, …). Each knows exactly two
  things: the envelope its endpoint takes and returns, typed as the server
  spells it, and the translation between that envelope and `types`.
- **`services`** reason about assets and compose wire modules (`schema`,
  `resolve`, `guard`, `batch`, …). They know no envelope.
- **`core`** is HTTP: `Transport`, `createFetchTransport`, `ApiError`. It
  does not know what an asset is.

Imports point down the table and never up. `types` never imports `wire`;
`wire` never imports `services`; nothing imports a `test/` file.

## 2. One shape

The objects the SDK passes around have **one shape**, wherever they came
from or are going. A relation is a `Ref` (`{ _oid }` plus whatever a select
pulled through) in a create, in an update, and in a query result alike.
`AssetState` has one set of values. Whatever an endpoint spells differently
— api/asset writing a relation as an OID token, rest-1 wrapping every value
in `Attributes` and rendering `AssetState` as a number — is translated in
that endpoint's wire module, once, on the way in and on the way out.

Corollaries:

- Envelope types live **inside the wire module that owns them**
  (`AssetApiResponse` is in `src/wire/assetApi.ts`), never in `types`. A
  caller holding a model object cannot tell which endpoint produced it.
- If a caller has to convert, the layer is missing a translation. Fix the
  layer.
- No business rule lives in a type or a wire module.

## 2a. Translation needs the schema

api/asset and query.v1 spell **every scalar as a string** (`"5"`, `"False"`,
`"-1989738965"`) and a **single relation selected with a sub-select as a
one-element list** (`[{ _oid }]`, `[]` when unset), while a bare single
relation is `{ _oid }` (verified on a dev instance, 2026-09-07). Whether
`"True"` is a boolean or text, and whether `[x]` is one Ref or a list of
one, is not decidable from the value: it takes the attribute's definition.

So the `assetApi` wire module translates a row against an `AttributeLookup`
(`src/types/metamodel.ts`): each key is a select path resolved hop by hop
(`src/wire/select.ts` — dotted paths, `:Downcast`, `[filter]`, `@Count`)
to the attribute it lands on; Numeric and LongInt become numbers, Boolean
booleans, a single relation one Ref or null, an aggregate a number, and a
sub-select's rows are translated by their own type. A key the schema does
not know is left as sent. Without a lookup the row keeps the endpoint's
spelling, OIDs normalised — never silently guessed.

The lookup is the `schema` service: the instance's types, loaded from
meta.v1 one type at a time as queries need them (in-flight requests shared,
a type the instance lacks remembered as absent), or seeded whole from a
metamodel document. The client runs `schema.ensureFor(commands)` before
every api/asset read, so a consumer never sees the untranslated shape.
rest-1 needs none of this: its JSON carries typed scalars and marks
relations with `_type: "Relation"`.

Corollary: a fake in a unit test must send what the server sends. The unit
test that faked `Estimate: 3` passed for a day while the server was
sending `"5"`; rows in fakes are now copied from live responses.

## 3. Names are meta.v1's names

Asset type tokens and attribute names are spelled exactly as meta.v1
returns them: `Story`, `PrimaryWorkitem`, `Owners`, `Super`. No renaming,
no casing changes, no app-local aliases. Joined paths (`Status.Name`) are
select spellings, not fields, and are not generated.

## 4. Generated means generated

`src/types/assets/` is produced by `scripts/generate-types.mjs` from the
committed `metamodel.json` and is not edited by hand. The metamodel is a
canned-only pull from a reset dev instance. Generation rules:

- an attribute the type defines itself has no `Base`; inherited ones come
  through `extends`;
- generated when `IsCanned` (the product's canned "custom" attributes —
  `Reference`, `Source`, `RequestedBy`, `LastVersion`, `OriginalEstimate`,
  the `*Source` reverse lists — ship everywhere and are generated); an
  instance's own custom attributes (`IsCustom` and not `IsCanned`, always
  `Custom_`-prefixed) are not, and ride on the `Custom_${string}` index
  signature of `Asset`;
- `Relation` → `Ref<Target>` or `Ref<Target>[]`; `AssetType` → the literal
  union of the type's concrete descendants; `Blob` is not a model value;
- optional (`| null`) unless `IsRequired` or multi-value; `readonly` from
  `IsReadOnly`.

The unit test regenerates into a temp directory and requires it to equal the
committed files.

## 5. Two test tiers

- **Unit** (`test/unit/**`, `npm test`): a fake `Transport`; what was sent,
  what came back, translation both ways. Runs with nothing.
- **Integration** (`test/integration/**`, `npm run test:integration`): the
  same modules against a real dev instance, resolved by
  `test/integration/instance.ts`; skips with a message when none is
  configured; **refuses a production URL**. Fixtures are named
  `sdk-integration …` and deleted by the suite that made them.

The API's real behaviours — silent empties, projection order, full-text
index lag, what a preview echoes — are what fakes cannot reproduce; the
integration tier is where a live probe becomes permanent, with an
expect-zero control beside every "it returned rows".

## 6. Politeness is in the layer

No read is unbounded: `assetApi.queries` refuses a query without a page,
and the rest-1 module will refuse a Data read without one. The transport
retries only idempotent requests (GET by default), only on a network
failure or a 5xx, never a 4xx; a batch write is never retried unless the
caller has made it idempotent with a guard and says so.

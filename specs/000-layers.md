# Spec 000: Layers

Invariants for how this SDK is arranged. A change that creates, alters, or
removes one of these changes this file in the same commit.
`test/unit/layers.test.ts` enforces the mechanical parts.

## 1. Three layers, one direction

```
src/types      what things are        imports: core (its errors only)
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
  `meta`, `loc2`, `attachment`, `fields`, …). Each knows exactly two
  things: the envelope its endpoint takes and returns, typed as the server
  spells it, and the translation between that envelope and `types`.
- **`services`** reason about assets and compose wire modules (`schema`,
  `resolve`, `guard`, `batch`, …). They know no envelope.
- **`core`** is HTTP and errors: `Transport`, `createFetchTransport`,
  `ApiError` and its kinds. It does not know what an asset is.

Imports point down the table and never up. `types` never imports `wire`;
`wire` never imports `services`; nothing imports a `test/` file. `types`
imports `core` for one reason: a string that is not an OID token is a
`UsageError` like every other mistake the SDK catches.

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
to the attribute it lands on; Numeric, LongInt and Rank become numbers, Boolean
booleans, a single relation one Ref or null (the endpoint sends an unset
one as `{ _oid: "NULL" }`), an aggregate a number, and a
sub-select's rows are translated by their own type. A `group` query's
rows are groups (`_oid` the group key, `null` for the unset group; rows
under `_children`), and the children translate by the query's own type,
recursively for nested groups. A key the schema does
not know is left as sent. Without a lookup the row keeps the endpoint's
spelling, OIDs normalised and a `NULL` relation null — never silently
guessed.

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
committed `metamodel.json` and is not edited by hand. The metamodel is the
product's, for one release (its `Version`, which the generated headers
and the README repeat): a pull by `scripts/download-metamodel.mjs`, which
strips an instance's own definitions (its `Custom_` list types, its
custom and `ReciprocalOf_` attributes) and reports what it removed, and
spells every `href` from `/meta.v1/` (the server spells them from the
instance's own path, which names the instance), so a dev instance on a
blank database and a hosted instance on the same release give the same
file, and the file names no instance. Refresh it, and regenerate, as a
step of each release. Generation rules:

- an attribute the type defines itself has no `Base`; inherited ones come
  through `extends`;
- generated when `IsCanned` (the product's canned "custom" attributes —
  `Reference`, `Source`, `RequestedBy`, `LastVersion`, `OriginalEstimate`,
  the `*Source` reverse lists — ship everywhere and are generated); an
  instance's own custom attributes (`IsCustom` and not `IsCanned`:
  `Custom_`-prefixed, or `ReciprocalOf_`-prefixed for the reverse side the
  server adds to a custom relation's target) are not, and ride on the
  `Custom_${string}` / `ReciprocalOf_${string}` index signatures of
  `Asset`. An instance's own asset types — only subtypes of `List`,
  spelled `Custom_<Name>` — are not generated either; the typed query layer
  reads one as `CustomList` (List's attributes, its own token as
  AssetType), and the schema service loads it from meta.v1 like any type;
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
  same modules against a real instance, resolved by
  `test/integration/instance.ts`; skips with a message when none is
  configured. It runs only where fixtures may be written: a local dev
  instance, or a hosted instance listed in `API_TEST_INSTANCES` as set
  aside for API testing (today `www14.v1host.com/v1sdktesting`); any other
  hosted URL and anything named V1Production is **refused**. A suite that
  recycles the app domain (custom fields) runs on local instances only.
  Suites bring their own data — a hosted testing instance may be nearly
  empty (it had no StoryStatus at all on 2026-11-04) — and fixtures are
  named `sdk-integration …` and deleted by exact OID by the suite that made
  them.

The API's real behaviours — silent empties, projection order, full-text
index lag, what a preview echoes — are what fakes cannot reproduce; the
integration tier is where a live probe becomes permanent, with an
expect-zero control beside every "it returned rows".

## 6. Politeness is in the layer

No read is unbounded: `assetApi.queries` and `queryV1.queries` refuse a
query without a page, and the rest-1 module refuses a Data read without
one. rest-1 carries no attribute writes — api/asset does those — and one
narrow write, `operate`: an operation run for its result (the OID a Copy
made), which api/asset's `execute` performs but does not report. The transport
retries only idempotent requests (GET by default, and every query.v1
POST, since that endpoint cannot write), only on a network
failure, a 5xx or a 429 (Retry-After honoured, up to 30 s), never
another 4xx, and once by default (`retries: 1`); a batch write is never retried unless the
caller has made it idempotent with a guard and says so.

Re-authentication follows the same rule. On a 401 (or a status the caller
lists) the transport calls `onUnauthorized` once per request; "retry" resends
an idempotent request one more time, outside the `retries` count. A plain
write is never resent: the hook still runs, so the session can be repaired,
and the caller decides. A caller's abort (`signal`) ends the request as
`ABORTED` and is never retried.

A failure never reads as an empty. api/asset answers 200 and commits per
command, so a failed command is reported inside the envelope
(`commandFailures`, each by `sourceCommandIndex`). `assetApi.send` returns
it there by default and throws a `CommandFailureError` (an `ApiError`
carrying every failure by index and the whole translated response, so
what did commit is still known) when asked with `throwOnFailure`. Reads —
`assetApi.query`/`queries`, and the client's `assets.query`/`queries` —
always throw: a query the server rejected must not come back as `[]`.
The server drops a failed query's slot from `queryResult.results` (later
results shift up); `send` restores it as `null` by `sourceCommandIndex`, so
positions always match the queries sent, and refuses to guess when the
counts disagree. If a failure carries no sourceCommandIndex it may be any
of the queries, so every query slot is null and the failures are the
answer (thrown for reads and with throwOnFailure); a disagreement with no
such failure is an error of its own.

The guard (`services/guard`) is what makes a write batch safe to resend:
each per-asset command of the server's projection is sent scoped to its
ID and the ChangeDate read just before, so a stale or repeated command
matches nothing. ChangeDate goes in the filter as a literal — the one
exception to "values travel as `with` variables", because a ChangeDate
variable never compares equal — after a strict timestamp check. Moment is
not a stamp: a filter on an earlier Moment selects the asset as it was then.
A guarded batch with no creates is sent idempotent; a plain one never is.
Two commands on one asset are sent in passes: the second goes only if the
first applied, guarded on the ChangeDate read just after it (a shared
pre-batch stamp would make the second match nothing). A reverse batch
reactivates a closed asset before deleting it, since Agility refuses to
delete a closed asset.

## 7. One error, one kind

Everything the SDK throws is an `ApiError` (`src/core/errors.ts`), and
every `ApiError` has a `kind`: `auth`, `forbidden`, `notFound`, `invalid`,
`transient`, `aborted`, `commandFailure`, `protocol`, `usage` or
`unknown`. `status` and `code` say what happened; `kind` says what to do.
A mistake the SDK catches before any request (an unpaged read, an empty
batch, a bad OID token) is a `UsageError` (`kind: "usage"`, `status: 0`),
never a bare `Error` or `TypeError`. An error raised around another (a
batch send that failed, an upload that failed after its create) is a
`WrappedError` carrying the cause and the cause's kind, so the branch a
caller wrote on `kind` still holds. api/asset's validation messages
(`Violation'Required'AttributeDefinition'Scope'Story`) are parsed onto
each failure as `violation` (rule, attribute token, loc-2 tag); nobody
matches that text by hand.

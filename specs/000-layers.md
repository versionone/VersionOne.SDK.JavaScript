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

Beside the table, not in it: `src/client.ts` binds the layers into the
client, and `src/testing` (§5a) stands on the client. Nothing imports
`src/testing`.

- **`types`** is the vocabulary: the asset types generated from meta.v1
  (`src/types/assets/`, one file per asset type, the `extends` chain from
  the metamodel's `Base` chain) and the hand-written roots in
  `src/types/asset.ts` (`Asset`, `Ref`, `Oid`, `DateString`,
  `AssetStateValue`, `CustomAttributes`), and the vocabulary of a batch in
  `src/types/command.ts`: what a caller writes (`QueryBody`, `Command`)
  and what a batch did in the model's terms (`Outcome`).
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
from or are going. A relation is a `Ref` (`{ _oid }`, plus what a sub-select asked for) in a create, in an update, and in a query result alike.
`AssetState` has one set of values. Whatever an endpoint spells differently
— api/asset writing a relation as an OID token, rest-1 wrapping every value
in `Attributes` and rendering `AssetState` as a number — is translated in
that endpoint's wire module, once, on the way in and on the way out.

A date is one of those spellings. query.v1 writes seven decimals,
api/asset drops trailing zeros, rest-1 writes three and a midnight as the
date alone; the model's `DateString` is `2026-09-06T13:52:51.903` (with
`Z` on a UTC attribute), the standard's date-time format, and every read
answers it. That cuts to the millisecond, by design: finer than the
server stores (about three milliseconds), so nothing observed is lost.
The schema says which attribute is a date: text that looks like one is
never touched.

A row's identity is `_oid`: the key the server sends for it, underscored
so that it can never collide with an attribute (an asset's own identity
attribute is `ID`). Every row has it, and so does anything that is a row
or stands for one (a Ref, a resolved asset, an attachment, the assets on
a receipt). A record that is not a row but mentions an asset — a
described update, a drifted entry — says plain `oid`.

One rule for a row, on every read path (query.v1, api/asset, rest-1):
**a relation you select is a Ref; a path you select by name is at
`row[path]`; nothing arrives that you did not select.** A sub-select is
how to ask for attributes on the related rows. A Ref is `{ _oid }` and
nothing more unless a sub-select put attributes on it. rest-1 sends
display columns beside a selected relation unasked (`Owners.Name`); its
wire module drops them unless that path was selected, in which case the
value is at `row[path]` like any path. They are never put on the Ref: a
row must not differ by which endpoint answered it. Where a read has no
select at all (a template), the server chose the attributes and every
column it sent stays under its own key. An integration test reads one
asset through all three paths and compares the rows.

One addition, for the one read whose page mixes unrelated types
(`client.search`): **you name an attribute once, plainly, and each row has
that key — its value if the row's type defines the attribute, null if it
does not** (so null on every row when none of the searched types has it;
only a name that is no attribute of any type is refused). This is the only place a row carries a key its own type lacks.
The caller never writes or reads a type-qualified name (`Story.Number`):
the schema says which of the searched types define `Number`, the service
asks each, and the key is `Number`. A relation on such a row is a bare
`{ _oid }`; a display value is asked for as a path (`"Scope.Name"`). None
of this depends on which endpoint answers the search: rest-1 does today,
because it alone takes a subtype's attribute from a base type on
instances before the release that lets api/asset do it, and the route may
move without the call or its rows changing.

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
  instance, or a hosted instance set aside for API testing and named in
  `SDK_TEST_ALLOWED_INSTANCES` (no such URL is committed: an instance's URL
  is its name, and this repository is public); any other hosted URL and
  anything named V1Production is **refused**. A suite that
  recycles the app domain (custom fields) runs on local instances only.
  Suites bring their own data and assume nothing about what else the
  instance holds, and fixtures are named `sdk-integration …` and deleted
  by exact OID by the suite that made them. The API-testing instance also
  holds a little permanent reference data (AGENTS.md lists it by OID):
  nothing creates, edits or deletes it, and `deleteFixtures` refuses a
  list that contains any of it.

The API's real behaviours — silent empties, projection order, full-text
index lag, what a preview echoes — are what fakes cannot reproduce; the
integration tier is where a live probe becomes permanent, with an
expect-zero control beside every "it returned rows".

## 5a. Four import paths, and a fake for consumers

The package has four entries: the root (the client, the model, the errors
and what a client user imports), `/wire` (the wire modules, for
passthroughs and transport authors), `/services` (the services as free
functions over a Transport; their request sequences are internal) and
`/testing`. All of them, and the chunks they share, are built into one
flat `dist/` directory: a consumer that vendors the package copies that
directory. They are built with shared chunks in both module
formats, so a class is one class whichever path imported it; the CommonJS
unit test proves it.

`/testing` holds `FakeAgilityClient`: the real client over a transport
that sends nothing. It is scripted in the **model's** shape, the one shape
of §2, because that is the contract a consumer codes against; it runs with
a schema that knows no type, so scripted rows pass through as written. It
therefore proves nothing about translation or about the server, and says
so: it evaluates no filter, applies no write, and throws for a read
nothing was scripted for (§6: a failure never reads as an empty). The
corollary of §2a still binds this repository's own unit tests, which fake
the *transport* with what the server sends.

## 6. Politeness is in the layer

No read is unbounded: `assetApi.queries` and `queryV1.queries` refuse a
query without a page, and the rest-1 module refuses a Data read without
one. rest-1 carries no attribute writes — api/asset does those — and one
narrow write, `operate`: an operation run for its result (the OID a Copy
made), which api/asset's `execute` performs but does not report. The transport
retries only idempotent requests (GET by default, and every query.v1
POST, since that endpoint cannot write), only on a network
failure, a 5xx or a 429 (Retry-After honoured, up to 30 s), never
another 4xx, never after a timeout (below), and once by default (`retries: 1`); a batch write is never retried, guarded or not (below). That rule is
the client's, not one transport's: the built-in fetch transport applies it
itself (it can read Retry-After), and the client applies it around a
custom Transport (`core/retry`), so a consumer's transport does not
re-implement it and cannot forget it. Each rule is applied once, in one
place: the transport `createFetchTransport` returns declares that it
times its attempts and resends by the rule itself (`governsItself`), and
the client then adds neither, whether it made that transport or was
handed it; every other transport gets both from the client. (The rule
stays inside the built-in transport because only there is the response
at hand, with its Retry-After. Before this was declared, a built-in
transport handed to a client got the rule twice and sent a failed read
four times.) A caller's wrapper around the built-in transport is a
custom transport, and its author gives the inner one `retries: 0,
timeoutMs: 0`. `retries: 0` turns it off for a
client. A 401 or 403 is never resent by it.

So is the timeout. Each attempt has `timeoutMs` (60 s unless told; 0 for
none), and when it has passed the request rejects with `TIMEOUT`, a
transient failure. The client enforces this above a custom transport: it
hands the transport a signal that fires at the deadline, and it stops
waiting at the deadline whether or not the transport lets go. What an
abandoned request answers later is discarded. A transport therefore owes
nothing about timing beyond honouring `signal`, which the conformance
suite checks; one with a shorter timeout of its own simply rejects first.
A timeout says the client stopped waiting, never that the server did not
act, which is one more reason a write is not resent.

One endpoint cannot be bounded at all: api/ValidValues takes no page and no
filter, and answers for any attribute. The lists service therefore asks it
only for relations to a list type (one that descends from List), which are
short by nature, and refuses every other attribute before sending, naming
the bounded read to use instead. The wire module says in its header that a
caller using it directly takes that care itself.

**Nothing is resent after a timeout, a read included.** A timeout or an
abort ends the client's wait; it does not stop the work on the server. A
query that timed out may still be running, and a request that ran out of
time is likely one that costs a lot, so sending it again runs the cost
twice and makes the caller wait twice. That holds whoever gave up: the
client (`TIMEOUT`), the server (408) or a gateway in front of it (504).
The server also has a timeout of its own on the SQL a request runs, and
answers it as an error document, not a status: `exceptions` holding a
`SqlException` whose message begins "Execution Timeout Expired" (and a
`Win32Exception` "The wait operation timed out"). `apiErrorFromResponse`
codes that `SERVER_TIMEOUT`, whatever the status, and it is not resent
either: the same request would cost the same. The remedy is a smaller
request (page, selected paths, filter), which `explain` says.
`pages` and `all` stop at the first timeout rather than pressing on. A
caller that wants to try again does so itself, knowing the cost. The deadline cannot
tell the network from a person: a custom transport that waits for someone
inside `request` turns the client's timeout off (`timeoutMs: 0`), and the
built-in transport's re-authentication hook runs outside the deadline.

Re-authentication follows the same rule. On a 401 (or a status the caller
lists) the transport calls `onUnauthorized` once per request; "retry" resends
an idempotent request one more time, outside the `retries` count. A plain
write is never resent: the hook still runs, so the session can be repaired,
and the caller decides. There is one way round that, and it is the
consumer's assertion, not the SDK's: a hook that answers "retry-write"
has the refused request sent once more, a plain write included, on its
own word that on its server such a refusal means nothing in the request
was executed. The premise has been checked by a consumer, on one product
release: an api/asset create sent with no session, with an invalid one,
and with a credential that had been valid and expired was each answered
401 before any command ran, and nothing was created; with the expired
credential a rest-1 attribute write was refused the same way and not
applied. It has not been checked for a 403, on other releases, or for
other ways of signing in, and the SDK's own tests (which run where every
request is authenticated) check none of it. So the SDK never assumes it. A guarded write is a write here
too: `retryable` is false for it, and "retry-write" is what resumes it. A request sent with `reauthorize: false` skips
the hook: it is how a hook asks whether the session is alive without
waiting on itself. A caller's abort (`signal`) ends the request as
`ABORTED` and is never retried.

A failure never reads as an empty. api/asset answers 200 and commits per
command, so a failed command is reported inside the envelope
(`commandFailures`, each by `sourceCommandIndex`). `assetApi.send` returns
it there by default and throws a `CommandFailureError` (an `ApiError`
carrying every failure by index and the whole translated response, so
what did commit is still known) when asked with `throwOnFailure`. Reads —
`assetApi.query`/`queries`, and the client's `query`/`queries`/`queryPage` —
always throw: a query the server rejected must not come back as `[]`.
The server drops a failed query's slot from `queryResult.results` (later
results shift up); `send` restores it as `null` by `sourceCommandIndex`, so
positions always match the queries sent, and refuses to guess when the
counts disagree. If a failure carries no sourceCommandIndex it may be any
of the queries, so every query slot is null and the failures are the
answer (thrown for reads and with throwOnFailure); a disagreement with no
such failure is an error of its own.

The guard (`services/guard`) is what makes a write safe to repeat by a
caller who has looked again: each per-asset command of the server's projection is sent scoped to the
asset at the Moment read just before (`where { ID, Moment }`) and to that
version still being the current one (`filter RetireDateUTC=''`), so a stale
or repeated command matches nothing. The two terms always travel together:
a Moment alone selects the asset as it was then, and a write scoped by it
lands on the current asset; the filter alone is a server error. Both values
are `with` variables, like every value. A command that matched lists its
asset in the response even when it changed no value, so an asset the
response does not list, and that no failure names, matched nothing: a
**conflict** (`conflicts`, or a `ConflictError` with `throwOnFailure`),
never a success and never confused with a no-op. A caller may supply the
moment it read earlier, with the row a person is looking at; the guard then
compares against what they saw. What the guard cannot see is a change that
makes no new version of the asset (a child added to it): it protects an
asset's own attributes.

**A guarded batch is not resent automatically either.** A second send
harms no data (it matches nothing), but "matched nothing" is how a
conflict reads: if the first send landed and its answer was lost, the
resend would tell the caller that someone else changed the asset and
nothing was applied, about the caller's own change. An honest "unknown"
is better than that. So no write is ever marked idempotent; a guarded
write with no confirmation is explained as an unconfirmed change
(`outcome: "unknown"`), and the caller reads the asset again and
decides. Two commands on one asset are sent in
passes: the second goes only if the first applied, guarded on the Moment
read just after it (the response does not say the new moment, and a shared
pre-batch stamp would make the second match nothing). `batch.run` takes
`guard: true | false` with no default: which one a batch wants is the
caller's decision. A receipt records Moments (`receipt: 2`); one from
before that cannot be checked for drift and is refused unless forced. A
reverse batch reactivates a closed asset before deleting it, since Agility
refuses to delete a closed asset.

## 7. One error, one kind

Everything the SDK throws is an `ApiError` (`src/core/errors.ts`), and
every `ApiError` has a `kind`: `auth`, `forbidden`, `notFound`, `invalid`,
`transient`, `aborted`, `commandFailure`, `conflict`, `protocol`, `usage` or
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

## 8. Nothing private in the tree

This repository is public, and its history is permanent. Nothing committed
here names a private repository, a Claude session, a person, or a hosted
instance; a consumer is "a CLI consumer", "a chat-bot consumer", "a browser
app consumer" (a public one may be named); the product's source is "the
server"; a fixture copied from a live response carries a fictitious
identity and a fictitious base URL. Plans, surveys and hand-offs between
sessions live outside this repository (`CONTRIBUTING.md` says where);
`specs/` holds invariants of this code and nothing else.
`test/unit/publicTree.test.ts` enforces the mechanical parts: no session
id, no GitHub repository slug but this one, no hosted instance URL at all
(examples use a fictitious domain), and every metamodel `href` from
`/meta.v1/`.

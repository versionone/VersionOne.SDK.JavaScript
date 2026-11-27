# @versionone/agility-sdk

TypeScript SDK for the Digital.ai Agility (formerly VersionOne) API. It works in Node 22 or later (ESM or CommonJS) and the browser, ships its own types, and has no runtime dependencies.

Not to be confused with `v1sdk`, the 2.x JavaScript SDK: this is a new API, not a compatible successor.

## Install

Alpha releases are for feedback; the API may change between them.

```bash
npm install @versionone/agility-sdk@alpha
```

```ts
import { AgilityApiClient } from "@versionone/agility-sdk";

const client = new AgilityApiClient({ baseUrl: "https://agility.example.com/MyInstance", accessToken: process.env.V1_ACCESS_TOKEN });
const stories = await client.query({ from: "Story", select: ["Name", "Estimate"], page: { size: 10, start: 0 } });
// stories[0].Estimate is a number | null; stories[0].Nmae does not compile
```

Runnable examples, one per task (a first read, a write, a guarded write, a batch with an undo, errors, attachments, testing your own code, a transport of your own, a browser session that expires, searching, a transport over axios), are in [`examples/`](examples/README.md).

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
- `npm run download:metamodel -- <baseAgilityUrl>` - refresh `metamodel.json` from an instance on the current release (instance-specific definitions stripped; `--raw` keeps them), then `npm run generate:types`. The cleanest source is a dev instance on a blank database (the product's dev tooling has a task for that); a hosted instance on the release gives the same file. The generated model is from meta.v1 **26.3.2.13** (hosted, 2026-11-14)

## Public API

### Which call for what

| You want | Call | Notes |
| --- | --- | --- |
| Rows | `client.query(q)` / `client.queries([q, …])` | The default read. Read-only endpoint, resent once like a GET. No total. |
| One asset | `client.get(oid, select)` | Null when nothing has that OID. |
| Rows and how many there are | `client.queryPage(q)` | `{ rows, total, more }`. |
| Everything, page by page | `client.pages(q, { limit })` / `client.all(q, { limit })` | Bounded: default limit 1000. |
| Text search across asset types | `client.search(text, { types, page })` | One page of mixed rows, one order, `{ rows, total, more }`; `Number` on every row whose type has one. See "Searching". |
| Text search within one type or family | `client.query({ from, find, findin, … })` | An ordinary read with two more keys. `queryPage` adds the total. |
| Deleted assets | `client.deleted(type, params)` | No other read returns one. |
| An asset's past versions | `client.history(oid, params)` | One row per version; `_oid` carries the moment. |
| Who am I | `client.me()` | The member the credentials belong to. |
| Numbers and OIDs a person typed | `client.resolve.numbers([...])` / `client.resolve.refs([...])` | Answered as rows. One request for numbers of any mix of types. |
| Write | `client.send(commands)` | Unguarded: writes whatever is there. Answers an `Outcome`; `unmatched` lists commands whose asset was gone. |
| Write only if nobody changed it | `client.sendGuarded(commands, { moments? })` | `conflicts` lists what was left alone. |
| Write with a record and an undo | `client.batch.run(commands, { guard })` then `client.batch.reversible(receipt)` | `guard` has no default. |
| Copy an asset, or run an operation for its result | `client.copy(oid)` / `client.operate(oid, op)` | |
| Defaults for a new asset | `client.template(type, { ctx })` | Nothing is created. |
| What a form needs | `client.fields.describe(type, scope)` | Required, visible and important attributes, and which of them are list-typed. |
| The values a Status, Priority or other list may take | `client.lists.values({ asset, attributes })` or `{ type, scope, team?, attributes }` | As the project's scheme and the team's process allow. See "List values". |
| The value a name means | `client.lists.value({ asset, attribute, name })` | `{ _oid, Name }` to write; `NO_SUCH_VALUE` with the valid values otherwise. |
| Files | `client.attachments.*`, `client.embeddedImages.*` | |
| A link for a person | `client.urls.asset(oidOrNumber)` | |
| An error, said to a person | `client.explain(error)` | "Project is required.", with the instance's labels. |
| Labels in the instance's words | `client.localize(tags)` | |

Every row follows one rule, whichever call read it: **a relation you select is a Ref (`{ _oid }`); a path you select by name is at `row[path]` (`row["Status.Name"]`); nothing arrives that you did not select.** Select both `Owners` and `Owners.Name` and you get the Refs and, beside them, a parallel array at `"Owners.Name"`. To get attributes on the related rows themselves, use a sub-select: `{ from: "Owners", select: ["Name"] }` gives `row.Owners[i].Name`.

A row's identity is `_oid`: it is the key the server sends, underscored so it cannot collide with an attribute (the identity attribute is `ID`). Rows, Refs, resolved assets, attachments and the assets on a receipt all carry it; a record that only mentions an asset (a receipt's `described` entries, a `drifted` entry) says `oid`.

### Searching

A text search is a read with `find` (the text) and `findin` (the attributes to look in). It composes with `filter`, `sort` and `page`, and `queryPage` answers its total.

```ts
const hits = await client.query({
  from: "Workitem",                       // stories, defects, epics, themes, tasks, tests, test sets
  select: ["Name", "Number", "AssetType"],
  find: "warehouse ship*",
  findin: ["Name", "Number"],
  page: { size: 25, start: 0 }
});
```

What the server does with the text (each of these is a live test in `test/integration/search.test.ts`):

- **Every word must match**, in any order, in any letter case. Punctuation separates words.
- **Whole words**, with the server's stemming ("shipping" finds "ship"). Part of a word finds nothing unless it ends in `*`: `integrat*` finds "integration". A leading `*` does not work.
- **A number is text too**: `find: "S-01001", findin: ["Number"]` finds that story, in either case.
- **Always send `findin`.** Without it the attributes searched depend on the type.
- **The text index trails a write by a few seconds.** An asset created a moment ago is found by its Number at once and by its words shortly after; do not search by name for what you just created.
- Closed assets are found; deleted ones are not.
- An attribute `findin` does not know is a refused query (`QUERY_REJECTED`), not an empty result.
- **An empty `find` is a usage error.** The server answers a search for nothing with no rows, which would read as "nothing matches"; leave `find` out to read without searching.

`from` decides how wide that read is: one type, or a family (`Workitem` is the backlog types, and has `Number`). It cannot give one page of unrelated types with their own attributes: `BaseAsset` is every asset but has no `Number`, and the query endpoints refuse a subtype's attribute there. That is what `client.search` is for.

#### Across types: `client.search`

```ts
const { rows, total, more } = await client.search("warehouse ship*", {
  types: ["Story", "Defect", "Epic", "Request", "Issue", "Goal"],   // required: there is no default
  select: ["Name", "Number", "AssetState", "Scope.Name", "Owners", "Owner"],
  filter: ["AssetState!='Closed'"],
  sort: ["-ChangeDateUTC"],
  page: { size: 25, start: 0 }
});
// rows[0].Number is "S-01042" for a Story and "R-01011" for a Request
```

- **One request, one order across every type, and the total.** The matching rules above apply.
- **`types` is required**, at least one: concrete types, or a family by its abstract type (`"Workitem"` is stories, defects, epics, themes, tasks, tests and test sets; requests, issues and goals are not work items, so name them). A default would silently leave types out.
- **You name an attribute once, plainly, and each row has that key**: its value if the row's type defines it, `null` if not (`Owners` is null on a Request, `Owner` null on a Story; the SDK does not merge differently named attributes). That holds when none of the searched types has it too: every row has `null`, so one list of columns serves whatever types a user picks. Only a name that is no attribute of any asset type is a usage error (a misspelling). A `findin` name none of the searched types has is left out; if none is left, the search is refused.
- `select` defaults to `Name`, `Number`, `AssetType`, `AssetState`; `findin` defaults to `Name` and `Number`.
- A relation is a bare `{ _oid }`; ask for a display value as a path (`"Scope.Name"`, `"Owners.Name"`).
- **Selects are plain; filters are sent as written and may be type-qualified.** A select names a value, and the SDK can ask each type for it. A filter is an expression: a condition across types, such as "owned by me" when work items have `Owners` and requests have `Owner`, has no plain spelling, so you write it: `"(Workitem.Owners.IsSelf='true'|Request.Owner.IsSelf='true')"`. A term on an attribute every searched type shares (`AssetState`, `Scope.Name`) needs no qualifying. Qualify a term on any other attribute whatever `types` is: unqualified, it happens to be accepted when one type is searched and is refused when several are. `sort` is sent as written too.
- Deleted assets are never found; `client.deleted(type, params)` reads those.
- The first search loads the schema of each type searched (one request per type, then cached for the client, or shared through a `TypeCache`). A short-lived process that searches once pays that every time: seed the cache (`TypeCache.fromMetamodel`) or keep the client.
- To find one asset by its exact number, do not search: `client.resolve.numbers(["S-01042"])` is exact and does not wait for the text index.

A date is spelled one way on every read: `"2026-09-06T13:52:51.903"`, three decimals, with a `Z` on a UTC attribute (`ChangeDateUTC`). That is the standard's date-time format, so `new Date(value)` reads it in any engine. The endpoints each write dates differently, and the SDK answers this one spelling whichever of them was asked; it cuts to the millisecond, which is finer than the server stores. A value without a `Z` is the server's wall-clock time with no zone; for a day (a sprint's `BeginDate`) take `value.slice(0, 10)`.

Rows are typed from what you select, against the product's metamodel: a selected key is its value or `null`, never `undefined`. For an attribute your instance has and the generated model does not (a custom field's relation, a product module's attribute), name your own row type at the call: `client.query<MyRow>(q)` needs only `_oid` on `MyRow`.

### List values

Which values a list-typed attribute may take depends on where the asset is. `client.lists` asks the server, as the product's own pickers do:

```ts
// For an existing asset: its own project and team apply.
const { Status, Priority } = await client.lists.values({ asset: "Story:1077", attributes: ["Status", "Priority"], select: ["Order"] });
// → Status: [{ _oid: "StoryStatus:133", Name: "Future", Order: "115" }, …], in the list's own order

// For one not created yet: say where it will be.
await client.lists.values({ type: "Defect", scope: "Scope:1005", team: "Team:1030", attributes: ["Priority"] });

// From a name a person typed (or an OID) to the value to write.
const done = await client.lists.value({ asset: "Story:1077", attribute: "Status", name: "done" });
await client.send([{ from: "Story:1077", update: { Status: done._oid } }]);
```

- **What decides: the team's own values first, then the asset type's rule.** If the asset is on a team (or you name one) and that team owns values of the list, those are the answer, for any list: a team that owns statuses is offered its statuses, one that owned priorities its priorities. `{ asset }` alone applies that, so there is nothing to switch on; `team: null` asks as if the asset were on no team. This first step exists only on an instance with team workspaces enabled. Otherwise the asset type's own rule applies: for work items, issues, requests, goals, strategic themes, retrospectives, environments, regression tests and regression plans, the active values selected in the project's scheme; for members, budgets, projects, iterations, change sets, attachments and build runs, every active value, with no scheme involved.
- **An inactive value is left out**, "no value" is never an entry, and the order is the values' `Order`.
- **Resolve before you write: the server checks very little.** On a write, one thing is enforced: the Status of a story or defect against its team. A status owned by a team is refused on a work item that is not on that team, and a status owned by no team is refused on a work item whose team has statuses of its own (`Violation'PrimaryWorkitemCannotHaveInvalidStatus`). Nothing else is checked: a status the project's scheme does not select, an inactive status, and any Priority, Source, Category or other list value from anywhere are all accepted. Nothing but this lookup stops a write from setting a value the list would not offer.
- **A move can clear a status.** When a story or defect changes project or team and the same write does not set a Status, a status that is not valid in the new place (not among the new team's own, or else not selected in the new project's scheme) is set to empty, with no failure reported. Read the Status back after a move if you show it.
- **Valid is not the same as allowed.** A team can restrict which status may follow which, and which roles may make the change; a value `client.lists` offers can still be refused by such a workflow rule when written.
- **`lists.value` matches the whole name**, ignoring case and surrounding space. `match: "prefix"` also accepts the start of the name or of a word in it ("prog" finds "In Progress") when no name matches whole. It never picks among several: no match is an `ApiError` coded `NO_SUCH_VALUE`, more than one is `AMBIGUOUS_VALUE`, and both carry the candidates as rows in `error.details.values` (every valid value, or the ones that matched), ready to offer.
- **Only lists.** The server's endpoint takes no page and would answer every member, team or iteration it considers valid, so for `Owners`, `Team`, `Timebox` and any relation that is not to a list type, `client.lists` throws a `UsageError` before sending anything. Read those with `client.query({ from: "Member", filter, page })`, bounded like every other read.
- **Values are rows like any other.** `select` takes attributes of the value itself (`Order`, `RollupState`, `Team`): a number is a number, a Boolean a Boolean, a relation a Ref or `null`. Not a path, not a multi-value relation, and not a date, which the endpoint writes in the server's culture format.
- **An empty list means no value is valid, and the SDK keeps it meaning that.** The server answers "no values" also when it cannot work the rule out for lack of context, so the SDK always sends the project, and for a type whose rule needs more it asks you for it: `context: { RegressionPlan: "RegressionPlan:7" }` for a new regression suite. `context` takes any attribute of the asset to be.
- **Costs.** One request per attribute, sent together. Nothing is cached, because an administrator can change a scheme or a team's values at any time; the schema is cached as for every read, and telling a list from another relation needs the list type's own definition and nothing above it.
- **Availability.** The endpoint has been in the product since release 17.0. There is no fallback for an instance without it: the call fails as the server's 404.
- `client.fields.describe(type, scope).lists` says which of a form's attributes are list-typed and to which list type each points.

### Reference

Changes between alphas are in `CHANGELOG.md`, each with its migration line.

- `AgilityApiClient` - the client. One query body everywhere; the client picks the endpoint:
  - `query` / `queries` - rows, translated (numbers as numbers, booleans as booleans, a single relation as one `Ref`), through query.v1: read-only, so a request is retried like a GET. A page is required (by the type: an unpaged read does not compile); a refused query throws, never an empty result. Written with a literal `from`, `select` completes from the type's attributes and the rows are typed by what was selected
  - `get(oid, select)` - one asset or null; `queryPage(q)` - rows with the total and whether more follow (`more` is what a pager reads: when the server reports no total, `total` is null and `more` is whether the page came back full); `pages(q, { limit })` / `all(q, { limit })` - page by page up to a limit (default 1000); `me()` - the member the credentials belong to
  - `send` - an api/asset batch, answered as an `Outcome` (`created`, `modified`, `operated`, `failures` with parsed violations, `queryResults`); `throwOnFailure` throws a `CommandFailureError` carrying the same Outcome. `preview` - the projection. `sendGuarded` - a batch as a compare-and-set on each asset's Moment (read just before, or passed in as the one a person saw); an asset someone changed in between comes back in `conflicts`, untouched. It cannot see a change that makes no new version of the asset, such as a child added to it
  - `batch.run(commands, { guard })` / `batch.reversible` - preview, snapshot, (confirm,) send (guarded or not: `guard` has no default), and a receipt with a reverse batch; undo reactivates a closed asset before deleting it and reopens what a close cascaded to
  - `resolve.numbers` / `resolve.ref` - asset numbers and OID tokens to assets, in one request
  - `attachments.list` / `page` / `info` / `get` / `add` / `put` / `remove` - files attached to an asset, each answered as a row of the Attachment type (`_oid`, `Name`, `Filename`, `ContentType`, …) plus `id`, the number its bytes are addressed by; `list` and `page` answer metadata, plus whatever keys a `select` adds; `get` reads metadata and bytes in two requests, or in one with `{ inline: true }` for a small file; `add` sends a small file inline and a large one in two steps, and a failed upload throws `AttachmentUploadError` naming the empty attachment it left
  - `embeddedImages.upload` / `normalize` - images in rich text; they cannot be deleted
  - `copy(oid)` - the Copy operation, answering the copy's OID (api/asset performs it but never says what it made); `operate(oid, op)` is the general form
  - `fields.describe(type, scope)` - what a form needs: required attributes (meta), the ones the product shows there (`api/visibleFields`, custom fields included), the scheme's important fields and whether they are enforced at close
  - `urls.asset(oidOrNumber)` / `attachment` / `embeddedImage` - where a browser opens each
  - `search(text, { types, … })` - text search across asset types, `{ rows, total, more }`; `deleted(type, params)` - deleted assets (see "Searching")
  - `history` / `template` - an asset's past versions, and a new asset's template for a context
  - `template` reads (`New/<Type>?ctx=`); `meta.*` - meta.v1 raw, with conditional reads (`read` / `readType` with `ifNoneMatch`, `etag()`: meta.v1 sends one ETag for the whole schema); `schema` - the translated, cached view, `schema.revalidate()` drops it only when that tag moves; `localize` - loc-2 labels for tags (a violation's `tag` is one)
- `normalizeQuery(q)` - a query written with rest-1's spellings (`sel`, a textual `where`, comma-joined lists, a `"size,start"` page) as the `QueryBody` every read takes
- Errors: everything thrown is an `ApiError` with a `kind` (`auth`, `forbidden`, `notFound`, `invalid`, `transient`, `aborted`, `commandFailure`, `conflict`, `protocol`, `usage`, `unknown`). A mistake caught before any request is a `UsageError`: `kind: "usage"` means nothing was sent (`status` is 0), so the fix is in the call, not on the server
- `TypeCache` - one instance's loaded type definitions, shared by many clients (`new AgilityApiClient(config, { types })`); `TypeCache.fromMetamodel(metamodel)` seeds one so nothing is loaded
- `createFetchTransport` - configurable HTTP transport: `credentials` for same-origin cookie auth, `onUnauthorized` to re-authenticate on a 401, or on a 403 that carries a `WWW-Authenticate` challenge, which is what an ended session answers to a request sent with `X-Requested-With: XMLHttpRequest` (resends idempotent requests once; `unauthorizedStatuses` adds other statuses), and a per-request `signal`; `client.withSignal(signal)` ties a whole client to one
- **Timeouts are the client's business with any transport**: each attempt has `timeoutMs` (default 60000; 0 for none), and at the deadline the request rejects with an `ApiError` coded `TIMEOUT`, whether or not a custom transport lets go of it (the transport is handed a `signal` that fires then; a late answer is discarded). A timed-out write may still have been applied. A custom transport that waits for a person inside `request` (a sign-in prompt before it replays the request) sets `timeoutMs: 0`: the deadline cannot tell a person from a slow network. The built-in transport's `onUnauthorized` hook runs outside the deadline
- Every `ApiError` the client lets out says what was asked: `error.request` is `{ method, path, idempotent }` (never the body or headers). `client.explain(error)` uses it: a write that got no answer, or a server failure for one, is explained as "Agility did not confirm the change. It may or may not have been made: check before trying again." with `retrySafe: false`, where a read is `retrySafe: true`, except a read the server itself gave up on (`SERVER_TIMEOUT`), which is `false`: the same request would cost and fail the same. The two questions after a failure are two fields: `retrySafe` (may the same request be sent again as it is?) and `outcome` (is it known whether the change was made?). `outcome` is `"unknown"` for a write that got no confirmation (no answer, a timeout, a 5xx: look before acting), `"notApplied"` where the server answered a refusal before doing the work (a 4xx or a 429 in answer to a write, a conflict, and each failed command in the explanation of a batch, which says nothing of the batch's other commands: those are in the Outcome), and `null` for a read or when the error does not say what was asked. A guarded write (`sendGuarded`) is a write here too: it is never sent again by the client, because a second send of one that landed applies nothing and reports a conflict, which would tell you someone else changed the asset when the change was yours. When one gets no answer (`outcome: "unknown"`), read the asset again: you see your change or you do not, and the guard makes sending it again safe. Decide on `retrySafe`, not on the sentence; it is `null` when the server answered, or when the error carries no stamp (one from a `/wire` function on a bare transport)
- A custom transport builds a refusal with `apiErrorFromResponse(status, body, headers)`. The headers matter: a 403 that carries a `WWW-Authenticate` challenge is `kind: "auth"` (an ended session), one without is `kind: "forbidden"`. A write the member has no right to make is never a 403 as far as has been seen: api/asset reports it per command inside a 200 and rest-1 as a 400, and `client.explain` says "Agility refused: this member is not allowed to do that." for both.
- A config key that is not one the factory takes (`new AgilityApiClient`, `createFetchTransport`, `new FakeAgilityClient`) is refused at construction with a `UsageError` naming it, with the nearest known key when it looks like a typo. Nothing is ignored silently, and no value is repeated in the message.
- A `fetch` of your own goes in the client's config (`fetchImpl`). A transport you make yourself with `createFetchTransport` and hand to the client keeps its own `retries` and `timeoutMs` and is not given the client's rules a second time; a wrapper of yours around it is a custom transport and is, so make the inner one with `retries: 0, timeoutMs: 0`.
- Resends and failures are the client's business with any transport: an idempotent request (a GET, a read; never a write, guarded or not) is sent once more after a network failure, a 5xx or a 429 (`retries`, default 1, 0 for none; never a plain write, a 401 or a 403, and **never after a timeout**: the client's `TIMEOUT`, a 408, a 504, or the server's own SQL execution timeout, which arrives as an error document and is coded `SERVER_TIMEOUT` (ask for less: a smaller page, fewer selected paths, a tighter filter). A timeout or an abort ends the client's wait and does not stop the work on the server, so a query that timed out may still be running; `pages` and `all` stop at the first one), and `onError(error, request)` in the config is told about each request that finally failed
- A custom `Transport` (`new AgilityApiClient(config, { transport })`) decides by itself where requests go; `config.baseUrl` is then used only for the links the client builds (`urls.*`, `embeddedImages.normalize`). `apiErrorFromResponse(status, data)` is the error the fetch transport throws for a refused response, for a custom transport to throw the same
- `@versionone/agility-sdk/services` - the services as free functions over a `Transport` (`guard`, `batch`, `resolve`, `schema`, `attachments`, `fields`), for a caller that composes one differently; the client's methods are the same things
- `@versionone/agility-sdk/wire` - the wire modules (`assetApi`, `queryV1`, `rest1`, `meta`, `loc2`, `attachment`, `fields`, `select`), for passthroughs and transport authors; they speak the endpoints' own shapes.

## Testing code that uses the SDK

`@versionone/agility-sdk/testing` exports `FakeAgilityClient`: a real client over a transport that sends nothing and answers what the test scripted, in the shape the client hands your code.

```ts
import { FakeAgilityClient } from "@versionone/agility-sdk/testing";

const fake = new FakeAgilityClient()
  .onQuery("Story", [{ _oid: "Story:1", Name: "Logon", Estimate: 2 }]);

await closeStory(fake, "Story:1");                    // your code, taking an AgilityApiClient

expect(fake.asked[0]).toMatchObject({ from: "Story:1" });                         // what it read
expect(fake.sent[0]).toEqual([{ from: "Story:1", execute: "QuickClose" }]);       // what it wrote
```

- `onQuery(match, rows)` answers every read (`query`, `get`, `queryPage`, `pages`, …). A list is the whole result: the fake pages it and answers a read by OID with that row. A function gets the query and answers one page. A read nothing was scripted for throws; it never looks like an empty result.
- Writes need no script: a create answers a new OID, an update or operation by OID answers that OID. `onSend` scripts anything else, failures included.
- `onSearch(rows)` answers a search, whether your code calls `fake.search` or builds its own client on `fake.transport`: the fake pages the rows and reports the total, each row comes back with exactly the selected keys, and `fake.searched` is what was asked. Script it before the first search.
- `sendGuarded` and `batch.run` work on assets addressed by OID that you scripted a row for: `fake.touch(oid)` is someone else changing the asset (the next write stamped earlier is a conflict), `fake.remove(oid)` is it being deleted.
- `resolve.numbers` finds a number among the scripted rows; `localize` answers `onLocalize` labels and echoes any other tag; `fake.transport` can be the transport of a client your code builds itself.
- `onValues({ Status: [{ _oid: "StoryStatus:135", Name: "Done" }] })` scripts the valid values by attribute (rows, a function of what was asked, or an Error). `lists.value`'s matching and its errors are the client's own, and `fake.valuesAsked` records each request: the type, the attribute and the asset or the scope and team.
- `onList(type, rows)` answers rest-1's list read the same way (`client.deleted`, and `rest1.list` from `/wire`). `onRequest(path, answer)` answers any other endpoint in its own shape; with `new FakeAgilityClient({ metamodel })` (a meta.v1 document) a response captured from a server reads translated, as it would live. An `Error` as an answer is thrown.
- A custom `Transport` has its own suite: `transportConformance(make)` answers the SDK's expectations of a transport as named checks (`for (const c of transportConformance(make)) it(c.name, c.run)`), and the SDK's fetch transport runs the same ones.
- The fake evaluates no filter or sort and applies no write. It proves what your code asks and what it does with the answer; what the server answers is for a test against an instance.

API reference: https://docs.digital.ai/agility-api/

## Adding to the SDK

`specs/000-layers.md` says how the code is arranged (types, wire modules, services, core) and what each layer may know; `CONTRIBUTING.md` says what may be committed to this public repository. A new endpoint is a new module under `src/wire/`, with a unit test that fakes the transport with a response copied from a live one and an integration test that proves it against an instance.

## Installing an unreleased commit

`npm install github:versionone/VersionOne.SDK.JavaScript#<sha>` builds `dist` on install (the `prepare` script). CI also uploads an `npm pack` tarball on every run. The package's entries (`index`, `wire`, `services`, `testing`) and the chunks they share are all in one flat `dist/` directory, so a copy of `dist/` is a working copy.

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

## Contributing

Run `npm run verify` (typecheck, build, tests) before opening a pull request.
This repository is public: `CONTRIBUTING.md` says what may be committed
here and where working plans and consumer hand-offs live instead.

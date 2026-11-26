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

Runnable examples, one per task (a first read, a write, a guarded write, a batch with an undo, errors, attachments, testing your own code, a transport of your own, a browser session that expires), are in [`examples/`](examples/README.md).

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
| Text search, one type or many | `client.query({ from, find, findin, … })` | An ordinary read with two more keys; see "Searching" below. `queryPage` adds the total. |
| Deleted assets; one page across unrelated types with each type's Number | `client.data.list(type, params)` | rest-1: `deleted: true`; `Story.Number` selected from `BaseAsset`. |
| An asset's past versions | `client.history(oid, params)` | One row per version; `_oid` carries the moment. |
| Who am I | `client.me()` | The member the credentials belong to. |
| Numbers and OIDs a person typed | `client.resolve.numbers([...])` / `client.resolve.refs([...])` | Answered as rows. One request for numbers of any mix of types. |
| Write | `client.send(commands)` | Unguarded: writes whatever is there. Answers an `Outcome`; `unmatched` lists commands whose asset was gone. |
| Write only if nobody changed it | `client.sendGuarded(commands, { moments? })` | `conflicts` lists what was left alone. |
| Write with a record and an undo | `client.batch.run(commands, { guard })` then `client.batch.reversible(receipt)` | `guard` has no default. |
| Copy an asset, or run an operation for its result | `client.copy(oid)` / `client.operate(oid, op)` | |
| Defaults for a new asset | `client.template(type, { ctx })` | Nothing is created. |
| What a form needs | `client.fields.describe(type, scope)` | Required, visible and important attributes. |
| Files | `client.attachments.*`, `client.embeddedImages.*` | |
| A link for a person | `client.urls.asset(oidOrNumber)` | |
| An error, said to a person | `client.explain(error)` | "Project is required.", with the instance's labels. |
| Labels in the instance's words | `client.localize(tags)` | |

Every row follows one rule, whichever call read it: **a relation you select is a Ref (`{ _oid }`); a path you select by name is at `row[path]` (`row["Status.Name"]`); nothing arrives that you did not select.** Select both `Owners` and `Owners.Name` and you get the Refs and, beside them, a parallel array at `"Owners.Name"`. To get attributes on the related rows themselves, use a sub-select: `{ from: "Owners", select: ["Name"] }` gives `row.Owners[i].Name`. (rest-1 also puts the display attributes it sends unasked on the Refs of a relation you selected.)

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

`from` decides how wide the search is. `Workitem` covers the backlog types and has `Number`. `BaseAsset` is every asset (members, issues, requests, and anything else that carries the words, a notification included), so narrow it with a filter on `AssetType`; it has no `Number` of its own, and query.v1 refuses a type-qualified select such as `Story.Number` there. For one page across unrelated types with their Numbers, either send one typed query per type in a single request with `client.queries([...])`, or use `client.data.list("BaseAsset", { select: ["Name", "Story.Number", "Issue.Number"], … })`, which rest-1 answers with the value under `Number`.

Rows are typed from what you select, against the product's metamodel: a selected key is its value or `null`, never `undefined`. For an attribute your instance has and the generated model does not (a custom field's relation, a product module's attribute), name your own row type at the call: `client.query<MyRow>(q)` needs only `_oid` on `MyRow`.

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
  - `data.list` / `history` / `template` - rest-1 reads: text search and deleted assets, history, and a new asset's template for a context (`New/<Type>?ctx=`); `meta.*` - meta.v1 raw, with conditional reads (`read` / `readType` with `ifNoneMatch`, `etag()`: meta.v1 sends one ETag for the whole schema); `schema` - the translated, cached view, `schema.revalidate()` drops it only when that tag moves; `localize` - loc-2 labels for tags (a violation's `tag` is one)
- `normalizeQuery(q)` - a query written with rest-1's spellings (`sel`, a textual `where`, comma-joined lists, a `"size,start"` page) as the `QueryBody` every read takes
- Errors: everything thrown is an `ApiError` with a `kind` (`auth`, `forbidden`, `notFound`, `invalid`, `transient`, `aborted`, `commandFailure`, `conflict`, `protocol`, `usage`, `unknown`). A mistake caught before any request is a `UsageError`: `kind: "usage"` means nothing was sent (`status` is 0), so the fix is in the call, not on the server
- `TypeCache` - one instance's loaded type definitions, shared by many clients (`new AgilityApiClient(config, { types })`); `TypeCache.fromMetamodel(metamodel)` seeds one so nothing is loaded
- `createFetchTransport` - configurable HTTP transport: `credentials` for same-origin cookie auth, `onUnauthorized` to re-authenticate on a 401 (resends idempotent requests once), and a per-request `signal`; `client.withSignal(signal)` ties a whole client to one
- Resends and failures are the client's business with any transport: an idempotent request (a GET, a read, a guarded batch with no creates) is sent once more after a network failure, a timeout, a 5xx or a 429 (`retries`, default 1, 0 for none; never a plain write, a 401 or a 403), and `onError(error, request)` in the config is told about each request that finally failed
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
- `sendGuarded` and `batch.run` work on assets addressed by OID that you scripted a row for: `fake.touch(oid)` is someone else changing the asset (the next write stamped earlier is a conflict), `fake.remove(oid)` is it being deleted.
- `resolve.numbers` finds a number among the scripted rows; `localize` answers `onLocalize` labels and echoes any other tag; `fake.transport` can be the transport of a client your code builds itself.
- `onList(type, rows)` answers `client.data.list` the same way. `onRequest(path, answer)` answers any other endpoint in its own shape; with `new FakeAgilityClient({ metamodel })` (a meta.v1 document) a response captured from a server reads translated, as it would live. An `Error` as an answer is thrown.
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

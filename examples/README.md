# Examples

Thirteen short programs, one per task, each runnable as it stands. Read them
in order; each says at the top what it does.

| File | Shows | Writes? |
| --- | --- | --- |
| `01-read.ts` | Typed rows, relations and paths, a page with its total, one asset by OID, `me()` | no |
| `02-write.ts` | `client.send`: create, update, an operation, the `Outcome`, `unmatched` | yes |
| `03-guarded-write.ts` | `client.sendGuarded`: write only if nobody changed it; a conflict as data and as an error | yes |
| `04-batch-undo.ts` | `client.batch.run` with a preview, a confirmation and a receipt; `batch.reversible` to undo | yes |
| `05-errors.ts` | `kind` on everything thrown; `client.explain` says a failure to a person | no |
| `06-attachments.ts` | Add a file, list, read it back in one request, remove it | yes |
| `07-testing.ts` | `FakeAgilityClient`: test your own code with no instance | no instance at all |
| `08-custom-transport.ts` | A `Transport` of your own (a timed wrapper), checked with `transportConformance` | no; a live read only if an instance is set |
| `09-browser-session.ts` | Cookie auth for a browser app: `credentials`, `onUnauthorized`, and when `"retry-write"` is yours to answer | no instance at all (a stand-in server) |
| `10-search.ts` | `client.search` across asset types; `find` on an ordinary read within one family | no |
| `11-axios-transport.ts` | A `Transport` over an axios instance, and an axios adapter that lets `transportConformance` stand in for the network | no instance at all |
| `12-list-values.ts` | `client.lists`: the Status and Priority values an asset may take, a name resolved to the value to write, and what is refused | no |
| `13-relation-values.ts` | `client.validValues`: who may own an asset or which iteration it may go in, as a query to page and search | no |

## Running one

In this repository (Node 22.18 or later runs a `.ts` file directly):

```bash
npm install            # builds dist/, which the examples import by the package's name
export V1_URL=https://agility.example.com/MyInstance
export V1_ACCESS_TOKEN=…
node examples/01-read.ts
```

In a project of your own, `npm install @versionone/agility-sdk@alpha`, copy
a file and run it the same way; the imports are already the ones a consumer
writes.

## The ones that write

An example marked "yes" creates what it needs (a Story or two in the system
scope, named `sdk-integration example …`), and deletes it by exact OID
before it ends, whether it succeeded or not. It still refuses to start
until you say the instance is one where that is acceptable:

```bash
V1_EXAMPLES_WRITE=1 node examples/02-write.ts
```

Use a development or testing instance, never one people work in.

## Keeping them true

`npm run typecheck` compiles every example against the source, so an API
change that breaks one fails before it is pushed. The integration tier
(`test/integration/examples.test.ts`) runs each one against an instance and
fails if it exits non-zero or takes more than thirty seconds. A new example
is a new numbered file here and a row in the table above; nothing else
needs registering.

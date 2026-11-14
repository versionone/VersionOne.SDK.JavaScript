# Contributing

This repository is public and the package is published to npmjs. Everything
committed here is readable by anyone, now and in history. The rules below
keep private things out of the tree; `test/unit/publicTree.test.ts` checks
the mechanical parts and `npm run verify` runs it.

## What lives here, and what does not

- `src/`, `test/`, `scripts/`: the SDK and what proves it.
- `specs/`: the invariants of this code (spec 000 and its successors).
  A spec describes the SDK and the API it talks to, never a consumer,
  a person, a session or an instance.
- `CHANGELOG.md` and `README.md`: what a consumer needs. They ship in
  the package. Longer consumer-facing material (examples, guides) goes in
  `docs/` when there is some.
- **Working plans and hand-offs do not live here.** Sequencing, surveys of
  consumer code, migration steps for a consumer, findings from a session:
  all of that goes in the private planning repository (see below) or in
  the consumer's own repository. Nothing in this tree links to either.

## Plans and hand-offs

The SDK is developed alongside the projects that consume it, and much of
that work is sequenced in plans and handed between sessions. Those
documents name private repositories, branches, pull requests, sessions
and people, so they are kept out of this repository:

- **Plans** (campaign sequencing, adoption plans, hardening passes) live
  in a private planning repository in the product's GitHub organisation
  (a maintainer creates it; its name is not written here, by the same
  rule), one file per plan as before. A plan may cite this repository's
  public history by commit, tag or pull request number; this repository
  never cites a plan.
- **Hand-offs** to a consumer project live with the consumer: a file in
  that project's repository, or a message to the session working on it.
  A session hands work to another session **by message**, not by a file
  committed here. The durable copy, if one is wanted, goes in the
  planning repository under `handoffs/`.
- **Findings** that change the SDK come back here as issues, pull
  requests, tests and changelog lines, worded for the public (see the
  next section). The finding's origin stays in the planning repository.

Commit messages follow the same rule: say what changed in the SDK and
why, in terms of the SDK and the API. History before this policy names
consumers and sessions; it is not rewritten (releases are tagged on it,
and consumers pin commits by SHA), and nothing new is added to it.

## How to refer to things

- A consumer project is "a CLI consumer", "a chat-bot consumer", "a
  browser app consumer", unless it is itself public, in which case it
  may be named and linked.
- The product's source is "the server" or "the product's source". The
  hosted instance the integration tier may write to is "the API-testing
  instance". No hosted instance's URL is committed, a production one
  included: an example base URL uses a fictitious domain (see below).
- People are not named in the tree. A test fixture copied from a live
  response keeps the server's shape and carries fictitious identities
  (a made-up member, `https://agility.example.com/MyInstance` or
  `/VersionOne.Web/` as the example base URL and path).
- Claude sessions are not named. Their ids are attribution for commits,
  not content for files.

## Instances

- Unit tests run with nothing. The integration tier writes fixtures and
  runs only against a local dev instance, or a hosted instance set aside
  for API testing and named in `SDK_TEST_ALLOWED_INSTANCES` (comma-
  separated base URLs), set beside the credential by whoever runs it.
  Any other hosted URL, and anything named V1Production, is refused.
- `metamodel.json` is pulled by `scripts/download-metamodel.mjs`, which
  strips an instance's own definitions and spells every `href` from
  `/meta.v1/`, so the committed file is the product's and names no
  instance. Run it, then `npm run generate:types`, as a step of each
  release.

## Before a pull request

```bash
npm run verify   # typecheck, build, unit tests (including the public-tree check)
```

Open the pull request against `proposed_type_script_api_version`. A
change to an invariant changes `specs/000-layers.md` in the same commit.

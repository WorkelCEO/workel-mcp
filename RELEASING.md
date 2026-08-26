# Releasing `@workel/mcp`

## Status: nothing has been published.

> **Version bump checklist:** `package.json.version` and the two pinned
> `npx -y @workel/mcp@<version>` forms in `README.md` must move together —
> `src/docs.test.ts` now fails the build if they drift.

This document, and the release artifacts it describes (`manifest.json`,
`server.json`), were written without running `npm publish`, `npm pack`,
`npm login`, `npm version`, `mcpb pack`, `mcpb sign`, or any other command
that contacts npm, the MCP registry, or any client directory. No `.mcpb`
bundle exists in this tree. No `.npmrc` was created. No npm token, no
signing key, and no registry credential of any kind was created, read, or
used to produce these files. `src/release.test.ts` checks for the absence
of the byproducts a real publish would leave behind (a `.npmrc`, a packed
`.mcpb` file) — that is evidence a publish did not happen from *this*
working tree during this work, not proof that no publish has ever happened
anywhere. Only a person with real credentials, following the checklist
below, can actually publish this package.

Every place a real key would appear below uses a placeholder like
`<your-npm-token>` — never paste a real credential into this file or any
file that gets committed.

## Before you start: known blockers

- **~~`package.json` has `"private": true`~~ — no longer true.** That field is
  gone and `@workel/mcp` is published; `0.3.0` is live on npm. The original
  warning (that `npm publish` refuses a private package outright, and that the
  field must be removed as a deliberate reviewed edit rather than flipped by a
  release script) has been acted on and is kept here only as history.
- **~~`server.json` points at the monorepo~~ — resolved by the split.** Its
  `repository.url` used to be `https://github.com/WorkelCEO/Claude-playground`,
  the private monorepo this package was extracted from. A registry listing
  pointing at a repo nobody can open is worse than no link at all, so it now
  points at this repo. `package.json` gained matching `repository`, `homepage`
  and `bugs` fields, which is what npmjs.com renders as the source link.

## Publish checklist (person-only, in order)

### 1. Version bump

Bump the version in **all three** places, in this order, in the same
commit:

1. `package.json` — `"version"`
2. `manifest.json` — `"version"`
3. `server.json` — both the top-level `"version"` and the `"version"` field
   inside the `npm` entry in `"packages"`

`src/release.test.ts` fails if any one of the three is forgotten or left
inconsistent — run `npx jest src/release.test.ts` after bumping and before
committing. That test proves the three files agree with each other; it does
not choose what the new version number should be, and it does not run as
part of the publish itself.

### 2. `npm publish`

Run by the package owner, from an authenticated shell, with 2FA enabled on
the npm account and provenance attestation on:

```
npm publish --access public --provenance
```

- Requires an npm account with publish rights to the `@workel` scope, and
  an interactive 2FA prompt (or an npm token with `automation` + 2FA
  configured, if run from CI later — no such CI exists in this repo today).
- `--provenance` requires running from a supported CI provider (e.g. GitHub
  Actions with `id-token: write` permission) or `npm login`'d locally with
  provenance support; if publishing from a laptop without a supported CI
  context, drop `--provenance` and note in the release notes that this
  release has no provenance attestation.
- Remember the `"private": true` blocker above — remove or flip it first,
  as its own reviewed change.

### 3. `.mcpb` bundle: pack and sign

The `.mcpb` bundle packages `manifest.json` alongside a built `dist/` (and
its runtime `node_modules`) into a single distributable file for Claude
Desktop / Claude Code extension installs.

1. `npm run build` first — the bundle needs a real `dist/index.js` on disk;
   `manifest.json`'s `server.entry_point` and `mcp_config.args` both assume
   it exists at `dist/index.js`.
2. Pack with the `mcpb` CLI (`mcpb pack .` or equivalent — consult the
   current [MCP Bundle tooling docs](https://github.com/anthropics/mcpb)
   for the exact invocation, which has changed as the tool has matured).
3. Sign the packed bundle. **Where the signing key lives is not yet
   decided** — this repo has no signing key or key-management process for
   `.mcpb` artifacts today. Before this step can run for a real release,
   the owner needs to either provision a code-signing key for this purpose
   and record where it's stored (a password manager entry, a CI secret, an
   HSM — whichever is chosen), or confirm that an unsigned bundle is
   acceptable for the target distribution channel.

### 4. MCP registry submission

Submitting `server.json` to the [MCP registry](https://registry.modelcontextprotocol.io)
publishes this server to a directory other MCP clients can discover it
through.

- **The `com.workel` namespace requires a DNS TXT record on the `workel`
  domain before it will verify.** The registry's DNS-based namespace
  ownership check looks for a specific TXT record (consult the registry's
  current namespace-verification docs for the exact record name and value
  format — it has a `mcp-publisher`-style CLI flow that generates the
  value to add) at a subdomain of `workel.com`. Whoever controls DNS for
  `workel.com` needs to add that record **before** `server.json` can be
  submitted under the `com.workel/mcp` name used in this file. Submission
  will fail namespace verification until that record exists and has
  propagated.
- Submission itself is done via the registry's publisher CLI/API once
  namespace ownership is verified — see the registry's own publishing
  guide for the current command.

#### Validate before submitting

`server.json` in this package was written offline, without live access to
the registry's schema — the `$schema` URL and exact field names in this
file are a best-effort reconstruction, and the registry's `server.json`
schema has changed shape (and schema-version URLs) more than once. **Before
submitting, validate this file against the schema the registry is
currently publishing against** (fetch the current `$schema` URL from the
registry's own docs, and either run it through the registry's own
validation endpoint/CLI or a local JSON Schema validator against that
URL). Do not assume the file as written here is submission-ready.

### 5. Client-directory submission

Some MCP clients (Claude Desktop's extension directory, and others as they
appear) maintain their own curated listing separate from the MCP registry
above, generally submitted via a form or a PR against that client's own
directory repo. This has not been researched or started for this package.
Check each client's current submission process individually — none of it
is automated from this repo.

## What `src/release.test.ts` proves, and what it doesn't

The test file checks: the two artifacts are valid JSON; their version
fields agree with `package.json`, in three separately-named assertions;
the API key is wired through `manifest.json` as a `required`, `sensitive`
user-config value rather than a literal; no real-key-shaped string (the
prefix a genuine Workel API key starts with) appears in either artifact or
in this file; `package.json` has no npm lifecycle script
that would execute code on install; and the working tree has no `.npmrc`
and no packed `.mcpb` file.

That last pair is the important distinction: it proves this working tree
does not currently contain the *byproducts* of a publish. It cannot prove,
and does not claim to prove, that no publish has ever happened from any
machine, at any time, against this package name. If you need to know
whether `@workel/mcp` has already been published, check the npm registry
directly (`npm view @workel/mcp`), not this test suite.

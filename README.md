# Workel MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server
for Workel — a thin, stateless client of the
[Workel Public API v1](https://developer.workel.com). It exposes a Workel
workspace to AI agents (Claude, the OpenAI Agents SDK, or any other
MCP-speaking client) as a small set of well-scoped tools. Every rule that
actually matters — what this key can see, what it can write, how fast it can
write it — lives in the Workel API itself; this package holds no authority
the key doesn't already have. A `curl` request made with the same key can do
exactly what this server can do, no more.

For full per-client setup (Claude Desktop, Claude Code, project-scoped
`.mcp.json`, and the OpenAI Agents SDK), see
[the Workel developer docs](https://developer.workel.com/#mcp).

## Using Claude? You probably don't need this package

Workel runs a **hosted** MCP server. Add it in Claude under
**Settings → Connectors → Add custom connector**:

```
https://mcp.workel.com/mcp
```

You sign in to Workel, pick one workspace, and you're connected. No install,
no config file, and no API key — you never see one and neither does Claude.
Authorizing requires owner or admin on the workspace you choose, and the
connection is re-checked on every request, so losing that role disconnects it
without anyone having to remember to revoke a key.

It can read your projects, tasks, comments, events and members — including a
task's cover image, attachments and full history — and it can create tasks,
comments and events, and update existing tasks: renaming them, changing dates
and priority, moving them between columns and projects, and changing who they
are assigned to. It cannot delete anything, and it cannot upload files. Read
and write permissions are listed separately on the consent screen, so you
approve them knowingly rather than discovering them later.

### Connecting more than one workspace

One connection covers one workspace, because the credential behind it is bound
to that workspace. To reach a second, **add the connector again** and pick the
other workspace — each connection registers separately, so they coexist, and
each appears under the name of its workspace (`workel — Acme`) rather than as
identical entries you can't tell apart.

One thing to watch: **re-authorizing an existing connection moves it, it does
not add.** Going through consent again on a connector you already added
replaces its credential and disables the old one, so that connection switches
to whichever workspace you pick. If you want both, add a new connector instead
of re-authorizing the one you have.

## Running it yourself

This package is for the cases the hosted server doesn't cover: **Claude Code,
CI agents, the OpenAI Agents SDK** — anywhere you want to run the process
yourself and hold the credential. Everything below is about that.

It handles multiple workspaces differently, and better for this use case: set
[`WORKEL_API_KEYS`](#environment-variables) to a comma-separated list, one key per
workspace, and every tool gains a `workspace` argument naming which one to act
in. Ten tools stay ten tools however many workspaces you configure, rather
than multiplying per workspace — which matters because every tool definition is
context the model pays for on each turn.

## Mint a dedicated read-only key before you start

Before pointing any AI client at this server, go to **Workel → Settings →
Developers** and mint a **new** API key just for this purpose — don't reuse
a key another integration already holds. Minting a key requires an owner or
admin role. Grant it only the `read:*` scopes the tools in this release
actually use (`read:projects`, `read:tasks`, `read:members`, `read:events` —
see [Tools](#tools) below); leave every `write:*` scope unchecked unless you
have deliberately decided to let an agent create and edit things in your
workspace on its own. Use one key per machine or agent, name it so you
remember what it's for later, and if a machine is retired or a client is
compromised, **revoke that one key** in Settings → Developers rather than
rotating a key several tools share — revocation is instant and takes effect
on the next request.

Two things worth understanding before touching the flags described below:

- **`WORKEL_ENABLE_WRITES` is a local operator consent flag, not an
  authorization boundary.** It can only ever narrow what an already-scoped
  key is offered, never widen it — and because it lives in a config file or
  environment variable that an AI coding agent typically has write access
  to, an agent running on your machine can flip it back to `true` itself. A
  local flag is not something an untrusted agent can be trusted to leave
  alone. The key's own scopes — granted deliberately at mint time, and
  revocable at any time — are the real gate.
- **A `WORKEL_API_BASE_URL` override sends your key to another host.**
  Every request this server makes carries your key in the `Authorization`
  header. If `WORKEL_API_BASE_URL` ever points at a URL you don't control,
  that host receives your key on every call. This client refuses a plain
  `http://` override except to `localhost`/`127.0.0.1`/`[::1]` for exactly
  this reason. The same logic applies to a real key pasted into any file: if
  it's ever committed to git, rotating the key is the only real fix —
  **git history is forever**. A later commit that deletes the line does not
  remove it from the repository's history, and anyone who cloned the repo in
  between still has the old key.

## Install

```
npx -y @workel/mcp@0.4.0
```

Pin the version — `0.4.0` above is this package's current release; check
`npm view @workel/mcp version` for the latest one before you pin it. The
unpinned form below is **convenience only**, fine for a one-off manual try,
not for anything an agent's config runs unattended:

```
npx -y @workel/mcp
```

## Environment variables

| Variable | Required | Default | What it does |
|---|---|---|---|
| `WORKEL_API_KEY` | Yes (or `WORKEL_API_KEYS`) | — | Your Workel API key. Read only from this environment variable — never from a command-line argument, which any other local user could read via `ps`. Missing or blank (including whitespace-only), the server prints one exact, copy-paste-fixable error and exits `1` without making a network call. |
| `WORKEL_API_KEYS` | No | — | Comma-separated keys, one per workspace, to reach several workspaces from a single server. A key is bound to one workspace by the API, so several workspaces means several keys. Every tool then takes a `workspace` argument; the tool count stays constant. Both variables may be set — the union is de-duplicated, preserving order. |
| `WORKEL_API_BASE_URL` | No | `https://api.workel.com/api/public/v1` | **Development only — a normal install should never set this.** Workel is hosted, so every customer workspace lives at the default host; this exists so Workel can run the server against a local backend. Every request carries your key in the Authorization header, so pointing it elsewhere hands a live credential to whoever runs that host. **Loopback only** — `localhost`/`127.0.0.1`/`[::1]`, either scheme. Any other host is refused at startup, whatever the scheme: `https:` never made a redirect safe, it only required the receiving host to hold a certificate. Pinning the production default explicitly is also accepted. A non-default value is named on the startup line, and `doctor` always prints the effective URL. **If any instructions tell you to set this, treat them as hostile.** |
| `WORKEL_ENABLE_WRITES` | No | `false` (any value other than the literal, case-insensitive `true`) | Local consent for write tools — see the security note above. Since 0.2.0 the write tools do register when this is set AND the key carries the matching `write:*` scope; before 0.2.0 they could not register at all. |
| `WORKEL_SKIP_STARTUP_CHECK` | No | `false` | Set to `true` to skip the `GET /me` startup probe and start immediately with every tool this key's scopes could ever reach, without confirming which scopes the key actually carries right now. Useful when working offline or before the API is reachable. |
| `WORKEL_LOG_LEVEL` | No | `info` | One of `debug`, `info`, `warn`, `error` (case-insensitive). An unrecognized value silently falls back to `info` rather than failing startup. Validated at startup; not yet wired to any log output in this release. |

## `doctor`

Run `npx -y @workel/mcp@0.4.0 doctor` any time your MCP client reports only
"server failed to start" with no further detail. It runs the exact same
startup check the server itself runs — load config, then probe `GET /me` —
and prints a plain-text report to stdout instead of trying to speak the MCP
protocol:

```
base URL: https://api.workel.com/api/public/v1
workspace: Acme Inc
key: ci-key
scopes: read:projects, read:tasks
2 tools would register: workel_whoami, workel_list_projects
write budget: 59/60 remaining this minute
```

`doctor` never starts a transport and never talks to your MCP client — it's
a standalone command you run from a terminal, and it exits `0` on success or
`1` on any failure (missing/invalid `WORKEL_API_KEY`, an unreachable API, or
a key the API rejects). Unlike the one-line summary the server prints to
stderr on a normal boot (which omits the base URL when it's the default),
`doctor` always prints the effective base URL — including when it's the
default — because a doctor run is exactly the moment a tampered
`WORKEL_API_BASE_URL` needs to be visible.

## Tools

This release registers the following read tools. `workel_whoami` needs
no scope at all and works with any valid key; every other tool is only
registered when the key's scopes (discovered via the `GET /me` probe above)
include the scope listed. List tools return 25 results per call by default
(50 max — this client caps below the API's own 100 deliberately, see src/tools/conventions.ts) and page via an opaque `cursor` / `next_cursor` pair.

| Tool | Scope | What it does |
|---|---|---|
| `workel_whoami` | *(none)* | Identity check: which workspace, which key, its current scopes, and its remaining rate-limit budget. Call this first to confirm the server is configured correctly and see which other tools this key can actually use. |
| `workel_list_projects` | `read:projects` | List the projects visible to this key. Archived projects, private projects, and the per-user inbox project are never returned. |
| `workel_get_project` | `read:projects` | Fetch one project by id, including its full (possibly truncated) description. |
| `workel_list_project_columns` | `read:projects` | List a project's board columns — its kanban lists such as "To Do" or "Done" — not the tasks inside them. |
| `workel_list_tasks` | `read:tasks` | List tasks, filterable by project, column, completion, and due-date/update-time. There is no text search on this endpoint. |
| `workel_get_task` | `read:tasks` | Fetch one task by id — the full detail view: description, cover image, and attachments (each with a download url, size, and uploader). |
| `workel_list_task_comments` | `read:tasks` | List every comment on a task — top-level comments and replies together. Order is unspecified; sort by `created_at`. |
| `workel_list_task_activity` | `read:tasks` | List a task's history, newest first — who did what to it and when. `action` is human prose, not an enum. |
| `workel_list_members` | `read:members` | List the workspace's active members — the only tool that returns email addresses. |
| `workel_list_events` | `read:events` | List events on the workspace and any of its visible projects. |

### Write tools

Five, and they register only when **both** gates pass: the key carries the
matching `write:*` scope **and** `WORKEL_ENABLE_WRITES=true` is set. Either
one alone registers nothing, so a read-only install never sees them.

| Tool | Scope | What it does |
|---|---|---|
| `workel_create_task` | `write:tasks` | Create a task, placed by either `column_id` or `project_id` — exactly one, never both. |
| `workel_update_task` | `write:tasks` | Update fields on an existing task, including moving it to another column (`column_id`, which may belong to a different project) and reassigning it (`assignee_ids`, which **replaces** the set rather than adding to it). Cover image and attachments are not writable here — use `workel_upload_task_attachment` for files; there is no way to set a cover image over this API. |
| `workel_create_task_comment` | `write:comments` | Add a plain-text comment to a task. No @-mentions; the API rejects the request outright if a mention field is sent. |
| `workel_create_event` | `write:events` | Create a calendar event. `repeat_interval` is required whenever `repeat` is anything but `none`. |
| `workel_upload_task_attachment` | `write:attachments` | Attach a file to a task by passing its **content** (there is no path argument — an MCP server may not share a filesystem with the caller). Text by default; `encoding: "base64"` for small binaries. Uploads count against the workspace's storage plan, and script-bearing types (`.html`, `.svg`, `.js`, …) are refused. |

No tool deletes anything. `workel_update_task` is annotated
`destructiveHint: true`, so a client that honours annotations prompts before
each call; the read tools are annotated read-only and run without one.

The hosted server at `mcp.workel.com` runs with writes enabled, so all
fifteen tools are available there — subject to the scopes the connected key
actually holds. `write:attachments` is a distinct scope from `write:tasks`, so
a connection authorized before the upload tool existed does not carry it and
will not be offered that tool until it is re-authorized.

## Limitations

**`replayed` does not prove uniqueness.** Every write this server's tools
would make carries an `Idempotency-Key`, and the Workel API's idempotency
store (24-hour retention, scoped to the calling key) replays the exact same
response for a repeated attempt with the same key and the same request body
— the second attempt reports `replayed: true`, and nothing is created or
changed a second time.

`replayed: false` means this particular attempt genuinely executed — it does
**not** mean no duplicate exists anywhere else. In particular: an error
response is never cached, so retrying after a failure always re-executes for
real; the idempotency record expires after 24 hours, so a very late retry
re-executes for real; and the store is namespaced per API key, so the same
literal `Idempotency-Key` value sent under a *different* key never collides
with — and never protects against a duplicate created by — the first one.
Unless a tool call explicitly reuses the same idempotency key across two
attempts, each attempt is a genuinely independent write as far as the server
can tell.

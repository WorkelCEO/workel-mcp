/**
 * The D5 double opt-in gate for write tools (docs/MCP_SERVER_PLAN.md §3,
 * "D5 — Read-only by default; writes are a double opt-in"):
 *
 *   Write tools register only when (a) the key actually holds a write scope
 *   (discovered via `GET /me` at boot) AND (b) `WORKEL_ENABLE_WRITES=true` is
 *   set. Scope-gating is UX (don't offer tools that would 403); the env flag
 *   is the local operator's explicit consent; the API's scopes remain the
 *   real boundary.
 *
 * This module extends the existing registration seam rather than adding a
 * parallel one: `buildServer` (`../server.ts`) already, unconditionally,
 * filters every tool it's handed down to `descriptor.scope === undefined ||
 * caps.scopes.includes(descriptor.scope)` — that is gate (a), and it applies
 * identically to every tool, read or write, with no change needed here.
 * Gate (b) has nowhere else to live: it is orthogonal to scope and
 * `buildServer` is deliberately not editable to learn about it (`server.ts`
 * doc: "no environment... access here"). So this module supplies gate (b) as
 * a pure pre-filter on WHICH factories ever reach `buildServer` at all —
 * `registeredWriteTools(false)` returns an empty array, so a write tool with
 * the flag off is never even instantiated, let alone scope-checked. With the
 * flag on, the write factories flow into `buildServer` exactly like any read
 * tool, and gate (a) — already correct, already tested (`server.test.ts`) —
 * decides the rest. The combined per-tool registration predicate is
 * therefore exactly `scopes.includes(descriptor.scope) && writesEnabled`,
 * split across the two gates rather than duplicated in one new function.
 *
 * `writesEnabledFromEnv` takes an env map (default `process.env`) rather
 * than reading `WORKEL_ENABLE_WRITES` internally with no way to override it
 * — the same injection shape `config.ts`'s own `loadConfig(env)` uses — so a
 * caller with an already-resolved boolean (a future `boot.ts` wiring that
 * already ran `loadConfig` and has `config.enableWrites` in hand) can pass
 * that straight to `registeredWriteTools` instead, and every test here can
 * exercise a synthetic env object without ever touching the real
 * environment.
 */

import { workelCreateTask } from './createTask';
import { workelUpdateTask } from './updateTask';
import { workelCreateTaskComment } from './createComment';
import { workelCreateEvent } from './createEvent';
import { workelUploadTaskAttachment } from './uploadAttachment';
import type { ToolFactory } from './defineTool';

/**
 * Every write tool this server can ever expose — the write-side counterpart
 * of `./index`'s `READ_TOOLS`. Not every entry shares one scope:
 * `workelCreateTask`/`workelUpdateTask` declare `write:tasks`,
 * `workelCreateTaskComment` declares `write:comments`, `workelCreateEvent`
 * declares `write:events`, and `workelUploadTaskAttachment` declares
 * `write:attachments` — each tool's own `scope` (not membership in this
 * array) is what `buildServer`'s gate (a) checks per caller (`../server.ts`).
 * That per-tool scoping is why the upload tool can sit here safely: a key
 * holding `write:tasks` but not `write:attachments` never sees it.
 */
export const WRITE_TOOLS: ToolFactory[] = [
  workelCreateTask,
  workelUpdateTask,
  workelCreateTaskComment,
  workelCreateEvent,
  workelUploadTaskAttachment,
];

/**
 * Parses `WORKEL_ENABLE_WRITES` with EXACTLY `config.ts`'s own (unexported)
 * `parseBooleanFlag` semantics: case-insensitive match against the literal
 * string `"true"`, no trimming. Duplicated rather than imported because
 * `config.ts` does not export it — but the semantics must never drift from
 * it regardless: `loadConfig(env).enableWrites` and
 * `writesEnabledFromEnv(env)` are two readings of the SAME env var, and a
 * value they disagreed on (e.g. `"TRUE "` with a trailing space — `false` in
 * both, since neither trims) would mean this gate and `config.ts`'s own
 * parsed `Config.enableWrites` field could tell two different stories about
 * whether writes are enabled.
 */
function parseWritesEnabledFlag(value: string | undefined): boolean {
  return value !== undefined && value.toLowerCase() === 'true';
}

export function writesEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseWritesEnabledFlag(env.WORKEL_ENABLE_WRITES);
}

/**
 * Gate (b) of D5, applied. `writesEnabled` defaults to reading the real
 * environment so a caller with nothing more specific in hand still gets
 * correct behavior, but a caller that already has a resolved boolean (from
 * `loadConfig`, or a test) should pass it explicitly rather than relying on
 * this default re-deriving it from `process.env` a second time.
 *
 * Returns `WRITE_TOOLS` unchanged when `writesEnabled` is true — every
 * factory still has to clear gate (a) (its own `scope` against the caller's
 * `caps.scopes`) inside `buildServer` before it is actually registered.
 * Returns an empty array when `writesEnabled` is false, regardless of what
 * scopes the caller carries — a write tool is never even handed to
 * `buildServer` in that case, so no scope on earth can register it.
 */
export function registeredWriteTools(writesEnabled: boolean = writesEnabledFromEnv()): ToolFactory[] {
  return writesEnabled ? WRITE_TOOLS : [];
}

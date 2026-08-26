/**
 * `workel-mcp doctor` — a one-shot diagnostic a customer can run when their
 * MCP client says only "server failed to start" and gives no further detail.
 *
 * Runs the EXACT SAME `GET /me` startup probe `boot.ts` runs (`probeMe`),
 * through the exact same scope→tool-selection seam (`toolScopeGates` /
 * `permittedToolNames`) — reused, not re-implemented, so the two can never
 * report a different answer for the same key/config. See `boot.ts` for the
 * probe and selection logic itself; this module only formats the result.
 *
 * Unlike `boot`, this module runs no transport, so there is no stdout/stderr
 * split to preserve — a stdio MCP session never gets far enough to start for
 * a doctor run to interfere with. Every line, success or failure, goes to
 * `deps.stdout`. `deps.stderr` is threaded through only so a caller/test can
 * prove nothing here ever writes to it (mirrors `boot.ts`'s `deps.stdout`
 * convention, inverted).
 *
 * `runDoctor` never calls `process.exit` — it returns a plain exit code
 * (`0` success, `1` failure) and leaves the decision of when/how to exit to
 * its caller (`index.ts`).
 *
 * D6 (the effective-base-URL defense) is surfaced a second time here,
 * deliberately: the base URL prints UNCONDITIONALLY — default or
 * overridden — with an inline `(override)` marker in the overridden case.
 * A doctor run is exactly the moment a tampered `WORKEL_API_BASE_URL` must
 * be visible, so unlike `boot`'s line (which omits the URL when it's the
 * default, to keep the common case terse) doctor never omits it.
 */

import { createWorkelApiClient } from './api/client';
import { redact, registerSecret } from './api/redact';
import { loadConfig, type Config } from './config';
import {
  defaultSleep,
  describeFailure,
  permittedToolNames,
  probeMe,
  sanitizeForLine,
  toolScopeGates,
  type BootDeps,
  type MeResponse,
} from './boot';
import type { ServerCaps } from './server';

/**
 * The subset of `BootDeps` (boot.ts) `runDoctor` actually needs — a `Pick`
 * rather than a hand-copied interface, so the two can never silently drift
 * apart on the shape of `env`/`fetch`/`stdout`/`stderr`.
 */
export type DoctorDeps = Pick<BootDeps, 'env' | 'fetch' | 'stdout' | 'stderr'>;

const SUCCESS = 0;
const FAILURE = 1;

function formatBaseUrlLine(config: Config): string {
  return config.isCustomBaseUrl ? `base URL: ${config.baseUrl} (override)` : `base URL: ${config.baseUrl}`;
}

function formatProbeLines(me: MeResponse, toolNames: string[]): string[] {
  const scopes = me.key.scopes.map(sanitizeForLine);
  return [
    `workspace: ${sanitizeForLine(me.workspace.name)}`,
    `key: ${sanitizeForLine(me.key.name)}`,
    `scopes: ${scopes.length > 0 ? scopes.join(', ') : 'none'}`,
    `${toolNames.length} tools would register: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}`,
    `write budget: ${me.rate_limit.write.remaining}/${me.rate_limit.write.limit} remaining this minute`,
  ];
}

/**
 * Runs the diagnostic and writes its report to `deps.stdout`. Returns `0`
 * when the probe succeeded, `1` for any failure (bad config, network error,
 * a non-2xx response, or a malformed 200 body) — never throws.
 */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const { env, fetch: injectedFetch, stdout } = deps;

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    stdout(`${redact((err as Error).message)}\n`);
    return FAILURE;
  }

  registerSecret(config.apiKey);

  const client = createWorkelApiClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: injectedFetch,
    sleep: defaultSleep,
  });

  // Computed before the probe: which tools this key COULD ever register is
  // static per-descriptor and doesn't depend on the probe succeeding, but is
  // only reported alongside a successful probe below (the tool list is
  // gated on real scopes, which only the probe can supply).
  const gates = toolScopeGates(client);

  const lines: string[] = [formatBaseUrlLine(config)];

  let me: MeResponse;
  try {
    me = await probeMe(client);
  } catch (err) {
    lines.push(redact(describeFailure(err)));
    stdout(`${redact(lines.join('\n'))}\n`);
    return FAILURE;
  }

  const caps: ServerCaps = { scopes: me.key.scopes };
  const toolNames = permittedToolNames(gates, caps);
  lines.push(...formatProbeLines(me, toolNames));

  stdout(`${redact(lines.join('\n'))}\n`);
  return SUCCESS;
}

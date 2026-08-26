/**
 * Boots the Workel MCP server: loads config, probes `GET /me` to discover
 * which scopes the configured key actually carries, registers only the
 * tools those scopes permit, and reports the result in a single stderr
 * line. Deliberately transport-agnostic — `boot` never touches stdio or any
 * transport; it hands back a constructed, unconnected `McpServer` (from
 * `server.ts`'s `buildServer`) and lets the entrypoint (`index.ts`) decide
 * how to connect it.
 *
 * The one rule this whole module exists to enforce: on the stdio transport,
 * stdout IS the protocol stream. A single human-readable byte on stdout
 * corrupts every message after it. Every line this module ever writes goes
 * to `deps.stderr` — never `deps.stdout`, which this module never calls at
 * all (it is threaded through only so a caller/test can prove that).
 *
 * Order matters and is fixed: install crash handlers, THEN validate env,
 * THEN probe `/me`, THEN build the server, THEN write the boot line. Crash
 * handlers go first specifically so a crash during the probe itself is
 * still caught and redacted rather than reaching Node's default handler.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type Config } from './config';
import { createWorkelApiClient, WorkelApiError, type FetchLike, type WorkelApiClient } from './api/client';
import { redact, registerSecret } from './api/redact';
import { buildServer, buildWorkspaceServer, type ServerCaps } from './server';
import { createWorkspaceRegistry, type ProbedWorkspace } from './workspaces';
import { registeredWriteTools } from './tools/registration';
import { READ_TOOLS } from './tools';
import type { ToolFactory } from './tools/defineTool';
import type { ToolDescriptor } from './tools/defineTool';

export interface BootDeps {
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  /** Never called by `boot` itself — threaded through only so a caller can prove nothing here ever writes to stdout. */
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exit: (code: number) => void;
  installCrashHandlers: (write: (text: string) => void) => () => void;
}

export interface BootResult {
  server: McpServer;
  toolNames: string[];
}

const SKIP_STARTUP_CHECK_HINT = 'Set WORKEL_SKIP_STARTUP_CHECK=true to start anyway.';

/**
 * Exported so `doctor.ts` (T12) can build its own client with the exact same
 * retry-sleep behavior `boot` uses, without re-implementing this one-liner a
 * second time.
 */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collapses newlines/control whitespace to a single space and trims. Applied
 * to every string that reaches the boot line from outside this process's own
 * source (a workspace name, a key name, a scope string from `/me`) — none of
 * those are proven free of characters that would turn "one line" into many,
 * or that could be used to forge a fake second log line.
 *
 * Exported for reuse by `doctor.ts` (T12) — a doctor run formats the exact
 * same untrusted `/me` fields and must sanitize them identically.
 */
export function sanitizeForLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The shape this module actually reads off `GET /me`
 * (`MeResource`/`MeController`, backend). Narrower than the full documented
 * response — only the fields the boot line reports.
 *
 * Exported so `doctor.ts` (T12) can type the result of `probeMe` below
 * without redeclaring this shape.
 */
export interface MeResponse {
  // `id` is optional purely so existing fixtures and any deployment that
  // predates it still parse; the registry falls back to the name.
  workspace: { name: string; id?: string };
  key: { name: string; scopes: string[] };
  rate_limit: { write: { limit: number; remaining: number } };
}

class MalformedMeResponseError extends Error {
  constructor() {
    super('The server responded to GET /me, but not with the expected shape.');
    this.name = 'MalformedMeResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Minimal runtime validation of the `/me` body — just enough that a 200
 * response with an unexpected shape (a proxy/gateway serving something else,
 * a future incompatible server) fails the startup probe the same way a
 * non-2xx response would, instead of throwing a raw `TypeError` out of a
 * field access later in this module.
 */
function parseMeResponse(data: unknown): MeResponse {
  if (
    isRecord(data) &&
    isRecord(data.workspace) &&
    typeof data.workspace.name === 'string' &&
    (data.workspace.id === undefined || typeof data.workspace.id === 'string') &&
    isRecord(data.key) &&
    typeof data.key.name === 'string' &&
    Array.isArray(data.key.scopes) &&
    data.key.scopes.every((scope) => typeof scope === 'string') &&
    isRecord(data.rate_limit) &&
    isRecord(data.rate_limit.write) &&
    typeof data.rate_limit.write.limit === 'number' &&
    typeof data.rate_limit.write.remaining === 'number'
  ) {
    return data as unknown as MeResponse;
  }
  throw new MalformedMeResponseError();
}

/**
 * One row per tool this server can ever register, with the scope gate its
 * own descriptor declares — derived from `READ_TOOLS`' real descriptors
 * (never hand-copied), so a tool's scope only has to be correct once, in its
 * own module. `scope: undefined` means the tool needs no scope at all (only
 * `workel_whoami` today) and is always included below regardless of `caps`.
 *
 * Exported so `doctor.ts` (T12) computes "which tools would register" through
 * the exact same descriptors `boot` itself registers against — never a
 * second, independently maintained list that could drift from `buildServer`.
 */
export function toolScopeGates(client: WorkelApiClient, tools: ToolFactory[] = READ_TOOLS): ToolDescriptor[] {
  return tools.map((factory) => factory(client));
}

/**
 * The tool names permitted for `caps` — intentionally the same predicate
 * `buildServer` (server.ts) applies internally, computed here independently
 * purely to report what got registered. `buildServer` remains the sole
 * authority for what is actually registered; this must never be allowed to
 * diverge from it, which is why it is derived from the same descriptors
 * rather than a separately maintained list.
 *
 * Exported for the same reason as `toolScopeGates` above — `doctor.ts` (T12)
 * reports "tools that would register" through this identical predicate.
 */
export function permittedToolNames(gates: ToolDescriptor[], caps: ServerCaps): string[] {
  return gates.filter((gate) => gate.scope === undefined || caps.scopes.includes(gate.scope)).map((gate) => gate.name);
}

type BootLineParams =
  | {
      probed: true;
      /** Present when several workspaces are configured; the line then names them all. */
      workspaces?: { label: string; keyName: string }[];
      workspaceName: string;
      keyName: string;
      scopes: string[];
      toolNames: string[];
      writeBudget: { remaining: number; limit: number };
      baseUrl: string;
      isCustomBaseUrl: boolean;
    }
  | {
      probed: false;
      toolNames: string[];
      baseUrl: string;
      isCustomBaseUrl: boolean;
    };

function formatBootLine(params: BootLineParams): string {
  const segments: string[] = [];

  if (params.probed) {
    const workspaceName = sanitizeForLine(params.workspaceName);
    const keyName = sanitizeForLine(params.keyName);
    const scopes = params.scopes.map(sanitizeForLine);
    if (params.workspaces && params.workspaces.length > 1) {
      const listed = params.workspaces
        .map((w) => `"${sanitizeForLine(w.label)}" (key "${sanitizeForLine(w.keyName)}")`)
        .join(', ');
      segments.push(`Workel MCP ready — ${params.workspaces.length} workspaces: ${listed}`);
    } else {
      segments.push(`Workel MCP ready — workspace "${workspaceName}", key "${keyName}"`);
    }
    segments.push(`scopes: ${scopes.length > 0 ? scopes.join(', ') : 'none'}`);
    segments.push(`${params.toolNames.length} tools registered: ${params.toolNames.join(', ')}`);
    segments.push(`write budget: ${params.writeBudget.remaining}/${params.writeBudget.limit} remaining this minute`);
  } else {
    segments.push('Workel MCP ready — scopes not probed (WORKEL_SKIP_STARTUP_CHECK=true)');
    segments.push(`${params.toolNames.length} tools registered: ${params.toolNames.join(', ')}`);
  }

  // `isCustomBaseUrl` (config.ts) is already `baseUrl !== DEFAULT_API_BASE_URL`
  // — reused here rather than re-comparing against a second, hand-typed copy
  // of that same default string.
  if (params.isCustomBaseUrl) {
    segments.push(`base URL: ${params.baseUrl}`);
  }

  return `${redact(segments.join(' — '))}\n`;
}

/**
 * Turns a probe failure (network error, non-2xx `WorkelApiError`, or a
 * malformed 200 body) into the one-line text both `boot`'s failure path and
 * `doctor.ts` (T12) print. For a `WorkelApiError` this is exactly the T4
 * terminal message (`WorkelApiError#message` already IS `mapApiError`'s
 * `.message`, redacted) — `doctor` relies on that being the same text `boot`
 * would have printed for the identical failure, not a re-derived paraphrase.
 *
 * Exported for `doctor.ts` (T12).
 */
export function describeFailure(err: unknown): string {
  if (err instanceof WorkelApiError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  // undici reports every transport failure as the two-word message "fetch
  // failed" and puts the only actionable detail (ECONNREFUSED, ENOTFOUND,
  // ETIMEDOUT, a TLS reason) on `err.cause`. Dropping it made `doctor` —
  // the command whose entire job is diagnosing these — useless.
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail =
    typeof cause?.code === 'string'
      ? cause.code
      : typeof cause?.message === 'string'
        ? cause.message
        : null;
  const described = detail === null ? raw : `${raw} (${detail})`;
  return `Failed to reach the Workel API to verify this key: ${sanitizeForLine(described)}`;
}

/**
 * Issues the `GET /me` startup probe and parses the result, or throws
 * (network error, non-2xx → `WorkelApiError`, or a malformed 200 body →
 * `MalformedMeResponseError`). This is the ENTIRE probe both `boot`'s
 * non-skip path and `doctor.ts` (T12) run — extracted so the two can never
 * observe a different probe.
 */
export async function probeMe(client: WorkelApiClient): Promise<MeResponse> {
  const result = await client.get<unknown>('/me');
  return parseMeResponse(result.data);
}

/**
 * Runs the full boot sequence and returns the built (but not yet connected)
 * server plus the tool names it registered — or `undefined` when boot could
 * not proceed (missing key, or a startup probe failure), in which case
 * `deps.exit` has already been called and the caller should not attempt to
 * connect any transport.
 */
/**
 * Probes every configured key and turns the results into registry input.
 *
 * Sequential, not parallel: N keys is a handful, each probe is one request,
 * and a failure this way names the key that failed rather than surfacing
 * whichever of several concurrent rejections happened to land first.
 */
async function probeAllWorkspaces(
  apiKeys: string[],
  baseUrl: string,
  injectedFetch: FetchLike
): Promise<{ workspaces: ProbedWorkspace[]; responses: MeResponse[] }> {
  const probed: ProbedWorkspace[] = [];
  const responses: MeResponse[] = [];

  for (const [index, apiKey] of apiKeys.entries()) {
    const client = createWorkelApiClient({ baseUrl, apiKey, fetch: injectedFetch, sleep: defaultSleep });

    let me: MeResponse;
    try {
      me = await probeMe(client);
    } catch (err) {
      // Position, never the key itself — the key must not reach stderr.
      const which = apiKeys.length === 1 ? 'The configured API key' : `API key #${index + 1} of ${apiKeys.length}`;
      throw new Error(`${which} could not be verified. ${describeFailure(err)}`);
    }

    responses.push(me);
    probed.push({
      id: me.workspace.id ?? me.workspace.name,
      name: me.workspace.name,
      keyName: me.key.name,
      scopes: me.key.scopes,
      client,
    });
  }

  return { workspaces: probed, responses };
}

export async function boot(deps: BootDeps): Promise<BootResult | undefined> {
  const { env, fetch: injectedFetch, stderr, exit, installCrashHandlers } = deps;

  installCrashHandlers(stderr);

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    stderr(`${redact((err as Error).message)}\n`);
    exit(1);
    return undefined;
  }

  // Every key, not just the first — redact() must be able to scrub any of
  // them out of a log line or error message.
  for (const key of config.apiKeys) registerSecret(key);

  /**
   * READ_TOOLS unconditionally plus the write tools when the operator opted in.
   * Before this, boot passed READ_TOOLS alone, so the four write tools could
   * never register on the stdio path no matter the key's scopes or the flag —
   * `registeredWriteTools` was reachable only from the (unshipped) remote
   * transport. WORKEL_ENABLE_WRITES was documented, tested, and inert.
   */
  const tools = [...READ_TOOLS, ...registeredWriteTools(config.enableWrites)];

  const client = createWorkelApiClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: injectedFetch,
    sleep: defaultSleep,
  });

  const gates = toolScopeGates(client, tools);

  if (config.skipStartupCheck) {
    // Every scope any gate declares, deduped — permits every tool regardless
    // of which real scopes the key would have turned out to carry, since the
    // whole point of skipping the probe is to start anyway.
    const allScopes = new Set(gates.map((gate) => gate.scope).filter((scope): scope is string => scope !== undefined));
    const caps: ServerCaps = { scopes: Array.from(allScopes) };
    if (config.apiKeys.length > 1) {
      // Workspaces are addressed by name, and names only come from the probe
      // this flag skips. Starting anyway would leave every workspace unaddressable.
      stderr(
        'WORKEL_SKIP_STARTUP_CHECK cannot be combined with multiple API keys: workspace names come ' +
          'from the startup probe, so without it there is no way to address one workspace over another.\n'
      );
      exit(1);
      return undefined;
    }

    const server = buildServer(client, caps, tools);
    const toolNames = gates.map((gate) => gate.name);

    stderr(
      formatBootLine({
        probed: false,
        toolNames,
        baseUrl: config.baseUrl,
        isCustomBaseUrl: config.isCustomBaseUrl,
      })
    );

    return { server, toolNames };
  }

  let probeResult: { workspaces: ProbedWorkspace[]; responses: MeResponse[] };
  try {
    probeResult = await probeAllWorkspaces(config.apiKeys, config.baseUrl, injectedFetch);
  } catch (err) {
    stderr(`${redact(describeFailure(err))} ${SKIP_STARTUP_CHECK_HINT}\n`);
    exit(1);
    return undefined;
  }

  const registry = createWorkspaceRegistry(probeResult.workspaces);

  /**
   * Caps for REPORTING are the union across keys, matching what
   * `buildWorkspaceServer` registers against. Per-call authorization still
   * uses each workspace's own scopes — the union decides only whether a tool
   * appears at all.
   */
  const caps: ServerCaps = { scopes: registry.unionScopes };
  const server = buildWorkspaceServer(registry, tools);
  const toolNames = permittedToolNames(gates, caps);

  const me = probeResult.responses[0];
  const firstEntry = registry.entries[0];

  stderr(
    formatBootLine({
      probed: true,
      workspaces: registry.entries.map((e) => ({ label: e.label, keyName: e.keyName })),
      workspaceName: firstEntry.name,
      keyName: firstEntry.keyName,
      scopes: registry.unionScopes,
      toolNames,
      writeBudget: me.rate_limit.write,
      baseUrl: config.baseUrl,
      isCustomBaseUrl: config.isCustomBaseUrl,
    })
  );

  return { server, toolNames };
}

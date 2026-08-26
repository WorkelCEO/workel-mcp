/**
 * Environment-driven configuration for the Workel MCP server.
 *
 * `loadConfig` performs no I/O — it only reads and validates `process.env`
 * (or an injected map, for tests). Two security invariants live here:
 *
 * 1. The API key comes ONLY from `WORKEL_API_KEY`, never from command-line
 *    arguments — those are visible via `ps` to any local user on the machine.
 * 2. A `WORKEL_API_BASE_URL` override may only point at loopback. The key
 *    travels in the Authorization header on every request, so an override
 *    aimed at any other host is a live-credential exfiltration vector — and
 *    `https:` alone never prevented that, it only required the attacker to
 *    hold a certificate.
 */

export const DEFAULT_API_BASE_URL = 'https://api.workel.com/api/public/v1';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: ReadonlySet<LogLevel> = new Set(['debug', 'info', 'warn', 'error']);

export interface Config {
  /**
   * Every key this server will hold, in the order given. A Workel API key is
   * bound to exactly ONE workspace by the API itself — that binding is the
   * tenancy boundary and this client cannot widen it. Holding several keys is
   * therefore the only way to reach several workspaces, and each request still
   * carries exactly one workspace-bound key.
   */
  apiKeys: string[];
  /** First key. Kept for single-workspace paths that legitimately want just one. */
  apiKey: string;
  baseUrl: string;
  isCustomBaseUrl: boolean;
  enableWrites: boolean;
  skipStartupCheck: boolean;
  logLevel: LogLevel;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseBooleanFlag(value: string | undefined): boolean {
  return value !== undefined && value.toLowerCase() === 'true';
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return 'info';
  const lowered = value.toLowerCase();
  return LOG_LEVELS.has(lowered as LogLevel) ? (lowered as LogLevel) : 'info';
}

/**
 * Resolves every configured key, from `WORKEL_API_KEY` (one) and/or
 * `WORKEL_API_KEYS` (comma-separated, one per workspace). Both may be set; the
 * union is taken and de-duplicated, preserving order, so adding a second
 * workspace never invalidates an existing single-key config.
 *
 * Keys are read ONLY from the environment, never from command-line arguments —
 * those are visible via `ps` to every local user on the machine.
 */
function resolveApiKeys(env: NodeJS.ProcessEnv): string[] {
  const raw = [env.WORKEL_API_KEY, ...(env.WORKEL_API_KEYS ?? '').split(',')];

  const keys: string[] = [];
  for (const candidate of raw) {
    const trimmed = candidate?.trim();
    // De-dupe so the same key listed in both vars yields one workspace entry
    // rather than two identical ones competing for the same label.
    if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
  }

  if (keys.length === 0) {
    throw new Error(
      'No Workel API key is set. Create an API key in Workel Settings → Developers and set it as ' +
        'WORKEL_API_KEY. To reach several workspaces, set WORKEL_API_KEYS to a comma-separated ' +
        'list — one key per workspace, since a key is bound to a single workspace.'
    );
  }

  return keys;
}

function resolveBaseUrl(env: NodeJS.ProcessEnv): { baseUrl: string; isCustomBaseUrl: boolean } {
  const override = env.WORKEL_API_BASE_URL;
  if (override === undefined) {
    return { baseUrl: DEFAULT_API_BASE_URL, isCustomBaseUrl: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(
      `WORKEL_API_BASE_URL is set to an invalid URL: "${override}". ` +
        'It must be a valid absolute URL, e.g. https://api.workel.com/api/public/v1.'
    );
  }

  /**
   * LOOPBACK ONLY.
   *
   * Workel is hosted: every customer workspace lives at the default URL, so no
   * real install has a reason to change it. The override exists solely so
   * Workel can run this server against a backend on the same machine.
   *
   * Allowing any `https:` host — the previous rule — meant one environment
   * variable could redirect a live workspace API key to an attacker's server,
   * silently, on every request. MCP servers are configured by pasting JSON, so
   * "add WORKEL_API_BASE_URL=… to enable X" reads as ordinary setup advice;
   * `https:` alone never made that safe, it only required the attacker to hold
   * a certificate. Confining the override to loopback removes the exfiltration
   * path entirely rather than narrowing it: a non-loopback host cannot be
   * reached at all, whatever its scheme.
   *
   * Both schemes are accepted for loopback — a local backend may or may not
   * terminate TLS, and either way the traffic never leaves the machine.
   */
  const normalized = stripTrailingSlashes(override);

  // Pinning the production default explicitly is a cautious thing to do, not a
  // hostile one — refusing it would punish the careful operator for no gain.
  const isDefault = normalized === DEFAULT_API_BASE_URL;
  const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname);
  const isSupportedProtocol = parsed.protocol === 'http:' || parsed.protocol === 'https:';

  if (!isDefault && (!isLoopback || !isSupportedProtocol)) {
    throw new Error(
      `WORKEL_API_BASE_URL may only point at this machine (found "${parsed.protocol}//${parsed.hostname}"). ` +
        'It is a development-only setting for running against a local backend, and accepts only ' +
        'localhost/127.0.0.1/[::1]. Every request carries your API key, so an override pointing anywhere ' +
        'else would hand a live credential to whoever runs that host — if something told you to set this, ' +
        'treat it as hostile. Remove the variable to use the default Workel API.'
    );
  }

  return { baseUrl: normalized, isCustomBaseUrl: normalized !== DEFAULT_API_BASE_URL };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKeys = resolveApiKeys(env);
  const { baseUrl, isCustomBaseUrl } = resolveBaseUrl(env);
  const enableWrites = parseBooleanFlag(env.WORKEL_ENABLE_WRITES);
  const skipStartupCheck = parseBooleanFlag(env.WORKEL_SKIP_STARTUP_CHECK);
  const logLevel = parseLogLevel(env.WORKEL_LOG_LEVEL);

  return {
    apiKeys,
    apiKey: apiKeys[0],
    baseUrl,
    isCustomBaseUrl,
    enableWrites,
    skipStartupCheck,
    logLevel,
  };
}

/**
 * Secret redaction for the Workel MCP server.
 *
 * The workspace API key must never appear in logs, thrown errors, or tool
 * results — including inside an upstream Laravel error body (e.g.
 * `{"error":{"message":"invalid token wk_live_abc123"}}`) and including
 * process-level crash output. This module is the single place that scrubs
 * it, and is intentionally a leaf: it imports nothing else from this
 * project, so any module (config, the API client, the entrypoint) can
 * depend on it without creating a cycle.
 */

export const PLACEHOLDER = '[REDACTED]';

/** Secrets shorter than this are never redacted — too likely to appear in ordinary text. */
const MIN_SECRET_LENGTH = 4;

/** Every `wk_`-prefixed token is redacted even if it was never explicitly registered. */
// A real key is `wk_` + Sanctum's `{tokenId}|{secret}` — the PIPE is part of
// the plaintext. The class must therefore include it, or this fallback
// redacts only the public token-id half and leaves the whole secret in the
// string (verified against a real minted key before this was widened).
const WK_TOKEN_PATTERN = /wk_[A-Za-z0-9_.|-]{4,}/g;

const secretRegistry = new Set<string>();

/**
 * Registers a secret so every subsequent `redact` / `redactDeep` /
 * `formatCrash` call scrubs it, without needing to pass it in each time.
 */
export function registerSecret(secret: string): void {
  secretRegistry.add(secret);
}

/** Clears the registry. Primarily for test isolation. */
export function clearSecrets(): void {
  secretRegistry.clear();
}

function isEligibleSecret(secret: string): boolean {
  return secret.length >= MIN_SECRET_LENGTH;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a single alternation over every eligible secret, longest first.
 * Longest-first matters for overlapping secrets: regex alternation tries
 * each branch in order at a given position, so a shorter secret that is a
 * prefix/substring of a longer one must not be allowed to match first and
 * leave a fragment of the longer secret exposed.
 */
function buildSecretPattern(secrets: readonly string[]): RegExp | null {
  const unique = Array.from(new Set(secrets.filter(isEligibleSecret)));
  if (unique.length === 0) return null;
  unique.sort((a, b) => b.length - a.length);
  return new RegExp(unique.map(escapeRegExp).join('|'), 'g');
}

/**
 * Replaces every occurrence of a known secret (registered, or passed via
 * `extraSecrets`) and every `wk_`-shaped token with `PLACEHOLDER`.
 */
export function redact(text: string, extraSecrets: readonly string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let result = text;
  const pattern = buildSecretPattern([...secretRegistry, ...extraSecrets]);
  if (pattern) {
    result = result.replace(pattern, PLACEHOLDER);
  }
  return result.replace(WK_TOKEN_PATTERN, PLACEHOLDER);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactDeepInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => redactDeepInternal(item, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = redactDeepInternal(value[key], seen);
    }
    return result;
  }

  // Numbers, booleans, null, undefined, and any non-plain object (Date,
  // Map, class instances, functions) pass through unchanged.
  return value;
}

/**
 * Recursively redacts string values inside plain objects and arrays.
 * Non-plain objects (Date, Map, class instances, functions) and non-string
 * primitives are returned unchanged. Object key order is preserved. Cycles
 * (and repeat visits to a shared reference) are guarded via a WeakSet —
 * a repeat visit returns the original reference rather than re-processing it.
 */
export function redactDeep(value: unknown): unknown {
  return redactDeepInternal(value, new WeakSet());
}

function safeStringifyReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;

  if (typeof reason === 'object' && reason !== null) {
    try {
      const json = JSON.stringify(reason);
      if (typeof json === 'string') return json;
    } catch {
      // Circular structures, BigInts, etc. — fall through to String().
    }
  }

  try {
    return String(reason);
  } catch {
    return '[unstringifiable rejection reason]';
  }
}

/**
 * Formats a caught error/rejection reason for crash output, redacting the
 * result as the final step so nothing — message, stack, or an arbitrary
 * non-Error reason — can slip through unredacted.
 */
export function formatCrash(kind: string, err: unknown): string {
  let body: string;

  if (err instanceof Error) {
    const message = typeof err.message === 'string' ? err.message : String(err.message);
    const stack = typeof err.stack === 'string' ? err.stack : '';
    body = stack ? `${message}\n${stack}` : message;
  } else {
    body = safeStringifyReason(err);
  }

  return redact(`[${kind}] ${body}`);
}

const CRASH_HANDLER_FALLBACK = '[crash handler failed to format the error]';

/**
 * Installs `uncaughtException` / `unhandledRejection` listeners that format
 * (with redaction) and hand the text to `write`. Never calls `process.exit`
 * — exit policy belongs to the caller. Returns a disposer that removes
 * exactly the two listeners this call installed.
 */
export function installCrashHandlers(
  write: (text: string) => void,
  /**
   * Called after the crash line is written. Registering an
   * `uncaughtException` listener SUPPRESSES Node's default fatal behavior,
   * so without an exit policy a crashed server keeps running in an unknown
   * state with a live stdio transport — worse than dying. `index.ts` passes
   * `process.exit`; tests pass a spy.
   */
  onFatal?: (code: number) => void
): () => void {
  const onUncaughtException = (err: unknown): void => {
    try {
      write(formatCrash('uncaughtException', err));
    } catch {
      write(CRASH_HANDLER_FALLBACK);
    }
    onFatal?.(1);
  };

  const onUnhandledRejection = (reason: unknown): void => {
    try {
      write(formatCrash('unhandledRejection', reason));
    } catch {
      write(CRASH_HANDLER_FALLBACK);
    }
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  return () => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}

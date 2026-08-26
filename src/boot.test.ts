import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { boot, type BootDeps } from './boot';
import { DEFAULT_API_BASE_URL } from './config';
import type { FetchLike } from './api/client';

// No real network or real process anywhere in this file — `fetch` always
// returns a hand-built `Response` (same technique as api/client.test.ts),
// and every side effect (`stdout`/`stderr`/`exit`/`installCrashHandlers`) is
// a jest mock injected through `BootDeps`. `boot` itself never touches
// stdio or `process.exit` directly — that is the entire point of the seam
// this test exercises.

const API_KEY = 'wk_test_boot_key_0123456789';
const ALL_READ_SCOPES = ['read:projects', 'read:tasks', 'read:members', 'read:events'];
const ALL_TEN_TOOLS = [
  'workel_whoami',
  'workel_list_projects',
  'workel_get_project',
  'workel_list_project_columns',
  'workel_list_tasks',
  'workel_get_task',
  'workel_list_task_comments',
  'workel_list_task_activity',
  'workel_list_members',
  'workel_list_events',
].sort();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

interface MeOverrides {
  workspaceName?: string;
  keyName?: string;
  scopes?: string[];
  writeRemaining?: number;
  writeLimit?: number;
}

function meResponseBody(overrides: MeOverrides = {}): unknown {
  return {
    workspace: { id: 'ws_1', name: overrides.workspaceName ?? 'Acme Inc' },
    key: { name: overrides.keyName ?? 'ci-key', scopes: overrides.scopes ?? ALL_READ_SCOPES },
    rate_limit: {
      key: { limit: 300, remaining: 299 },
      workspace: { limit: 1000, remaining: 999 },
      write: { limit: overrides.writeLimit ?? 60, remaining: overrides.writeRemaining ?? 59 },
    },
  };
}

function errorEnvelope(code: string): unknown {
  return { error: { type: 'authentication_error', code, message: 'irrelevant upstream text' } };
}

interface Harness {
  deps: BootDeps;
  stdout: jest.Mock;
  stderr: jest.Mock;
  exit: jest.Mock;
  installCrashHandlers: jest.Mock;
  fetchMock: jest.Mock;
}

function makeHarness(env: NodeJS.ProcessEnv, fetchMock: jest.Mock = jest.fn()): Harness {
  const stdout = jest.fn();
  const stderr = jest.fn();
  const exit = jest.fn();
  const installCrashHandlers = jest.fn().mockReturnValue(() => {});
  const deps: BootDeps = {
    env,
    fetch: fetchMock as unknown as FetchLike,
    stdout,
    stderr,
    exit,
    installCrashHandlers,
  };
  return { deps, stdout, stderr, exit, installCrashHandlers, fetchMock };
}

/** Asserts `text` is exactly one line: ends with a single `\n`, and contains no other newline before it. */
function expectExactlyOneLine(text: string): void {
  expect(text.endsWith('\n')).toBe(true);
  expect(text.slice(0, -1)).not.toContain('\n');
}

describe('boot: missing API key', () => {
  it('writes the exact config error to stderr, exits non-zero, and never calls fetch', async () => {
    const { deps, stdout, stderr, exit, fetchMock } = makeHarness({});

    const result = await boot(deps);

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0][0]).not.toBe(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    const message = stderr.mock.calls[0][0] as string;
    expect(message).toMatch(/WORKEL_API_KEY/);
    expect(message).toMatch(/Developers/);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('boot: crash handlers installed first', () => {
  it('installs crash handlers before the first fetch call', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody()));
    const { deps, installCrashHandlers } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    await boot(deps);

    expect(installCrashHandlers).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(installCrashHandlers.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it('installs crash handlers even when the API key is missing (before config validation ever runs)', async () => {
    const { deps, installCrashHandlers } = makeHarness({});

    await boot(deps);

    expect(installCrashHandlers).toHaveBeenCalledTimes(1);
  });
});

describe('boot: happy path', () => {
  it('reports workspace, key, scopes, tool count/names, and the LIVE write budget from the probe — in exactly one stderr line, stdout untouched', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, meResponseBody({ writeRemaining: 17, writeLimit: 40 })));
    const { deps, stdout, stderr, exit } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(exit).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result!.server).toBeInstanceOf(McpServer);
    expect(result!.toolNames.sort()).toEqual(ALL_TEN_TOOLS);

    expect(stderr).toHaveBeenCalledTimes(1);
    const line = stderr.mock.calls[0][0] as string;
    expectExactlyOneLine(line);
    // 17 (not the default-looking 30) proves this was read from the mocked
    // payload rather than some constant baked into boot.ts.
    expect(line).toContain('17');
    expect(line).toContain('40');
    expect(line).toContain('Acme Inc');
    expect(line).toContain('ci-key');
    for (const scope of ALL_READ_SCOPES) {
      expect(line).toContain(scope);
    }
    for (const name of ALL_TEN_TOOLS) {
      expect(line).toContain(name);
    }
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('boot: scope-gated tool registration', () => {
  it('registers workel_whoami plus exactly the three project/column tools when the key carries only read:projects — the other six are absent', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody({ scopes: ['read:projects'] })));
    const { deps, stdout } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(result!.toolNames.sort()).toEqual(
      ['workel_whoami', 'workel_list_projects', 'workel_get_project', 'workel_list_project_columns'].sort()
    );
    for (const absent of ['workel_list_tasks', 'workel_get_task', 'workel_list_task_comments', 'workel_list_task_activity', 'workel_list_members', 'workel_list_events']) {
      expect(result!.toolNames).not.toContain(absent);
    }
    expect(stdout).not.toHaveBeenCalled();
  });

  it('registers all ten tools when the key carries all four read scopes', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody({ scopes: ALL_READ_SCOPES })));
    const { deps } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(result!.toolNames.sort()).toEqual(ALL_TEN_TOOLS);
  });

  it('still registers exactly ten tools when the key ALSO carries write:tasks — a write scope alone registers no write tool', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, meResponseBody({ scopes: [...ALL_READ_SCOPES, 'write:tasks'] })));
    const { deps } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(result!.toolNames.sort()).toEqual(ALL_TEN_TOOLS);
  });

  it('registers only workel_whoami when the key carries no scopes at all', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody({ scopes: [] })));
    const { deps } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(result!.toolNames).toEqual(['workel_whoami']);
  });
});

describe('boot: base URL is reported only when non-default', () => {
  it('omits the base URL from the boot line when it is the default', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody()));
    const { deps, stdout, stderr } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    await boot(deps);

    const line = stderr.mock.calls[0][0] as string;
    expect(line).not.toContain(DEFAULT_API_BASE_URL);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('includes the base URL when it was overridden to a non-default https:// value', async () => {
    // Loopback: the override is loopback-only (config.ts). This test is about
    // REPORTING a non-default URL, not about which hosts are reachable.
    const customUrl = 'http://localhost:8000/api/public/v1';
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody()));
    const { deps, stdout, stderr } = makeHarness({ WORKEL_API_KEY: API_KEY, WORKEL_API_BASE_URL: customUrl }, fetchMock);

    await boot(deps);

    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain(customUrl);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('boot: WORKEL_SKIP_STARTUP_CHECK', () => {
  it('never calls fetch, registers all ten tools, and states that scopes were not probed', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('fetch must not be called when the check is skipped'));
    const { deps, stdout, stderr, exit } = makeHarness(
      { WORKEL_API_KEY: API_KEY, WORKEL_SKIP_STARTUP_CHECK: 'true' },
      fetchMock
    );

    const result = await boot(deps);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(result!.toolNames.sort()).toEqual(ALL_TEN_TOOLS);
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = stderr.mock.calls[0][0] as string;
    expectExactlyOneLine(line);
    expect(line.toLowerCase()).toContain('not probed');
    // Nothing it cannot know is printed as a placeholder.
    expect(line).not.toContain('Acme Inc');
    expect(line).not.toMatch(/write budget/);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('boot: probe failure — non-2xx response', () => {
  it("maps a known error code through T4's guidance, appends the skip-check remedy, and exits non-zero", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(401, errorEnvelope('invalid_api_key')));
    const { deps, stdout, stderr, exit } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(result).toBeUndefined();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0][0]).not.toBe(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    const message = stderr.mock.calls[0][0] as string;
    expectExactlyOneLine(message);
    expect(message).toMatch(/rejected/i);
    expect(message).toContain('WORKEL_SKIP_STARTUP_CHECK=true');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('produces a generic message for an unrecognized error code (still terminal, still redacted, still one line)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(500, null));
    const { deps, stdout, stderr } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    await boot(deps);

    const message = stderr.mock.calls[0][0] as string;
    expectExactlyOneLine(message);
    expect(message).toContain('WORKEL_SKIP_STARTUP_CHECK=true');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('never lets the configured API key reach the printed failure message, even if an unrecognized error code echoes it', async () => {
    const leakyCode = `token_${API_KEY}_rejected`;
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(400, errorEnvelope(leakyCode)));
    const { deps, stdout, stderr } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    await boot(deps);

    const message = stderr.mock.calls[0][0] as string;
    expect(message).not.toContain(API_KEY);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('boot: probe failure — fetch rejects (network error)', () => {
  it('writes a generic failure message plus the skip-check remedy, exits non-zero, never touches stdout', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { deps, stdout, stderr, exit } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(result).toBeUndefined();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0][0]).not.toBe(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    const message = stderr.mock.calls[0][0] as string;
    expectExactlyOneLine(message);
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('WORKEL_SKIP_STARTUP_CHECK=true');
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('boot: malformed 200 response from /me', () => {
  it('is treated as a probe failure rather than throwing out of boot()', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { unexpected: 'shape' }));
    const { deps, stdout, stderr, exit } = makeHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const result = await boot(deps);

    expect(result).toBeUndefined();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expectExactlyOneLine(stderr.mock.calls[0][0] as string);
    expect(stdout).not.toHaveBeenCalled();
  });
});

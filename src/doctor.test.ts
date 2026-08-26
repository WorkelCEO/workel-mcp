import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runDoctor, type DoctorDeps } from './doctor';
import { main } from './index';
import { boot, type BootDeps } from './boot';
import { DEFAULT_API_BASE_URL } from './config';
import { mapApiError } from './api/errors';
import type { FetchLike } from './api/client';

// No real network or real process anywhere in this file — `fetch` always
// returns a hand-built `Response` (same technique as boot.test.ts and
// api/client.test.ts), and every side effect (`stdout`/`stderr`/`exit`/
// `installCrashHandlers`) is a jest mock injected through `DoctorDeps` /
// `BootDeps`. The one real module mock in this file is the SDK's
// `StdioServerTransport` — necessary because `index.ts` constructs it
// directly (not via injection), and the whole point of this file's `main`
// tests is proving doctor mode never reaches that construction.
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
  })),
}));

const API_KEY = 'wk_test_doctor_key_0123456789';
const ALL_READ_SCOPES = ['read:projects', 'read:tasks', 'read:members', 'read:events'];
const ALL_NINE_TOOLS = [
  'workel_whoami',
  'workel_list_projects',
  'workel_get_project',
  'workel_list_project_columns',
  'workel_list_tasks',
  'workel_get_task',
  'workel_list_task_comments',
  'workel_list_members',
  'workel_list_events',
];
const PROJECT_SCOPE_ONLY_TOOLS = ['workel_whoami', 'workel_list_projects', 'workel_get_project', 'workel_list_project_columns'];
const TOOLS_ABSENT_UNDER_PROJECT_SCOPE_ONLY = ALL_NINE_TOOLS.filter((name) => !PROJECT_SCOPE_ONLY_TOOLS.includes(name));

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

function makeDoctorHarness(env: NodeJS.ProcessEnv, fetchMock: jest.Mock = jest.fn()) {
  const stdout = jest.fn();
  const stderr = jest.fn();
  const deps: DoctorDeps = {
    env,
    fetch: fetchMock as unknown as FetchLike,
    stdout,
    stderr,
  };
  return { deps, stdout, stderr, fetchMock };
}

function makeMainHarness(env: NodeJS.ProcessEnv, fetchMock: jest.Mock = jest.fn()) {
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

describe('main: argv doctor dispatches to runDoctor and never constructs a transport', () => {
  it('runs the /me probe through the doctor path and does not construct StdioServerTransport', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody()));
    const { deps, exit } = makeMainHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    await main(['node', 'workel-mcp', 'doctor'], deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(StdioServerTransport).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('runDoctor: successful probe', () => {
  it('reports base URL (default case), workspace, key, every scope, every tool that would register, and the live budget numbers — returns 0', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, meResponseBody({ writeRemaining: 17, writeLimit: 40 })));
    const { deps, stdout, stderr } = makeDoctorHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const code = await runDoctor(deps);

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls[0][0] as string;

    expect(output).toContain(DEFAULT_API_BASE_URL);
    expect(output).toContain('Acme Inc');
    expect(output).toContain('ci-key');
    for (const scope of ALL_READ_SCOPES) {
      expect(output).toContain(scope);
    }
    for (const name of ALL_NINE_TOOLS) {
      expect(output).toContain(name);
    }
    // 17/40 (not some default-looking pair) proves these came from the mocked payload.
    expect(output).toContain('17');
    expect(output).toContain('40');
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('runDoctor: base URL override marker', () => {
  it('includes the overridden URL and marks it inline, distinct from the default-case assertion above', async () => {
    // Loopback: the override is loopback-only (config.ts). This test is about
    // REPORTING a non-default URL, not about which hosts are reachable.
    const customUrl = 'http://localhost:8000/api/public/v1';
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody()));
    const { deps, stdout } = makeDoctorHarness(
      { WORKEL_API_KEY: API_KEY, WORKEL_API_BASE_URL: customUrl },
      fetchMock
    );

    const code = await runDoctor(deps);

    expect(code).toBe(0);
    const output = stdout.mock.calls[0][0] as string;
    expect(output).toContain(customUrl);
    expect(output).toMatch(/override/i);
  });
});

describe('runDoctor: probe failure — 401', () => {
  it('returns a non-zero code and includes the exact T4 terminal message for the code', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(401, errorEnvelope('invalid_api_key')));
    const { deps, stdout, stderr } = makeDoctorHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const code = await runDoctor(deps);

    expect(code).not.toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls[0][0] as string;
    // Reuses T4's own mapper (errors.ts) to derive the exact expected text,
    // rather than a hand-copied literal that could drift from it.
    const expected = mapApiError(401, errorEnvelope('invalid_api_key'));
    expect(output).toContain(expected.message);
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('runDoctor: redaction', () => {
  it('never lets the configured API key reach stdout, even when an unrecognized error code echoes it', async () => {
    const leakyCode = `token_${API_KEY}_rejected`;
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(400, errorEnvelope(leakyCode)));
    const { deps, stdout } = makeDoctorHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const code = await runDoctor(deps);

    expect(code).not.toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls[0][0] as string;
    expect(output).not.toContain(API_KEY);
  });
});

describe('runDoctor vs boot: stream separation', () => {
  it('doctor writes its report to stdout and never touches its injected stderr', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody()));
    const { deps, stdout, stderr } = makeDoctorHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    await runDoctor(deps);

    expect(stdout).toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('boot, run alongside doctor in this same file, writes only to stderr and leaves stdout untouched', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody()));
    const { deps, stdout, stderr } = makeMainHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    await boot(deps);

    expect(stderr).toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('main: too far #1 — normal startup (no argv) still constructs a transport', () => {
  it('with no subcommand, the transport IS constructed and doctor does not run', async () => {
    const { deps, exit } = makeMainHarness({ WORKEL_API_KEY: API_KEY, WORKEL_SKIP_STARTUP_CHECK: 'true' });

    await main(['node', 'workel-mcp'], deps);

    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('main: too far #2 — an unknown subcommand behaves as normal startup', () => {
  it('argv[2] === "doctr" (typo) is treated as normal startup, not doctor', async () => {
    const { deps, exit } = makeMainHarness({ WORKEL_API_KEY: API_KEY, WORKEL_SKIP_STARTUP_CHECK: 'true' });

    await main(['node', 'workel-mcp', 'doctr'], deps);

    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('runDoctor: too far #3 — reports only the tools a narrow-scoped key would actually register', () => {
  it('lists exactly the four tools read:projects permits, and none of the other five', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponseBody({ scopes: ['read:projects'] })));
    const { deps, stdout } = makeDoctorHarness({ WORKEL_API_KEY: API_KEY }, fetchMock);

    const code = await runDoctor(deps);

    expect(code).toBe(0);
    const output = stdout.mock.calls[0][0] as string;
    for (const present of PROJECT_SCOPE_ONLY_TOOLS) {
      expect(output).toContain(present);
    }
    for (const absent of TOOLS_ABSENT_UNDER_PROJECT_SCOPE_ONLY) {
      expect(output).not.toContain(absent);
    }
  });
});

import { boot, type BootDeps } from './boot';
import type { FetchLike } from './api/client';

/**
 * Two things boot got wrong before 0.2.0, both pinned here:
 *
 * 1. WRITE TOOLS NEVER REGISTERED. `boot` passed only `READ_TOOLS` to
 *    `buildServer`; `registeredWriteTools` was reachable solely from the
 *    unshipped remote transport. So `WORKEL_ENABLE_WRITES` was documented,
 *    tested at the unit level, and completely inert on the only path that
 *    ships — 13 advertised tools, 9 registrable.
 *
 * 2. ONE KEY, ONE WORKSPACE. A user in several workspaces had no way to reach
 *    them from one server.
 */

const READ_SCOPES = ['read:projects', 'read:tasks', 'read:members', 'read:events'];
const ALL_SCOPES = [...READ_SCOPES, 'write:tasks', 'write:comments', 'write:events'];

function meBody(workspaceId: string, workspaceName: string, keyName: string, scopes: string[]): unknown {
  return {
    workspace: { id: workspaceId, name: workspaceName },
    key: { name: keyName, scopes },
    rate_limit: {
      key: { limit: 300, remaining: 299 },
      workspace: { limit: 1000, remaining: 999 },
      write: { limit: 60, remaining: 59 },
    },
  };
}

interface Harness {
  deps: BootDeps;
  stderr: jest.Mock;
  exit: jest.Mock;
}

/** Answers each successive `GET /me` with the next body in `bodies`. */
function makeHarness(env: NodeJS.ProcessEnv, bodies: unknown[]): Harness {
  let call = 0;
  const fetchMock = jest.fn().mockImplementation(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  });

  const stderr = jest.fn();
  const exit = jest.fn();
  return {
    stderr,
    exit,
    deps: {
      env,
      fetch: fetchMock as unknown as FetchLike,
      stdout: jest.fn(),
      stderr,
      exit,
      installCrashHandlers: jest.fn().mockReturnValue(() => {}),
    },
  };
}

describe('write tools reach the shipped server', () => {
  it('registers the four write tools when the key has the scopes AND the flag is set', async () => {
    const { deps } = makeHarness(
      { WORKEL_API_KEY: 'wk_a', WORKEL_ENABLE_WRITES: 'true' },
      [meBody('1', 'Acme', 'k', ALL_SCOPES)]
    );

    const result = await boot(deps);

    expect(result?.toolNames).toEqual(
      expect.arrayContaining([
        'workel_create_task',
        'workel_update_task',
        'workel_create_task_comment',
        'workel_create_event',
      ])
    );
    expect(result?.toolNames).toHaveLength(13);
  });

  it('withholds them when the flag is absent, even though the key carries write scopes', async () => {
    const { deps } = makeHarness({ WORKEL_API_KEY: 'wk_a' }, [meBody('1', 'Acme', 'k', ALL_SCOPES)]);

    const result = await boot(deps);

    // Gate (b) of the double opt-in: scopes alone must never be enough.
    expect(result?.toolNames).toHaveLength(9);
    expect(result?.toolNames).not.toContain('workel_create_task');
  });

  it('withholds them when the flag is set but the key lacks write scopes', async () => {
    const { deps } = makeHarness(
      { WORKEL_API_KEY: 'wk_a', WORKEL_ENABLE_WRITES: 'true' },
      [meBody('1', 'Acme', 'k', READ_SCOPES)]
    );

    const result = await boot(deps);

    // Gate (a): the flag is local consent, the key's scopes are the authority.
    expect(result?.toolNames).toHaveLength(9);
  });
});

describe('several workspaces from one server', () => {
  it('probes every key and reports all workspaces on the ready line', async () => {
    const { deps, stderr } = makeHarness({ WORKEL_API_KEYS: 'wk_a, wk_b' }, [
      meBody('1', 'Acme', 'acme-key', READ_SCOPES),
      meBody('2', 'Personal', 'personal-key', READ_SCOPES),
    ]);

    const result = await boot(deps);

    expect(result).toBeDefined();
    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain('2 workspaces');
    expect(line).toContain('"Acme"');
    expect(line).toContain('"Personal"');
  });

  it('still registers one tool per name, not one per workspace', async () => {
    const { deps } = makeHarness({ WORKEL_API_KEYS: 'wk_a,wk_b,wk_c' }, [
      meBody('1', 'A', 'k1', READ_SCOPES),
      meBody('2', 'B', 'k2', READ_SCOPES),
      meBody('3', 'C', 'k3', READ_SCOPES),
    ]);

    const result = await boot(deps);

    // Three workspaces, still nine tools — the context cost does not scale.
    expect(result?.toolNames).toHaveLength(9);
  });

  it('de-duplicates a key repeated across both env vars', async () => {
    const { deps, stderr } = makeHarness({ WORKEL_API_KEY: 'wk_a', WORKEL_API_KEYS: 'wk_a' }, [
      meBody('1', 'Acme', 'k', READ_SCOPES),
    ]);

    await boot(deps);

    // One key, so the single-workspace line, not "1 workspaces".
    expect(stderr.mock.calls[0][0] as string).toContain('workspace "Acme"');
  });

  it('names which key failed rather than which request, when one of several is bad', async () => {
    let call = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify(meBody('1', 'Acme', 'k', READ_SCOPES)), { status: 200 });
      return new Response(
        JSON.stringify({ error: { type: 'authentication_error', code: 'invalid_api_key', message: 'x' } }),
        { status: 401 }
      );
    });
    const stderr = jest.fn();
    const exit = jest.fn();

    await boot({
      env: { WORKEL_API_KEYS: 'wk_good,wk_bad' },
      fetch: fetchMock as unknown as FetchLike,
      stdout: jest.fn(),
      stderr,
      exit,
      installCrashHandlers: jest.fn().mockReturnValue(() => {}),
    });

    expect(exit).toHaveBeenCalledWith(1);
    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain('#2 of 2');
    // Position, never the key material itself.
    expect(line).not.toContain('wk_bad');
  });

  it('refuses to skip the startup probe with several keys, since workspaces would be unaddressable', async () => {
    const { deps, stderr, exit } = makeHarness(
      { WORKEL_API_KEYS: 'wk_a,wk_b', WORKEL_SKIP_STARTUP_CHECK: 'true' },
      [meBody('1', 'Acme', 'k', READ_SCOPES)]
    );

    const result = await boot(deps);

    expect(result).toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls[0][0] as string).toContain('WORKEL_SKIP_STARTUP_CHECK');
  });
});

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer, type ServerCaps } from '../server';
import type { WorkelApiClient } from '../api/client';
import { READ_TOOLS } from './index';
import { WRITE_TOOLS, writesEnabledFromEnv, registeredWriteTools } from './registration';

// Deliberately NOT imported from server.test.ts / conventions.test.ts — doing
// so would re-execute those files' own top-level `describe` blocks as a side
// effect of the import, registering every one of their tests a second time
// (the same rule client.idempotency.test.ts documents for client.test.ts).

function fakeClient(): WorkelApiClient {
  return { get: jest.fn(), post: jest.fn(), postFile: jest.fn(), patch: jest.fn() };
}

/** Reads the tool names `buildServer` actually registered, straight off the constructed server. */
function registeredToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

describe('WRITE_TOOLS registry', () => {
  // The exhaustive list matters more than its length: a tool that mutates
  // workspace data but is missing here would never pass through the D5
  // double opt-in, so it would register on a read-only install.
  it('contains exactly the five write tools — no more, no fewer', () => {
    const names = WRITE_TOOLS.map((factory) => factory(fakeClient()).name);

    expect(new Set(names)).toEqual(
      new Set([
        'workel_create_task',
        'workel_update_task',
        'workel_create_task_comment',
        'workel_create_event',
        'workel_upload_task_attachment',
      ])
    );
    expect(names).toHaveLength(5);
  });

  it('every write tool declares a write:* scope, matching its endpoint', () => {
    const scopeByName: Record<string, string> = {
      workel_create_task: 'write:tasks',
      workel_update_task: 'write:tasks',
      workel_create_task_comment: 'write:comments',
      workel_create_event: 'write:events',
      workel_upload_task_attachment: 'write:attachments',
    };

    for (const factory of WRITE_TOOLS) {
      const tool = factory(fakeClient());
      // `scope` is optional on the descriptor (read tools like whoami carry
      // none) — a write tool without one would silently bypass gate (a).
      expect(tool.scope).toBeDefined();
      expect(tool.scope).toBe(scopeByName[tool.name]);
      expect(tool.scope?.startsWith('write:')).toBe(true);
    }
  });
});

describe('writesEnabledFromEnv — matches config.ts\'s WORKEL_ENABLE_WRITES semantics exactly', () => {
  it.each(['true', 'TRUE', 'True'])('parses %s as true', (value) => {
    expect(writesEnabledFromEnv({ WORKEL_ENABLE_WRITES: value })).toBe(true);
  });

  // Same exact table config.test.ts pins for loadConfig(...).enableWrites —
  // including the trailing-space "TRUE " case, which is false because
  // parseBooleanFlag (config.ts) does not trim before comparing.
  it.each(['1', 'yes', 'TRUE ', '', 'false'])('parses %j as false', (value) => {
    expect(writesEnabledFromEnv({ WORKEL_ENABLE_WRITES: value })).toBe(false);
  });

  it('is false when the variable is unset entirely', () => {
    expect(writesEnabledFromEnv({})).toBe(false);
  });
});

describe('registeredWriteTools — gate (b) of D5, in isolation', () => {
  it('returns WRITE_TOOLS unchanged when writesEnabled is true', () => {
    expect(registeredWriteTools(true)).toBe(WRITE_TOOLS);
  });

  it('returns an empty array when writesEnabled is false, regardless of WRITE_TOOLS contents', () => {
    expect(registeredWriteTools(false)).toEqual([]);
  });
});

describe('the D5 double opt-in gate, end to end through buildServer', () => {
  // Every case below composes a MOCKED /me scope list (`caps.scopes`, never
  // a real network call) with a SYNTHETIC env object fed through
  // writesEnabledFromEnv — never process.env.
  const cases: Array<{
    label: string;
    scopes: string[];
    env: NodeJS.ProcessEnv;
    expectWriteToolsRegistered: boolean;
  }> = [
    { label: 'scope present + flag on', scopes: ['write:tasks'], env: { WORKEL_ENABLE_WRITES: 'true' }, expectWriteToolsRegistered: true },
    { label: 'scope present, flag off', scopes: ['write:tasks'], env: {}, expectWriteToolsRegistered: false },
    { label: 'flag on, scope absent', scopes: [], env: { WORKEL_ENABLE_WRITES: 'true' }, expectWriteToolsRegistered: false },
    { label: 'neither scope nor flag', scopes: [], env: {}, expectWriteToolsRegistered: false },
  ];

  it.each(cases)('$label -> write tools registered: $expectWriteToolsRegistered', ({ scopes, env, expectWriteToolsRegistered }) => {
    const caps: ServerCaps = { scopes };
    const writesEnabled = writesEnabledFromEnv(env);

    const server = buildServer(fakeClient(), caps, registeredWriteTools(writesEnabled));
    const names = registeredToolNames(server);

    if (expectWriteToolsRegistered) {
      expect(names.sort()).toEqual(['workel_create_task', 'workel_update_task']);
    } else {
      expect(names).toEqual([]);
    }
  });

  it('read tools still register with the write flag off — a smuggled-in scope check on reads would fail this', () => {
    const caps: ServerCaps = { scopes: ['read:tasks', 'read:projects', 'read:members', 'read:events'] };
    const writesEnabled = writesEnabledFromEnv({}); // flag off

    const server = buildServer(fakeClient(), caps, [...READ_TOOLS, ...registeredWriteTools(writesEnabled)]);
    const names = registeredToolNames(server);

    expect(names).toContain('workel_whoami');
    expect(names).toContain('workel_list_tasks');
    expect(names).toContain('workel_get_task');
    expect(names).not.toContain('workel_create_task');
    expect(names).not.toContain('workel_update_task');
  });

  it('read tools register the same way regardless of the write flag — the flag must never gate reads', () => {
    const caps: ServerCaps = { scopes: ['read:tasks'] };

    const serverFlagOff = buildServer(fakeClient(), caps, [...READ_TOOLS, ...registeredWriteTools(false)]);
    const serverFlagOn = buildServer(fakeClient(), caps, [...READ_TOOLS, ...registeredWriteTools(true)]);

    const readToolNames = (server: McpServer) => registeredToolNames(server).filter((name) => !name.includes('create') && !name.includes('update'));

    expect(readToolNames(serverFlagOff).sort()).toEqual(readToolNames(serverFlagOn).sort());
  });

  it('with scope AND flag both present, write tools register alongside every permitted read tool', () => {
    const caps: ServerCaps = { scopes: ['write:tasks', 'read:tasks'] };
    const writesEnabled = writesEnabledFromEnv({ WORKEL_ENABLE_WRITES: 'true' });

    const server = buildServer(fakeClient(), caps, [...READ_TOOLS, ...registeredWriteTools(writesEnabled)]);
    const names = registeredToolNames(server);

    expect(names).toContain('workel_create_task');
    expect(names).toContain('workel_update_task');
    expect(names).toContain('workel_list_tasks');
    expect(names).toContain('workel_get_task');
    // read:projects/read:members/read:events were never granted — those
    // tools must still be absent even with writes fully enabled.
    expect(names).not.toContain('workel_list_projects');
    expect(names).not.toContain('workel_list_members');
    expect(names).not.toContain('workel_list_events');
  });
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createWorkspaceRegistry, type ProbedWorkspace } from './workspaces';
import { buildWorkspaceServer, WORKSPACE_ARG } from './server';
import { defineTool, type ToolFactory } from './tools/defineTool';
import type { WorkelApiClient } from './api/client';

/**
 * Multi-workspace addressing.
 *
 * A Workel API key is bound to one workspace by the API — that is the tenancy
 * boundary. Reaching several workspaces therefore means holding several keys,
 * and these pin that the client multiplexes ADDRESSING only: every call still
 * goes out on exactly one workspace-bound key, and no workspace can be reached
 * through another's key.
 */

/** A client that records which workspace it belongs to, so dispatch is observable. */
function taggedClient(tag: string): WorkelApiClient {
  return {
    get: jest.fn().mockResolvedValue({ data: { from: tag }, requestId: null }),
    post: jest.fn().mockResolvedValue({ data: { from: tag }, requestId: null }),
    patch: jest.fn().mockResolvedValue({ data: { from: tag }, requestId: null }),
  } as unknown as WorkelApiClient;
}

function probed(id: string, name: string, scopes: string[] = ['read:tasks']): ProbedWorkspace {
  return { id, name, keyName: `key-${id}`, scopes, client: taggedClient(name) };
}

/** A tool that reports which client it was built with — proves per-workspace dispatch. */
function echoTool(name = 'echo', scope: string | undefined = 'read:tasks'): ToolFactory {
  return (client) =>
    defineTool({
      name,
      description: `echoes for ${name}`,
      inputSchema: {},
      scope,
      handler: async () => {
        const res = (await client.get('/probe')) as unknown as { data: { from: string } };
        return { content: [{ type: 'text' as const, text: res.data.from }] };
      },
    });
}

function registeredTools(server: McpServer): Record<string, { handler: Function; inputSchema?: { shape?: object } }> {
  return (
    server as unknown as {
      _registeredTools: Record<string, { handler: Function; inputSchema?: { shape?: object } }>;
    }
  )._registeredTools;
}

/** The SDK stores `inputSchema` as a ZodObject, so the argument names live on `.shape`. */
function argNames(server: McpServer, tool: string): string[] {
  return Object.keys(registeredTools(server)[tool].inputSchema?.shape ?? {});
}

async function call(server: McpServer, tool: string, args: Record<string, unknown> = {}) {
  const registered = registeredTools(server)[tool];
  return (await registered.handler(args, {})) as { isError?: boolean; content: { text: string }[] };
}

describe('workspace labels', () => {
  it('uses the bare name when names are unique', () => {
    const reg = createWorkspaceRegistry([probed('1', 'Acme'), probed('2', 'Personal')]);

    expect(reg.labels).toEqual(['Acme', 'Personal']);
  });

  it('disambiguates ONLY the colliding names, leaving unique ones clean', () => {
    const reg = createWorkspaceRegistry([probed('1', 'Acme'), probed('2', 'Acme'), probed('3', 'Personal')]);

    expect(reg.labels).toEqual(['Acme (1)', 'Acme (2)', 'Personal']);
  });

  it('resolves by id as well as by label', () => {
    const reg = createWorkspaceRegistry([probed('11', 'Acme'), probed('22', 'Personal')]);

    expect(reg.resolve('22').name).toBe('Personal');
    expect(reg.resolve('Personal').id).toBe('22');
  });
});

describe('resolving a workspace', () => {
  it('defaults to the only workspace when just one is configured', () => {
    const reg = createWorkspaceRegistry([probed('1', 'Acme')]);

    expect(reg.isSingle).toBe(true);
    expect(reg.resolve(undefined).name).toBe('Acme');
  });

  it('refuses an omitted workspace when several are configured, and names the choices', () => {
    const reg = createWorkspaceRegistry([probed('1', 'Acme'), probed('2', 'Personal')]);

    expect(() => reg.resolve(undefined)).toThrow(/"Acme".*"Personal"/s);
  });

  it('refuses an unknown workspace rather than silently falling back to the first', () => {
    const reg = createWorkspaceRegistry([probed('1', 'Acme'), probed('2', 'Personal')]);

    // Silently defaulting would send a request to the wrong tenant.
    expect(() => reg.resolve('Nonexistent')).toThrow(/Unknown workspace "Nonexistent"/);
  });
});

describe('tool registration across workspaces', () => {
  it('registers one tool per name regardless of workspace count', () => {
    const reg = createWorkspaceRegistry([probed('1', 'Acme'), probed('2', 'Personal'), probed('3', 'Third')]);
    const server = buildWorkspaceServer(reg, [echoTool('a'), echoTool('b')]);

    // The whole point: 2 tools stay 2 tools at 3 workspaces, not 6.
    expect(Object.keys(registeredTools(server)).sort()).toEqual(['a', 'b']);
  });

  it('adds the workspace argument only when there is a choice to make', () => {
    const single = buildWorkspaceServer(createWorkspaceRegistry([probed('1', 'Acme')]), [echoTool()]);
    const multi = buildWorkspaceServer(
      createWorkspaceRegistry([probed('1', 'Acme'), probed('2', 'Personal')]),
      [echoTool()]
    );

    expect(argNames(single, 'echo')).not.toContain(WORKSPACE_ARG);
    expect(argNames(multi, 'echo')).toContain(WORKSPACE_ARG);
  });

  it('registers a tool when ANY key carries its scope', () => {
    const reg = createWorkspaceRegistry([
      probed('1', 'Acme', ['read:tasks']),
      probed('2', 'Personal', []), // no scopes at all
    ]);
    const server = buildWorkspaceServer(reg, [echoTool()]);

    // Withholding it entirely would hide the tool from Acme, which can use it.
    expect(Object.keys(registeredTools(server))).toContain('echo');
  });

  it('registers nothing when no key carries the scope', () => {
    const reg = createWorkspaceRegistry([probed('1', 'Acme', []), probed('2', 'Personal', [])]);
    const server = buildWorkspaceServer(reg, [echoTool()]);

    expect(Object.keys(registeredTools(server))).toEqual([]);
  });
});

describe('dispatch goes to the addressed workspace, and only there', () => {
  const reg = () => createWorkspaceRegistry([probed('1', 'Acme'), probed('2', 'Personal')]);

  it('routes the call to the named workspace client', async () => {
    const server = buildWorkspaceServer(reg(), [echoTool()]);

    const acme = await call(server, 'echo', { [WORKSPACE_ARG]: 'Acme' });
    const personal = await call(server, 'echo', { [WORKSPACE_ARG]: 'Personal' });

    expect(acme.content[0].text).toBe('Acme');
    expect(personal.content[0].text).toBe('Personal');
  });

  it('never sends the addressing argument on to the tool handler', async () => {
    const seen: Record<string, unknown>[] = [];
    const spy: ToolFactory = () =>
      defineTool({
        name: 'spy',
        description: 'records its args',
        inputSchema: {},
        scope: 'read:tasks',
        handler: async (args) => {
          seen.push(args);
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
      });

    const server = buildWorkspaceServer(reg(), [spy]);
    await call(server, 'spy', { [WORKSPACE_ARG]: 'Acme', limit: 5 });

    expect(seen[0]).toEqual({ limit: 5 });
    expect(seen[0]).not.toHaveProperty(WORKSPACE_ARG);
  });

  it('refuses a workspace whose own key lacks the scope, naming both', async () => {
    const mixed = createWorkspaceRegistry([
      probed('1', 'Acme', ['read:tasks']),
      probed('2', 'Personal', []),
    ]);
    const server = buildWorkspaceServer(mixed, [echoTool()]);

    const result = await call(server, 'echo', { [WORKSPACE_ARG]: 'Personal' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Personal');
    expect(result.content[0].text).toContain('read:tasks');
  });

  it('still serves the workspace that DOES have the scope', async () => {
    const mixed = createWorkspaceRegistry([
      probed('1', 'Acme', ['read:tasks']),
      probed('2', 'Personal', []),
    ]);
    const server = buildWorkspaceServer(mixed, [echoTool()]);

    const result = await call(server, 'echo', { [WORKSPACE_ARG]: 'Acme' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Acme');
  });

  it('returns an actionable error rather than throwing when the workspace is unknown', async () => {
    const server = buildWorkspaceServer(reg(), [echoTool()]);

    const result = await call(server, 'echo', { [WORKSPACE_ARG]: 'Nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown workspace');
  });

  it('a single-workspace server still works with no workspace argument at all', async () => {
    const server = buildWorkspaceServer(createWorkspaceRegistry([probed('1', 'Acme')]), [echoTool()]);

    const result = await call(server, 'echo', {});

    expect(result.content[0].text).toBe('Acme');
  });
});

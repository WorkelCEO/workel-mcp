import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer, type ServerCaps } from './server';
import { defineTool, type ToolFactory } from './tools/defineTool';
import type { WorkelApiClient } from './api/client';

// These two read the actual source off disk rather than reasoning about it —
// the two invariants they pin (no MCP-SDK dependency in defineTool.ts, no
// environment/stdio access in server.ts) are meant to hold in the file as
// written, not just in whatever this test happens to exercise at runtime.

describe('defineTool.ts has no dependency on any MCP SDK package', () => {
  it('does not reference @modelcontextprotocol anywhere in its source', () => {
    const source = fs.readFileSync(path.join(__dirname, 'tools', 'defineTool.ts'), 'utf8');

    expect(source).not.toContain('@modelcontextprotocol');
  });
});

describe('server.ts has no direct environment or stdio access', () => {
  it('does not reference process.env or process.stdout anywhere in its source', () => {
    const source = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');

    expect(source).not.toContain('process.env');
    expect(source).not.toContain('process.stdout');
  });
});

function fakeClient(): WorkelApiClient {
  return { get: jest.fn(), post: jest.fn(), patch: jest.fn() };
}

/** Reads the tool names `buildServer` actually registered, straight off the constructed server. */
function registeredToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

function makeFactory(name: string, scope?: string): ToolFactory {
  return () =>
    defineTool({
      name,
      description: `fake tool ${name}`,
      inputSchema: {},
      scope,
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
}

describe('buildServer: caps-based registration', () => {
  it('registers exactly the tools the caps permit — the scoped read tool and the unscoped tool, never the write tool the caps lack', () => {
    const readTool = makeFactory('readTool', 'read:tasks');
    const writeTool = makeFactory('writeTool', 'write:tasks');
    const unscopedTool = makeFactory('unscopedTool');
    const caps: ServerCaps = { scopes: ['read:tasks'] };

    const server = buildServer(fakeClient(), caps, [readTool, writeTool, unscopedTool]);

    expect(registeredToolNames(server).sort()).toEqual(['readTool', 'unscopedTool']);
  });

  it('registers nothing when caps carry no scopes and every tool declares one', () => {
    const readTool = makeFactory('readTool', 'read:tasks');
    const writeTool = makeFactory('writeTool', 'write:tasks');
    const caps: ServerCaps = { scopes: [] };

    const server = buildServer(fakeClient(), caps, [readTool, writeTool]);

    expect(registeredToolNames(server)).toEqual([]);
  });

  it('registers every tool when every one of them is unscoped, regardless of caps', () => {
    const toolA = makeFactory('toolA');
    const toolB = makeFactory('toolB');
    const caps: ServerCaps = { scopes: [] };

    const server = buildServer(fakeClient(), caps, [toolA, toolB]);

    expect(registeredToolNames(server).sort()).toEqual(['toolA', 'toolB']);
  });
});

describe('buildServer: transport-agnostic, build-time-inert construction', () => {
  it('accepts exactly (client, caps) — no transport argument — and returns a constructed McpServer', () => {
    const caps: ServerCaps = { scopes: [] };

    const server = buildServer(fakeClient(), caps);

    expect(server).toBeInstanceOf(McpServer);
  });

  it('never calls anything on the client while building — not for zero tools, and not for several', () => {
    const client = fakeClient();
    const caps: ServerCaps = { scopes: ['read:tasks'] };
    const tools = [makeFactory('readTool', 'read:tasks'), makeFactory('writeTool', 'write:tasks')];

    buildServer(client, caps, tools);

    expect(client.get).not.toHaveBeenCalled();
  });
});

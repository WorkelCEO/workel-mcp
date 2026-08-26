import { createRemoteHandler, type RemoteHandlerDeps, type RemoteLogger, type RemoteRequest, type RemoteResponse } from './remote';
import type { FetchLike } from './api/client';

/**
 * The hosted connector resolves one OAuth token to exactly ONE workspace, and a
 * user can connect several — each connection is a separately registered OAuth
 * client, so they coexist rather than replacing one another.
 *
 * Before this, every one of them reported the same static `workel`, leaving the
 * user with N identical entries and no way to tell which workspace a tool call
 * would reach. These pin the fix AND its cost guarantee: the naming probe runs
 * on `initialize` only, never on a tool call.
 */

const BASE_URL = 'https://api.workel.test/api/public/v1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function meResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    workspace: { id: 'ws_1', name: 'Acme Inc' },
    key: { name: 'ci-key', scopes: ['read:projects'] },
    rate_limit: { write: { limit: 60, remaining: 59 } },
    ...overrides,
  };
}

function fakeRequest(body: unknown, bearer: string): RemoteRequest {
  const text = JSON.stringify(body);
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

interface Captured {
  status?: number;
  body?: string;
}

function fakeResponse(): { res: RemoteResponse; captured: Captured } {
  const captured: Captured = {};
  return {
    captured,
    res: {
      writeHead(status) {
        captured.status = status;
      },
      end(chunk) {
        captured.body = chunk;
      },
    },
  };
}

interface LoggedCall {
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

function harness(fetchMock: jest.Mock): { deps: RemoteHandlerDeps; loggerCalls: LoggedCall[] } {
  const loggerCalls: LoggedCall[] = [];
  const record = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    loggerCalls.push({ level, message, meta });
  };
  const logger: RemoteLogger = { info: record('info'), warn: record('warn'), error: record('error') };

  return {
    loggerCalls,
    deps: {
      fetch: fetchMock as unknown as FetchLike,
      logger,
      now: () => 0,
      baseUrl: BASE_URL,
      writesEnabled: false,
    },
  };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

const TOOLS_CALL = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'workel_whoami', arguments: {} },
};

const BEARER = 'wk_test_naming_0123456789';

async function initializeWith(fetchMock: jest.Mock) {
  const { deps, loggerCalls } = harness(fetchMock);
  const handler = createRemoteHandler(deps);
  const { res, captured } = fakeResponse();
  await handler(fakeRequest(INITIALIZE, BEARER), res);
  return { captured, loggerCalls };
}

describe('serverInfo.name is personalised per workspace', () => {
  it('reports the workspace name on initialize', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponse()));

    const { captured } = await initializeWith(fetchMock);

    expect(captured.status).toBe(200);
    expect(captured.body).toContain('workel — Acme Inc');
  });

  it('does NOT probe /me for a tools/call — the cost is per session, not per call', async () => {
    // This is why computeCaps deliberately avoids probing /me: a naming round
    // trip on every tool call would be a permanent latency tax for a label
    // nothing reads after the handshake.
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponse()));
    const { deps } = harness(fetchMock);
    const handler = createRemoteHandler(deps);
    const { res } = fakeResponse();

    await handler(fakeRequest(TOOLS_CALL, BEARER), res);

    // whoami itself hits /me exactly once. A naming probe would make it two.
    const meCalls = fetchMock.mock.calls.filter(([url]: [unknown]) => String(url).endsWith('/me'));
    expect(meCalls).toHaveLength(1);
  });

  it('still serves initialize when /me fails — the name is cosmetic, the session is not', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(500, { error: { code: 'server_error' } }));

    const { captured } = await initializeWith(fetchMock);

    expect(captured.status).toBe(200);
    expect(captured.body).toContain('"serverInfo"');
    expect(captured.body).not.toContain('—');
  });

  it('never puts the bearer in the log line when the probe fails', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('boom'));

    const { loggerCalls } = await initializeWith(fetchMock);

    expect(JSON.stringify(loggerCalls)).not.toContain(BEARER);
  });

  it('strips control characters from a workspace name before it reaches the protocol', async () => {
    // Workspace names are user-supplied. A newline or escape sequence in a
    // protocol field can break framing or reach a terminal client verbatim.
    const hostile = 'Ac\nme\u001B[31m Inc';
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, meResponse({ workspace: { id: 'ws_1', name: hostile } }))
    );

    const { captured } = await initializeWith(fetchMock);

    expect(captured.body).not.toContain('\u001B');
    expect(captured.body).toMatch(/workel — Ac me/);
  });

  it('caps an absurdly long workspace name', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, meResponse({ workspace: { id: 'ws_1', name: 'W'.repeat(300) } }))
    );

    const { captured } = await initializeWith(fetchMock);

    const match = /"name":"(workel \\u2014 [^"]*)"/.exec(captured.body ?? '')
      ?? /"name":"(workel — [^"]*)"/.exec(captured.body ?? '');
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').length).toBeLessThan(80);
  });

  it('falls back to the plain name when the workspace has no usable name', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, meResponse({ workspace: { id: 'ws_1', name: '   ' } }))
    );

    const { captured } = await initializeWith(fetchMock);

    expect(captured.status).toBe(200);
    expect(captured.body).not.toContain('—');
  });
});

import {
  createRemoteHandler,
  REQUESTS_ALLOWED_PER_WINDOW,
  type RemoteHandlerDeps,
  type RemoteLogger,
  type RemoteRequest,
  type RemoteResponse,
} from './remote';
import type { FetchLike } from './api/client';

// No real network anywhere in this file — `fetch` is always a jest mock
// resolving a hand-built `Response` (the same technique `boot.test.ts` and
// `createTask.test.ts` use), and `req`/`res` are plain in-process objects:
// `req` is whatever `RemoteRequest` requires (method/headers, plus async
// iteration for the body) with no real Node stream or socket behind it, and
// `res` just records whatever `writeHead`/`end` were called with. No test
// here opens a listening socket — `createRemoteHandler`'s returned function
// is called directly.

const BASE_URL = 'https://api.test/api/public/v1';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * A single-resource response: the record wrapped in the `{data: ...}` envelope
 * a Laravel API Resource always emits. `meResponse` is deliberately NOT wrapped
 * — `/me` is a plain JSON response, not a Resource, and is the one endpoint on
 * this surface that returns its body bare.
 */
function itemResponse(status: number, record: unknown, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { data: record }, headers);
}

function fakeRequest(opts: { method?: string; headers?: Record<string, string>; body?: unknown; url?: string } = {}): RemoteRequest {
  const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body);
  return {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
    url: opts.url,
    async *[Symbol.asyncIterator]() {
      if (bodyText.length > 0) yield Buffer.from(bodyText);
    },
  };
}

interface Captured {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function fakeResponse(): { res: RemoteResponse; captured: Captured } {
  const captured: Captured = {};
  const res: RemoteResponse = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(chunk) {
      captured.body = chunk;
    },
  };
  return { res, captured };
}

interface LoggedCall {
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

interface Harness {
  deps: RemoteHandlerDeps;
  fetchMock: jest.Mock;
  loggerCalls: LoggedCall[];
}

/**
 * `overrides` is spread onto the base deps LAST — omitting a key (most
 * importantly `allowedOrigins`) leaves it genuinely absent rather than
 * silently defaulted here, so a test can exercise `createRemoteHandler`'s
 * OWN default (`[]`) rather than one this harness would otherwise impose.
 */
function makeHarness(overrides: Partial<RemoteHandlerDeps> = {}, fetchMock: jest.Mock = jest.fn()): Harness {
  const loggerCalls: LoggedCall[] = [];
  const record = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    loggerCalls.push({ level, message, meta });
  };
  const logger: RemoteLogger = { info: record('info'), warn: record('warn'), error: record('error') };

  const deps: RemoteHandlerDeps = {
    fetch: fetchMock as unknown as FetchLike,
    logger,
    now: () => 0,
    baseUrl: BASE_URL,
    writesEnabled: false,
    ...overrides,
  };

  return { deps, fetchMock, loggerCalls };
}

function toolsCallBody(name: string, args: Record<string, unknown> = {}, id: string | number = 1): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function headerKeysLower(captured: Captured): string[] {
  return Object.keys(captured.headers ?? {}).map((key) => key.toLowerCase());
}

function meResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    workspace: { id: 'ws_1', name: 'Acme Inc' },
    key: { name: 'ci-key', scopes: ['read:projects'] },
    rate_limit: { write: { limit: 60, remaining: 59 } },
    ...overrides,
  };
}

function wireTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't_1',
    title: 'Ship it',
    description: null,
    project_id: 'p_1',
    card: { id: 'c_1', name: 'To Do', is_done: false },
    priority: null,
    due_date: null,
    due_time: null,
    progress: null,
    completed: false,
    assignee_ids: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe('createRemoteHandler: auth', () => {
  it('rejects a POST with no Authorization header — 401, a BARE WWW-Authenticate: Bearer with no OAuth metadata, no upstream fetch', async () => {
    const { deps, fetchMock } = makeHarness();
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ body: toolsCallBody('workel_whoami') });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(401);
    // Bare — exactly "Bearer", nothing else. A challenge carrying
    // `resource_metadata` (RFC 9728) is known to make some real clients
    // ignore this server's static bearer entirely (docs/MCP_SERVER_PLAN.md, D10).
    expect(captured.headers?.['WWW-Authenticate']).toBe('Bearer');
    expect(captured.headers?.['WWW-Authenticate']).not.toContain('resource_metadata');
    expect(captured.headers?.['WWW-Authenticate']).not.toContain('realm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a bearer not shaped like wk_... — 401, and crucially zero upstream fetch calls', async () => {
    const { deps, fetchMock } = makeHarness();
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ headers: { authorization: 'Bearer abc123' }, body: toolsCallBody('workel_whoami') });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(401);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe('createRemoteHandler: OAuth mode', () => {
  const METADATA_URL = 'https://auth.workel.test/.well-known/oauth-protected-resource';

  it('advertises resource_metadata on the 401 so Claude can discover the authorization server', async () => {
    const { deps, fetchMock } = makeHarness({ protectedResourceMetadataUrl: METADATA_URL });
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ body: toolsCallBody('workel_whoami') });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    // This exact header is the entire discovery handshake. Anthropic honours
    // it only on a 401, and without it the connection dies as an unexplained
    // "couldn't reach the MCP server".
    expect(captured.status).toBe(401);
    expect(captured.headers?.['WWW-Authenticate']).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    // Still no upstream call for an unauthenticated request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a non-wk_ bearer, because an OAuth access token is not wk_-shaped', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(meResponse()), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const { deps } = makeHarness({ protectedResourceMetadataUrl: METADATA_URL }, fetchMock);
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({
      headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.oauth-style-token' },
      body: toolsCallBody('workel_whoami'),
    });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    // The prefix test was only ever a shape check; the upstream API is the
    // real boundary, so in OAuth mode the token must actually reach it.
    expect(captured.status).not.toBe(401);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('still rejects a missing bearer in OAuth mode', async () => {
    // Counterweight: lifting the prefix filter must not turn the endpoint
    // authless.
    const { deps, fetchMock } = makeHarness({ protectedResourceMetadataUrl: METADATA_URL });
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ headers: { authorization: 'Bearer ' }, body: toolsCallBody('workel_whoami') });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createRemoteHandler: Origin', () => {
  it('rejects a present, disallowed Origin — 403, zero fetch calls — before auth is ever inspected', async () => {
    const { deps, fetchMock } = makeHarness({ allowedOrigins: ['https://allowed.example'] });
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({
      headers: { origin: 'https://evil.example', authorization: 'Bearer wk_test_origin_reject' },
      body: toolsCallBody('workel_whoami'),
    });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults allowedOrigins to [] when omitted — a present Origin is still rejected with no allowlist configured', async () => {
    const { deps, fetchMock } = makeHarness(); // allowedOrigins deliberately omitted
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({
      headers: { origin: 'https://anything.example', authorization: 'Bearer wk_test_default_origin' },
      body: toolsCallBody('workel_whoami'),
    });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OVER-REACH GUARD: a valid wk_ request with NO Origin header at all still succeeds — fails if Origin is wrongly made mandatory', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponse()));
    const { deps } = makeHarness({ allowedOrigins: [] }, fetchMock); // deliberately empty allowlist
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ headers: { authorization: 'Bearer wk_test_noorigin' }, body: toolsCallBody('workel_whoami') });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createRemoteHandler: method', () => {
  it('rejects GET with 405 + Allow: POST — no SSE, no session, zero fetch calls', async () => {
    const { deps, fetchMock } = makeHarness();
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ method: 'GET' });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(405);
    expect(captured.headers?.Allow).toBe('POST');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(headerKeysLower(captured)).not.toContain('mcp-session-id');
  });

  it('rejects DELETE with 405 + Allow: POST, zero fetch calls', async () => {
    const { deps, fetchMock } = makeHarness();
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ method: 'DELETE' });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(405);
    expect(captured.headers?.Allow).toBe('POST');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createRemoteHandler: per-request client construction', () => {
  it('constructs a fresh client per request — the SECOND request\'s upstream call carries the SECOND bearer, never a cached first one', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, meResponse({ workspace: { id: 'ws_1', name: 'First' } })))
      .mockResolvedValueOnce(jsonResponse(200, meResponse({ workspace: { id: 'ws_2', name: 'Second' } })));
    const { deps } = makeHarness({}, fetchMock);
    const handler = createRemoteHandler(deps);

    const req1 = fakeRequest({ headers: { authorization: 'Bearer wk_test_first_bearer' }, body: toolsCallBody('workel_whoami') });
    const { res: res1, captured: captured1 } = fakeResponse();
    await handler(req1, res1);

    const req2 = fakeRequest({ headers: { authorization: 'Bearer wk_test_second_bearer' }, body: toolsCallBody('workel_whoami') });
    const { res: res2, captured: captured2 } = fakeResponse();
    await handler(req2, res2);

    expect(captured1.status).toBe(200);
    expect(captured2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((firstInit.headers as Record<string, string>).Authorization).toBe('Bearer wk_test_first_bearer');
    expect((secondInit.headers as Record<string, string>).Authorization).toBe('Bearer wk_test_second_bearer');
  });
});

describe('createRemoteHandler: throttle', () => {
  it('never logs, or keys the throttle bucket on, a substring of the raw bearer', async () => {
    const rawBearer = 'wk_test_super_secret_value_should_never_leak';
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponse()));
    const { deps, loggerCalls } = makeHarness({}, fetchMock);
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ headers: { authorization: `Bearer ${rawBearer}` }, body: toolsCallBody('workel_whoami') });
    const { res } = fakeResponse();

    await handler(req, res);

    expect(loggerCalls.length).toBeGreaterThan(0);
    const serializedLogs = JSON.stringify(loggerCalls);
    expect(serializedLogs).not.toContain(rawBearer);
  });

  it('OVER-REACH GUARD: a second request on the SAME bearer, well under the window, still succeeds — fails if the limiter is too aggressive', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponse()));
    const { deps } = makeHarness({ now: () => 1_000 }, fetchMock);
    const handler = createRemoteHandler(deps);
    const authorization = 'Bearer wk_test_repeat_under_limit';

    for (let i = 0; i < 2; i++) {
      const req = fakeRequest({ headers: { authorization }, body: toolsCallBody('workel_whoami') });
      const { res, captured } = fakeResponse();
      await handler(req, res);
      expect(captured.status).toBe(200);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a bearer once it exceeds its per-window request cap — 429 with Retry-After, and stops dispatching upstream', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponse()));
    const { deps } = makeHarness({ now: () => 5_000 }, fetchMock);
    const handler = createRemoteHandler(deps);
    const authorization = 'Bearer wk_test_throttle_over_limit';

    // One request beyond the window cap so the last iteration is the first
    // rejected one.
    const requestCount = REQUESTS_ALLOWED_PER_WINDOW + 1;
    let last: Captured = {};
    for (let i = 0; i < requestCount; i++) {
      const req = fakeRequest({ headers: { authorization }, body: toolsCallBody('workel_whoami') });
      const { res, captured } = fakeResponse();
      await handler(req, res);
      last = captured;
    }

    expect(last.status).toBe(429);
    expect(last.headers?.['Retry-After']).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(REQUESTS_ALLOWED_PER_WINDOW);
  });
});

describe('createRemoteHandler: end-to-end tool dispatch (mirrors server.test.ts over stdio)', () => {
  it('dispatches a READ tool (workel_whoami) through the full HTTP pipeline, and no response ever carries Mcp-Session-Id', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meResponse()));
    const { deps } = makeHarness({}, fetchMock);
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({
      headers: { authorization: 'Bearer wk_test_whoami_dispatch' },
      body: toolsCallBody('workel_whoami', {}, 'req-1'),
    });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(200);
    expect(headerKeysLower(captured)).not.toContain('mcp-session-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/me`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer wk_test_whoami_dispatch');

    const body = JSON.parse(captured.body ?? '{}') as { id: unknown; result?: { isError?: boolean; content: { type: string; text: string }[] } };
    expect(body.id).toBe('req-1');
    expect(body.result?.isError).toBeFalsy();
    const parsed = JSON.parse(body.result?.content[0].text ?? '{}') as { workspace: { name: string } };
    expect(parsed.workspace.name).toBe('Acme Inc');
  });

  it('a WRITE tool (workel_create_task) is not registered — and never dispatched to upstream — when writesEnabled is false', async () => {
    const fetchMock = jest.fn();
    const { deps } = makeHarness({ writesEnabled: false }, fetchMock);
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({
      headers: { authorization: 'Bearer wk_test_writegate_off' },
      body: toolsCallBody('workel_create_task', { title: 'Ship it', project_id: 'p_1' }, 'req-2'),
    });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    // A missing tool is reported as a `CallToolResult` with `isError: true`
    // (the MCP SDK's own `registerTool` dispatcher catches "Tool ... not
    // found" and every other non-elicitation error into the tool result,
    // never a top-level JSON-RPC error — `server/mcp.js`'s
    // `CallToolRequestSchema` handler) — an HTTP-level 200, not a rejection:
    // this request passed auth/origin/throttle fine, and the tool simply
    // isn't registered because gate (b) excluded it.
    expect(captured.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    const body = JSON.parse(captured.body ?? '{}') as { result?: { isError?: boolean; content: { type: string; text: string }[] } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0].text).toContain('not found');
  });

  it('a gated WRITE tool (workel_create_task) dispatches end-to-end when writesEnabled is true — same success shape as buildServer over stdio', async () => {
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireTask()));
    const { deps } = makeHarness({ writesEnabled: true }, fetchMock);
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({
      headers: { authorization: 'Bearer wk_test_writegate_on' },
      body: toolsCallBody('workel_create_task', { title: 'Ship it', project_id: 'p_1' }, 'req-3'),
    });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(200);
    expect(headerKeysLower(captured)).not.toContain('mcp-session-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/tasks`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer wk_test_writegate_on');

    const body = JSON.parse(captured.body ?? '{}') as { result?: { isError?: boolean; content: { type: string; text: string }[] } };
    expect(body.result?.isError).toBeFalsy();
    const parsed = JSON.parse(body.result?.content[0].text ?? '{}') as { title: string; replayed: boolean };
    expect(parsed.title).toBe('Ship it');
    expect(parsed.replayed).toBe(false);
  });
});

describe('createRemoteHandler: liveness probe', () => {
  it('answers GET /health with 200 and no auth, so App Service does not restart the container', async () => {
    const { deps, fetchMock } = makeHarness();
    const handler = createRemoteHandler(deps);
    // No Authorization header at all — a platform probe never carries one.
    const req = fakeRequest({ method: 'GET', url: '/health' });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ status: 'ok' });
    // The probe must never reach upstream.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tolerates a query string on the probe path', async () => {
    const { deps } = makeHarness();
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ method: 'GET', url: '/health?probe=1' });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(200);
  });

  it('does not turn every GET into a health response', async () => {
    // Counterweight: the probe is one exact path, not a blanket GET handler.
    const { deps } = makeHarness();
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ method: 'GET', url: '/mcp' });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    expect(captured.status).toBe(405);
  });

  it('does not expose the probe over POST, which is the protocol path', async () => {
    const { deps } = makeHarness();
    const handler = createRemoteHandler(deps);
    const req = fakeRequest({ method: 'POST', url: '/health', body: toolsCallBody('workel_whoami') });
    const { res, captured } = fakeResponse();

    await handler(req, res);

    // Falls through to the normal pipeline, so it still requires auth.
    expect(captured.status).toBe(401);
  });
});

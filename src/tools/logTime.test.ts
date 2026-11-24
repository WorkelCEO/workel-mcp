import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { buildServer, type ServerCaps } from '../server';
import { workelLogTime } from './logTime';

const BASE_URL = 'https://api.test/api/public/v1';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A created record arrives wrapped in `{data: ...}`, as every Laravel Resource is. */
function itemResponse(status: number, record: unknown, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { data: record }, headers);
}

function makeClient(fetchMock: jest.Mock) {
  return createWorkelApiClient({
    baseUrl: BASE_URL,
    apiKey: 'wk_test_key',
    fetch: fetchMock as unknown as FetchLike,
    sleep: jest.fn() as unknown as SleepLike,
  });
}

function lastRequest(fetchMock: jest.Mock): { url: URL; init: RequestInit } {
  const calls = fetchMock.mock.calls as [string, RequestInit][];
  const [url, init] = calls[calls.length - 1];
  return { url: new URL(url), init };
}

function requestedBody(fetchMock: jest.Mock): Record<string, unknown> {
  return JSON.parse(lastRequest(fetchMock).init.body as string);
}

function registeredToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

function wireEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'te_9',
    task_id: 't_1',
    project_id: 'p_1',
    user: { id: 'u_1', name: 'Ada' },
    started_at: '2026-11-24T09:00:00+00:00',
    ended_at: '2026-11-24T09:45:00+00:00',
    duration_seconds: 2700,
    running: false,
    billable: false,
    note: null,
    source: 'manual',
    created_at: '2026-11-24T09:45:00+00:00',
    updated_at: '2026-11-24T09:45:00+00:00',
    ...overrides,
  };
}

describe('workel_log_time', () => {
  it('requires the write:time scope, not write:tasks', () => {
    expect(workelLogTime(makeClient(jest.fn())).scope).toBe('write:time');
  });

  it('is an honest create: not read-only, not destructive, not idempotent, not open-world', () => {
    expect(workelLogTime(makeClient(jest.fn())).annotations).toEqual({
      title: 'Log time',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('POSTs /time-entries with the minutes sent as duration_seconds, and nothing it was not given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEntry()));
    const descriptor = workelLogTime(makeClient(fetchMock));

    await descriptor.handler({ task_id: 't_1', duration_minutes: 45 });

    const { url, init } = lastRequest(fetchMock);
    expect(url.pathname).toBe('/api/public/v1/time-entries');
    expect(init.method).toBe('POST');
    expect(requestedBody(fetchMock)).toEqual({ task_id: 't_1', duration_seconds: 2700 });
  });

  it('sends started_at, note and billable when given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEntry()));
    const descriptor = workelLogTime(makeClient(fetchMock));

    await descriptor.handler({
      task_id: 't_1',
      duration_minutes: 90,
      started_at: '2026-11-24T08:00:00Z',
      note: 'Client call',
      billable: true,
    });

    expect(requestedBody(fetchMock)).toEqual({
      task_id: 't_1',
      duration_seconds: 5400,
      started_at: '2026-11-24T08:00:00Z',
      note: 'Client call',
      billable: true,
    });
  });

  it('keeps idempotency_key (and any forced extra key) off the wire body, and sends it as the header', async () => {
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEntry()));
    const descriptor = workelLogTime(makeClient(fetchMock));

    await descriptor.handler({ task_id: 't_1', duration_minutes: 5, idempotency_key: 'k-1', user_id: 'u_other' });

    const body = requestedBody(fetchMock);
    expect(body).toEqual({ task_id: 't_1', duration_seconds: 300 });
    const headers = lastRequest(fetchMock).init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('k-1');
  });

  it('rejects a zero, negative or fractional duration at the schema', () => {
    const schema = z.object(workelLogTime(makeClient(jest.fn())).inputSchema);

    expect(schema.safeParse({ task_id: 't_1', duration_minutes: 0 }).success).toBe(false);
    expect(schema.safeParse({ task_id: 't_1', duration_minutes: -5 }).success).toBe(false);
    expect(schema.safeParse({ task_id: 't_1', duration_minutes: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ task_id: 't_1', duration_minutes: 30 }).success).toBe(true);
  });

  it('maps the created entry and reports replayed', async () => {
    const fresh = jest.fn().mockResolvedValue(itemResponse(201, wireEntry()));
    const fromFresh = JSON.parse((await workelLogTime(makeClient(fresh)).handler({ task_id: 't_1', duration_minutes: 45 })).content[0].text);
    expect(fromFresh.id).toBe('te_9');
    expect(fromFresh.duration_seconds).toBe(2700);
    expect(fromFresh.user).toEqual({ id: 'u_1', name: 'Ada' });
    expect(fromFresh.replayed).toBe(false);

    const replay = jest.fn().mockResolvedValue(itemResponse(201, wireEntry(), { 'Idempotent-Replay': 'true' }));
    const fromReplay = JSON.parse(
      (await workelLogTime(makeClient(replay)).handler({ task_id: 't_1', duration_minutes: 45, idempotency_key: 'k-1' })).content[0].text
    );
    expect(fromReplay.replayed).toBe(true);
  });

  describe('scope gate', () => {
    it('registers when the caller holds write:time', () => {
      const caps: ServerCaps = { scopes: ['write:time'] };
      expect(registeredToolNames(buildServer(makeClient(jest.fn()), caps, [workelLogTime]))).toEqual(['workel_log_time']);
    });

    it('does NOT register for a key with write:tasks but not write:time', () => {
      const caps: ServerCaps = { scopes: ['write:tasks', 'read:time'] };
      expect(registeredToolNames(buildServer(makeClient(jest.fn()), caps, [workelLogTime]))).toEqual([]);
    });
  });
});

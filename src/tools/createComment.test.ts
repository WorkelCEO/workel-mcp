import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { buildServer, type ServerCaps } from '../server';
import { workelCreateTaskComment } from './createComment';

const BASE_URL = 'https://api.test/api/public/v1';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const payload = body === null ? null : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

/**
 * A single-resource response: the record wrapped in the `{data: ...}` envelope
 * a Laravel API Resource always emits. Mocking the bare record here instead is
 * what let the envelope bug ship — the fixtures asserted a shape the API never
 * sends, so the suite stayed green while `result.data` handed the mapper the
 * wrapper. Use this for every show/create/update response; `jsonResponse` stays
 * for list pages (which carry their own `{data, meta}`) and for error bodies.
 */
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

/** Reads the request URL/method from the (single, most recent) fetch call. */
function lastRequest(fetchMock: jest.Mock): { url: URL; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalled();
  const calls = fetchMock.mock.calls as [string, RequestInit][];
  const [url, init] = calls[calls.length - 1];
  return { url: new URL(url), init };
}

/** Parses the JSON body actually sent to fetch on the most recent call. */
function requestedBody(fetchMock: jest.Mock): Record<string, unknown> {
  const { init } = lastRequest(fetchMock);
  return JSON.parse(init.body as string);
}

function wireComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tc_1',
    body: 'Looks good to me.',
    author: { id: 'u_1', name: 'Ada' },
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Reads the tool names `buildServer` actually registered, straight off the constructed server. */
function registeredToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

describe('workel_create_task_comment', () => {
  it('requires the write:comments scope', () => {
    const descriptor = workelCreateTaskComment(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('write:comments');
  });

  it('sets destructiveHint/idempotentHint honestly for a create: never destructive, never idempotent, never open-world', () => {
    const descriptor = workelCreateTaskComment(makeClient(jest.fn()));

    expect(descriptor.annotations).toEqual({
      title: 'Create task comment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('does not declare a fake-safety confirm input parameter', () => {
    const descriptor = workelCreateTaskComment(makeClient(jest.fn()));

    expect(Object.prototype.hasOwnProperty.call(descriptor.inputSchema, 'confirm')).toBe(false);
  });

  describe('mention_user_ids never reaches the wire', () => {
    it('the wire body key set carries no key matching /mention/i for an ordinary call', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireComment({})));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', body: 'A plain comment.' });

      const body = requestedBody(fetchMock);
      const mentionKeys = Object.keys(body).filter((key) => /mention/i.test(key));
      expect(mentionKeys).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still carries no mention-shaped key when the caller forces mention_user_ids onto the args object', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireComment({})));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      // T10's write-tool schemas are plain `z.object(...)` (no `.strict()`)
      // — the real MCP SDK path strips an unrecognized key like this
      // silently rather than rejecting the call outright. Calling the
      // handler directly (bypassing that SDK-level parse, matching every
      // other direct-handler-call test in this file) proves the SAME
      // guarantee holds even earlier: this tool's own handler builds the
      // wire body by naming `body` explicitly, so the extra key is dropped
      // regardless of whether SDK-level stripping ever runs at all.
      await descriptor.handler({
        id: 't_1',
        body: 'A plain comment.',
        mention_user_ids: ['u_outsider'],
      });

      const body = requestedBody(fetchMock);
      const mentionKeys = Object.keys(body).filter((key) => /mention/i.test(key));
      expect(mentionKeys).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('wire mapping', () => {
    it('requests POST /tasks/{id}/comments', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireComment({})));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_42', body: 'hello' });

      const { url, init } = lastRequest(fetchMock);
      expect(url.pathname).toBe('/api/public/v1/tasks/t_42/comments');
      expect(init.method).toBe('POST');
    });

    it('URL-encodes the task id into the path', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireComment({})));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      await descriptor.handler({ id: 't/weird id', body: 'hello' });

      const { url } = lastRequest(fetchMock);
      expect(url.pathname).toBe('/api/public/v1/tasks/t%2Fweird%20id/comments');
    });

    it('sends body unrenamed and nothing else', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireComment({})));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', body: 'Ship it.' });

      const body = requestedBody(fetchMock);
      expect(body).toEqual({ body: 'Ship it.' });
    });

    it('never sends idempotency_key onto the wire body itself', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireComment({})));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', body: 'hi', idempotency_key: 'caller-key-1' });

      const body = requestedBody(fetchMock);
      expect(Object.prototype.hasOwnProperty.call(body, 'idempotency_key')).toBe(false);
    });

    it('forwards a caller-supplied idempotency_key verbatim as the Idempotency-Key header', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireComment({})));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', body: 'hi', idempotency_key: 'caller-key-1' });

      const { init } = lastRequest(fetchMock);
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('caller-key-1');
    });
  });

  describe('response mapping', () => {
    it('maps the created comment and reports replayed: false for a fresh create', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        itemResponse(201, wireComment({ id: 'tc_9', body: 'Ship it.', author: { id: 'u_2', name: 'Grace' } }))
      );
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      const result = await descriptor.handler({ id: 't_1', body: 'Ship it.' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.id).toBe('tc_9');
      expect(parsed.body).toBe('Ship it.');
      expect(parsed.author).toEqual({ id: 'u_2', name: 'Grace' });
      expect(parsed.replayed).toBe(false);
    });

    it('reports replayed: true when the server marks the response as an idempotency replay', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(itemResponse(201, wireComment({}), { 'Idempotent-Replay': 'true' }));
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      const result = await descriptor.handler({ id: 't_1', body: 'hi', idempotency_key: 'caller-key-1' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.replayed).toBe(true);
    });
  });

  describe('nothing else is pre-validated — server-side rejections pass straight through', () => {
    it('forwards a not-visible task id to the wire and surfaces the mapped not_found error', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { type: 'invalid_request_error', code: 'not_found', message: 'irrelevant', request_id: null },
        })
      );
      const descriptor = workelCreateTaskComment(makeClient(fetchMock));

      await expect(descriptor.handler({ id: 't_missing', body: 'hi' })).rejects.toThrow(
        /No matching resource was found/
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('description states the ids Public API surface prohibits mentions and points at the untrusted-content note', () => {
    const descriptor = workelCreateTaskComment(makeClient(jest.fn()));

    expect(descriptor.description).toContain('REJECTS the whole request');
    expect(descriptor.description).toMatch(/mention/i);
  });

  describe('D5 gate — scoped to write:comments, not write:tasks', () => {
    it('registers when the caller holds write:comments', () => {
      const caps: ServerCaps = { scopes: ['write:comments'] };
      const server = buildServer(makeClient(jest.fn()), caps, [workelCreateTaskComment]);

      expect(registeredToolNames(server)).toEqual(['workel_create_task_comment']);
    });

    it('does NOT register when the caller holds write:tasks but not write:comments', () => {
      const caps: ServerCaps = { scopes: ['write:tasks'] };
      const server = buildServer(makeClient(jest.fn()), caps, [workelCreateTaskComment]);

      expect(registeredToolNames(server)).toEqual([]);
    });
  });
});

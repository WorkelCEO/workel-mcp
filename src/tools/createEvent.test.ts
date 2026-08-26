import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { buildServer, type ServerCaps } from '../server';
import { READ_TOOLS } from './index';
import { WRITE_TOOLS } from './registration';
import { workelCreateEvent } from './createEvent';

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

/** Reads the tool names `buildServer` actually registered, straight off the constructed server. */
function registeredToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

function wireEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e_1',
    title: 'Standup',
    description: null,
    date: '2026-06-01',
    start_time: '09:00',
    end_time: '09:15',
    location: null,
    project_id: null,
    workspace_id: 'ws_1',
    color: null,
    repeat: 'none',
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

const REQUIRED_FIELDS = {
  title: 'Standup',
  date: '2026-06-01',
  start_time: '09:00',
  end_time: '09:15',
};

/** Parses `raw` through the descriptor's own inputSchema, exactly like the real MCP SDK does before invoking a handler (see workel_events.test.ts for the sibling read-tool precedent this mirrors for a defaulted field). */
function parseArgs(descriptor: { inputSchema: Record<string, z.ZodTypeAny> }, raw: Record<string, unknown>) {
  return z.object(descriptor.inputSchema).parse(raw);
}

describe('workel_create_event', () => {
  it('requires the write:events scope', () => {
    const descriptor = workelCreateEvent(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('write:events');
  });

  it('sets destructiveHint/idempotentHint honestly for a create: never destructive, never idempotent, never open-world', () => {
    const descriptor = workelCreateEvent(makeClient(jest.fn()));

    expect(descriptor.annotations).toEqual({
      title: 'Create event',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('does not declare a fake-safety confirm input parameter', () => {
    const descriptor = workelCreateEvent(makeClient(jest.fn()));

    expect(Object.prototype.hasOwnProperty.call(descriptor.inputSchema, 'confirm')).toBe(false);
  });

  describe('repeat defaulting and the repeat_interval cross-field rejection', () => {
    it('defaults repeat to "none" on the wire when omitted entirely', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({})));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS });
      await descriptor.handler(parsed);

      const body = requestedBody(fetchMock);
      expect(body.repeat).toBe('none');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects repeat: "weekly" with no repeat_interval — zero fetch calls', async () => {
      const fetchMock = jest.fn();
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, repeat: 'weekly' });
      const result = await descriptor.handler(parsed);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('repeat_interval');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts repeat: "none" with no repeat_interval — fetch is called', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({})));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, repeat: 'none' });
      const result = await descriptor.handler(parsed);

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('accepts repeat: "weekly" WITH a repeat_interval — fetch is called and both fields reach the wire', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({ repeat: 'weekly' })));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, repeat: 'weekly', repeat_interval: 2 });
      const result = await descriptor.handler(parsed);

      expect(result.isError).toBeUndefined();
      const body = requestedBody(fetchMock);
      expect(body.repeat).toBe('weekly');
      expect(body.repeat_interval).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('end_time/start_time ordering is NOT pre-validated — the server rejection passes straight through', () => {
    it('sends an end_time not after start_time straight to the wire, and surfaces the mapped validation_error', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(422, {
          error: {
            type: 'invalid_request_error',
            code: 'validation_error',
            message: 'irrelevant — errors.ts must never read this field',
            request_id: 'req_1',
          },
        })
      );
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, {
        title: 'Backwards event',
        date: '2026-06-01',
        start_time: '10:00',
        end_time: '09:00',
      });

      await expect(descriptor.handler(parsed)).rejects.toThrow(/failed validation/i);

      // Exactly one call — proves this tool did NOT pre-check the
      // start_time/end_time ordering itself before going to the wire.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('wire mapping', () => {
    it('requests POST /events', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({})));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS });
      await descriptor.handler(parsed);

      const { url, init } = lastRequest(fetchMock);
      expect(url.pathname).toBe('/api/public/v1/events');
      expect(init.method).toBe('POST');
    });

    it('does not rename title (unlike a task) and maps invited_user_ids -> invited_users, dropping the tool-vocab key', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({})));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, {
        ...REQUIRED_FIELDS,
        invited_user_ids: ['u_1', 'u_2'],
      });
      await descriptor.handler(parsed);

      const body = requestedBody(fetchMock);
      expect(body.title).toBe('Standup');
      expect(Object.prototype.hasOwnProperty.call(body, 'title_text')).toBe(false);
      expect(body.invited_users).toEqual(['u_1', 'u_2']);
      expect(Object.prototype.hasOwnProperty.call(body, 'invited_user_ids')).toBe(false);
    });

    it('omits optional fields entirely when not given, rather than sending them as null/undefined', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({})));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS });
      await descriptor.handler(parsed);

      const body = requestedBody(fetchMock);
      for (const wireKey of [
        'description',
        'reminder_at',
        'timezone',
        'reminder_minutes_before',
        'repeat_interval',
        'location',
        'meet_link',
        'color',
        'order',
        'project_id',
        'invited_users',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(body, wireKey)).toBe(false);
      }
    });

    it('never sends idempotency_key onto the wire body itself', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({})));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, idempotency_key: 'caller-key-1' });
      await descriptor.handler(parsed);

      const body = requestedBody(fetchMock);
      expect(Object.prototype.hasOwnProperty.call(body, 'idempotency_key')).toBe(false);
    });

    it('forwards a caller-supplied idempotency_key verbatim as the Idempotency-Key header', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({})));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, idempotency_key: 'caller-key-1' });
      await descriptor.handler(parsed);

      const { init } = lastRequest(fetchMock);
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('caller-key-1');
    });
  });

  describe('nothing else is pre-validated — server-side rejections pass straight through', () => {
    it('forwards a project_id it cannot see and surfaces the mapped validation_error, with no visibility pre-check', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(422, {
          error: { type: 'invalid_request_error', code: 'validation_error', message: 'irrelevant', request_id: null },
        })
      );
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, project_id: 'p_foreign' });

      await expect(descriptor.handler(parsed)).rejects.toThrow(/failed validation/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('response mapping', () => {
    it('maps the created event and reports replayed: false for a fresh create', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireEvent({ id: 'e_9', title: 'Retro' })));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, title: 'Retro' });
      const result = await descriptor.handler(parsed);
      const returned = JSON.parse(result.content[0].text);

      expect(returned.id).toBe('e_9');
      expect(returned.title).toBe('Retro');
      expect(returned.replayed).toBe(false);
    });

    it('reports replayed: true when the server marks the response as an idempotency replay', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(itemResponse(201, wireEvent({}), { 'Idempotent-Replay': 'true' }));
      const descriptor = workelCreateEvent(makeClient(fetchMock));

      const parsed = parseArgs(descriptor, { ...REQUIRED_FIELDS, idempotency_key: 'caller-key-1' });
      const result = await descriptor.handler(parsed);
      const returned = JSON.parse(result.content[0].text);

      expect(returned.replayed).toBe(true);
    });
  });

  it('description names the workel_list_members verification instruction and the invited-id asymmetry', () => {
    const descriptor = workelCreateEvent(makeClient(jest.fn()));

    expect(descriptor.description).toContain('workel_list_members');
    expect(descriptor.description).toContain('silently DROPPED');
    expect(descriptor.description).toContain('422s the WHOLE request');
  });

  describe('D5 gate — scoped to write:events, not write:tasks', () => {
    it('registers when the caller holds write:events', () => {
      const caps: ServerCaps = { scopes: ['write:events'] };
      const server = buildServer(makeClient(jest.fn()), caps, [workelCreateEvent]);

      expect(registeredToolNames(server)).toEqual(['workel_create_event']);
    });

    it('does NOT register when the caller holds write:tasks but not write:events', () => {
      const caps: ServerCaps = { scopes: ['write:tasks'] };
      const server = buildServer(makeClient(jest.fn()), caps, [workelCreateEvent]);

      expect(registeredToolNames(server)).toEqual([]);
    });
  });
});

describe('the full tool registry — read + write — is exactly the planned 14 tools', () => {
  const EXPECTED_NAMES = [
    'workel_whoami',
    'workel_list_projects',
    'workel_get_project',
    'workel_list_project_columns',
    'workel_list_members',
    'workel_list_tasks',
    'workel_get_task',
    'workel_list_task_comments',
    'workel_list_task_activity',
    'workel_list_events',
    'workel_create_task',
    'workel_update_task',
    'workel_create_task_comment',
    'workel_create_event',
  ];

  it('has the exact 14 names, no more, no fewer', () => {
    const client = makeClient(jest.fn());
    const allNames = [...READ_TOOLS, ...WRITE_TOOLS].map((factory) => factory(client).name);

    expect(new Set(allNames)).toEqual(new Set(EXPECTED_NAMES));
    expect(allNames).toHaveLength(14);
  });
});

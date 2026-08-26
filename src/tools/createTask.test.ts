import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelCreateTask } from './createTask';

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

describe('workel_create_task', () => {
  it('requires the write:tasks scope', () => {
    const descriptor = workelCreateTask(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('write:tasks');
  });

  it('sets destructiveHint/idempotentHint honestly for a create: never destructive, never idempotent, never open-world', () => {
    const descriptor = workelCreateTask(makeClient(jest.fn()));

    expect(descriptor.annotations).toEqual({
      title: 'Create task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  describe('client-side rejections (zero fetch calls)', () => {
    it('rejects when both column_id and project_id are given', async () => {
      const fetchMock = jest.fn();
      const descriptor = workelCreateTask(makeClient(fetchMock));

      const result = await descriptor.handler({ title: 'x', column_id: 'c_1', project_id: 'p_1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('column_id');
      expect(result.content[0].text).toContain('project_id');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when neither column_id nor project_id is given', async () => {
      const fetchMock = jest.fn();
      const descriptor = workelCreateTask(makeClient(fetchMock));

      const result = await descriptor.handler({ title: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('column_id');
      expect(result.content[0].text).toContain('project_id');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects due_time given without due_date', async () => {
      const fetchMock = jest.fn();
      const descriptor = workelCreateTask(makeClient(fetchMock));

      const result = await descriptor.handler({ title: 'x', project_id: 'p_1', due_time: '14:30' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('due_time');
      expect(result.content[0].text).toContain('due_date');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does NOT reject due_date given without due_time (only the reverse is ambiguous)', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireTask({})));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      const result = await descriptor.handler({ title: 'x', project_id: 'p_1', due_date: '2026-06-01' });

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT reject column_id given alone, or project_id given alone', async () => {
      // A fresh Response per call — a single Response's body can only be
      // read once, and this test makes two handler calls against one mock.
      const fetchMock = jest.fn().mockImplementation(() => Promise.resolve(itemResponse(201, wireTask({}))));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await descriptor.handler({ title: 'x', column_id: 'c_1' });
      await descriptor.handler({ title: 'x', project_id: 'p_1' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('nothing else is pre-validated — server-side rejections pass straight through', () => {
    it('forwards a non-member assignee to the wire (never pre-checked) and surfaces the mapped invalid_assignee error', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(422, {
          error: {
            type: 'invalid_request_error',
            code: 'invalid_assignee',
            message: 'irrelevant — errors.ts must never read this field',
            request_id: 'req_1',
          },
        })
      );
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await expect(
        descriptor.handler({ title: 'x', project_id: 'p_1', assignee_ids: ['u_outsider'] })
      ).rejects.toThrow(/not members of this workspace/);

      // Exactly one call — proves this tool did not attempt to verify
      // membership itself before going to the wire (it would have needed a
      // SECOND call, e.g. to list members, to do that).
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('forwards an unknown column_id to the wire and surfaces the mapped not_found error', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { type: 'invalid_request_error', code: 'not_found', message: 'irrelevant', request_id: null },
        })
      );
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await expect(descriptor.handler({ title: 'x', column_id: 'c_missing' })).rejects.toThrow(
        /No matching resource was found/
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('wire mapping', () => {
    it('requests POST /tasks', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireTask({})));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await descriptor.handler({ title: 'x', project_id: 'p_1' });

      const { url, init } = lastRequest(fetchMock);
      expect(url.pathname).toBe('/api/public/v1/tasks');
      expect(init.method).toBe('POST');
    });

    it('maps title->title_text, column_id->card_id, assignee_ids->user_ids, and drops every tool-vocab key from the wire body', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireTask({})));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await descriptor.handler({
        title: 'Ship it',
        column_id: 'c_1',
        description: 'a description',
        priority: 'high',
        progress: 40,
        due_date: '2026-06-01',
        due_time: '14:30',
        assignee_ids: ['u_1', 'u_2'],
      });

      const body = requestedBody(fetchMock);
      expect(body.title_text).toBe('Ship it');
      expect(body.card_id).toBe('c_1');
      expect(body.description).toBe('a description');
      expect(body.priority).toBe('high');
      expect(body.progress).toBe(40);
      expect(body.end_date).toBe('2026-06-01');
      expect(body.end_time).toBe('14:30');
      expect(body.user_ids).toEqual(['u_1', 'u_2']);

      for (const toolKey of ['title', 'column_id', 'due_date', 'due_time', 'assignee_ids']) {
        expect(Object.prototype.hasOwnProperty.call(body, toolKey)).toBe(false);
      }
    });

    it('omits fields entirely when not given, rather than sending them as null/undefined', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireTask({})));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await descriptor.handler({ title: 'x', project_id: 'p_1' });

      const body = requestedBody(fetchMock);
      for (const wireKey of ['card_id', 'project_id', 'description', 'priority', 'progress', 'end_date', 'end_time', 'user_ids']) {
        expect(Object.prototype.hasOwnProperty.call(body, wireKey)).toBe(wireKey === 'project_id');
      }
    });

    it('never sends idempotency_key onto the wire body itself', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireTask({})));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await descriptor.handler({ title: 'x', project_id: 'p_1', idempotency_key: 'caller-key-1' });

      const body = requestedBody(fetchMock);
      expect(Object.prototype.hasOwnProperty.call(body, 'idempotency_key')).toBe(false);
    });
  });

  describe('response mapping', () => {
    it('maps the created task (card -> column, plus derived column_id) and reports replayed: false for a fresh create', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        itemResponse(
          201,
          wireTask({
            card: { id: 'c_1', name: 'In Progress', is_done: false },
          })
        )
      );
      const descriptor = workelCreateTask(makeClient(fetchMock));

      const result = await descriptor.handler({ title: 'x', project_id: 'p_1' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.column).toEqual({ id: 'c_1', name: 'In Progress', is_done: false });
      expect(parsed.column_id).toBe('c_1');
      expect(parsed.replayed).toBe(false);
    });

    it('reports replayed: true when the server marks the response as an idempotency replay', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(itemResponse(201, wireTask({}), { 'Idempotent-Replay': 'true' }));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      const result = await descriptor.handler({ title: 'x', project_id: 'p_1', idempotency_key: 'caller-key-1' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.replayed).toBe(true);
    });

    it('forwards a caller-supplied idempotency_key verbatim as the Idempotency-Key header', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireTask({})));
      const descriptor = workelCreateTask(makeClient(fetchMock));

      await descriptor.handler({ title: 'x', project_id: 'p_1', idempotency_key: 'caller-key-1' });

      const { init } = lastRequest(fetchMock);
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('caller-key-1');
    });
  });

  it('description names the exact column_id/project_id and due_time/due_date rules', () => {
    const descriptor = workelCreateTask(makeClient(jest.fn()));

    expect(descriptor.description).toContain('EXACTLY ONE of column_id or project_id');
    expect(descriptor.description).toContain('due_time is only meaningful alongside due_date');
  });

  it('does not declare a fake-safety confirm input parameter', () => {
    const descriptor = workelCreateTask(makeClient(jest.fn()));

    expect(Object.prototype.hasOwnProperty.call(descriptor.inputSchema, 'confirm')).toBe(false);
  });
});

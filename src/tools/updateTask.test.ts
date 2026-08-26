import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelUpdateTask } from './updateTask';

const BASE_URL = 'https://api.test/api/public/v1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
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
  expect(fetchMock).toHaveBeenCalled();
  const calls = fetchMock.mock.calls as [string, RequestInit][];
  const [url, init] = calls[calls.length - 1];
  return { url: new URL(url), init };
}

function requestedBody(fetchMock: jest.Mock): Record<string, unknown> {
  const { init } = lastRequest(fetchMock);
  return JSON.parse(init.body as string);
}

function wireTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't_9',
    title: 'Existing title',
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

describe('workel_update_task', () => {
  it('requires the write:tasks scope', () => {
    const descriptor = workelUpdateTask(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('write:tasks');
  });

  it('sets the annotations exactly: not read-only, destructive, idempotent, never open-world', () => {
    const descriptor = workelUpdateTask(makeClient(jest.fn()));

    expect(descriptor.annotations).toEqual({
      title: 'Update task',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('input schema excludes reminder_date, card_id, column_id, project_id, and every assignee field', () => {
    const descriptor = workelUpdateTask(makeClient(jest.fn()));
    const keys = Object.keys(descriptor.inputSchema);

    for (const forbidden of ['reminder_date', 'card_id', 'column_id', 'project_id', 'user_ids', 'assignee_ids']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('input schema is exactly id + the six updatable fields', () => {
    const descriptor = workelUpdateTask(makeClient(jest.fn()));
    const keys = Object.keys(descriptor.inputSchema).sort();

    expect(keys).toEqual(
      ['description', 'due_date', 'due_time', 'id', 'priority', 'progress', 'title'].sort()
    );
  });

  it('does not declare a fake-safety confirm input parameter', () => {
    const descriptor = workelUpdateTask(makeClient(jest.fn()));

    expect(Object.prototype.hasOwnProperty.call(descriptor.inputSchema, 'confirm')).toBe(false);
  });

  describe('PATCH body: explicit presence check, never spread-with-undefineds', () => {
    it('omits every field that was not given, and includes exactly the fields that were', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireTask({})));
      const descriptor = workelUpdateTask(makeClient(fetchMock));

      await descriptor.handler({ id: 't_9', priority: 'high' });

      const body = requestedBody(fetchMock);
      expect(Object.prototype.hasOwnProperty.call(body, 'priority')).toBe(true);
      expect(body.priority).toBe('high');
      for (const omitted of ['title_text', 'description', 'progress', 'end_date', 'end_time']) {
        expect(Object.prototype.hasOwnProperty.call(body, omitted)).toBe(false);
      }
    });

    it('sends an explicit null as null (clearing a field), not as an absent key', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireTask({})));
      const descriptor = workelUpdateTask(makeClient(fetchMock));

      await descriptor.handler({ id: 't_9', due_date: null });

      const body = requestedBody(fetchMock);
      expect(Object.prototype.hasOwnProperty.call(body, 'end_date')).toBe(true);
      expect(body.end_date).toBeNull();
    });

    it('an empty call body (id only) sends an empty PATCH body', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireTask({})));
      const descriptor = workelUpdateTask(makeClient(fetchMock));

      await descriptor.handler({ id: 't_9' });

      const body = requestedBody(fetchMock);
      expect(Object.keys(body)).toEqual([]);
    });

    it('accepts an explicit null via the zod schema itself for every clearable field', () => {
      const descriptor = workelUpdateTask(makeClient(jest.fn()));
      const schema = z.object(descriptor.inputSchema);

      const outcome = schema.safeParse({
        id: 't_9',
        title: null,
        description: null,
        priority: null,
        progress: null,
        due_date: null,
        due_time: null,
      });

      expect(outcome.success).toBe(true);
    });
  });

  it('renames title -> title_text, due_date -> end_date, due_time -> end_time on the wire', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireTask({})));
    const descriptor = workelUpdateTask(makeClient(fetchMock));

    await descriptor.handler({ id: 't_9', title: 'New title', due_date: '2026-07-01', due_time: '09:00' });

    const body = requestedBody(fetchMock);
    expect(body.title_text).toBe('New title');
    expect(body.end_date).toBe('2026-07-01');
    expect(body.end_time).toBe('09:00');
    expect(Object.prototype.hasOwnProperty.call(body, 'title')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'due_date')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'due_time')).toBe(false);
  });

  it('requests PATCH /tasks/{id} with the id in the path', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireTask({})));
    const descriptor = workelUpdateTask(makeClient(fetchMock));

    await descriptor.handler({ id: 't_9', priority: 'low' });

    const { url, init } = lastRequest(fetchMock);
    expect(url.pathname).toBe('/api/public/v1/tasks/t_9');
    expect(init.method).toBe('PATCH');
  });

  it('never sends an Idempotency-Key header (PATCH has no idempotency key)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireTask({})));
    const descriptor = workelUpdateTask(makeClient(fetchMock));

    await descriptor.handler({ id: 't_9', priority: 'low' });

    const { init } = lastRequest(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('maps the updated task back (card -> column, plus derived column_id)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, wireTask({ card: { id: 'c_2', name: 'Done', is_done: true } }))
    );
    const descriptor = workelUpdateTask(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_9', priority: 'low' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.column).toEqual({ id: 'c_2', name: 'Done', is_done: true });
    expect(parsed.column_id).toBe('c_2');
  });

  describe('nothing is pre-checked before the wire — the server\'s own permission gap is documented, not patched', () => {
    it('surfaces the mapped not_found error for an invisible/nonexistent task id, with exactly one fetch call', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { type: 'invalid_request_error', code: 'not_found', message: 'irrelevant', request_id: null },
        })
      );
      const descriptor = workelUpdateTask(makeClient(fetchMock));

      await expect(descriptor.handler({ id: 't_missing', priority: 'low' })).rejects.toThrow(
        /No matching resource was found/
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('description states this tool cannot move columns/projects or change assignees', () => {
    const descriptor = workelUpdateTask(makeClient(jest.fn()));

    expect(descriptor.description).toContain('CANNOT move');
    expect(descriptor.description).toContain('CANNOT change its assignees');
  });

  it('description states the cross-project write capability: any task in any visible project, regardless of the key creator\'s project membership', () => {
    const descriptor = workelUpdateTask(makeClient(jest.fn()));

    expect(descriptor.description).toContain('ANY task in ANY project');
    expect(descriptor.description).toContain("regardless of whether the key's creator is actually a member of that specific project");
    expect(descriptor.description).toContain('no per-project permission check');
  });
});

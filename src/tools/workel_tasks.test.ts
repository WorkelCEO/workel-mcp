import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelListTasks, workelGetTask } from './workel_tasks';

const BASE_URL = 'https://api.test/api/public/v1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A single-resource response: the record wrapped in the `{data: ...}` envelope
 * a Laravel API Resource always emits. Mocking the bare record here instead is
 * what let the envelope bug ship — the fixtures asserted a shape the API never
 * sends, so the suite stayed green while `result.data` handed the mapper the
 * wrapper. Use this for every show/create/update response; `jsonResponse` stays
 * for list pages (which carry their own `{data, meta}`) and for error bodies.
 */
function itemResponse(status: number, record: unknown): Response {
  return jsonResponse(status, { data: record });
}

function makeClient(fetchMock: jest.Mock) {
  return createWorkelApiClient({
    baseUrl: BASE_URL,
    apiKey: 'wk_test_key',
    fetch: fetchMock as unknown as FetchLike,
    sleep: jest.fn() as unknown as SleepLike,
  });
}

function requestedUrl(fetchMock: jest.Mock): URL {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url] = fetchMock.mock.calls[0] as [string];
  return new URL(url);
}

describe('workel_list_tasks', () => {
  it('requires the read:tasks scope', () => {
    const descriptor = workelListTasks(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:tasks');
  });

  it('requests GET /tasks with every filter renamed onto the wire correctly (column_id -> card_id)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTasks(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({
      limit: 30,
      cursor: 'cur_t',
      project_id: 'p_1',
      column_id: 'c_1',
      completed: true,
      due_before: '2026-06-01',
      due_after: '2026-01-01',
      updated_since: '2026-01-01T00:00:00Z',
    });
    await descriptor.handler(parsed);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe('/api/public/v1/tasks');
    expect(url.searchParams.get('limit')).toBe('30');
    expect(url.searchParams.get('cursor')).toBe('cur_t');
    expect(url.searchParams.get('project_id')).toBe('p_1');
    expect(url.searchParams.get('card_id')).toBe('c_1');
    expect(url.searchParams.has('column_id')).toBe(false);
    expect(url.searchParams.get('completed')).toBe('true');
    expect(url.searchParams.get('due_before')).toBe('2026-06-01');
    expect(url.searchParams.get('due_after')).toBe('2026-01-01');
    expect(url.searchParams.get('updated_since')).toBe('2026-01-01T00:00:00Z');
  });

  it('omits filters entirely when not given, rather than sending them as blank/undefined', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTasks(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({});
    await descriptor.handler(parsed);

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get('limit')).toBe('25');
    for (const key of ['cursor', 'project_id', 'card_id', 'completed', 'due_before', 'due_after', 'updated_since']) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });

  it('rejects limit: 101 at the schema without ever calling the client', async () => {
    const fetchMock = jest.fn();
    const descriptor = workelListTasks(makeClient(fetchMock));

    const outcome = z.object(descriptor.inputSchema).safeParse({ limit: 101 });

    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed due_before at the schema without ever calling the client', async () => {
    const fetchMock = jest.fn();
    const descriptor = workelListTasks(makeClient(fetchMock));

    const outcome = z.object(descriptor.inputSchema).safeParse({ due_before: 'not-a-date' });

    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each task (card -> column, plus derived column_id), drops description, and passes next_cursor through', async () => {
    const wireBody = {
      data: [
        {
          id: 't_1',
          title: 'Ship it',
          description: 'a long description',
          project_id: 'p_1',
          card: { id: 'c_1', name: 'In Progress', is_done: false },
          priority: 'high',
          due_date: '2026-06-01',
          due_time: null,
          progress: 50,
          completed: false,
          assignee_ids: ['u_1'],
          created_at: null,
          updated_at: null,
        },
      ],
      meta: { next_cursor: 'cur_next' },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireBody));
    const descriptor = workelListTasks(makeClient(fetchMock));

    const result = await descriptor.handler({ limit: 25 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.next_cursor).toBe('cur_next');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).not.toHaveProperty('description');
    expect(parsed.items[0]).not.toHaveProperty('card');
    expect(parsed.items[0].column).toEqual({ id: 'c_1', name: 'In Progress', is_done: false });
    expect(parsed.items[0].column_id).toBe('c_1');
  });

  it('description names the exact filter semantics: due_before/due_after exclusive, updated_since inclusive, no text search', () => {
    const descriptor = workelListTasks(makeClient(jest.fn()));

    expect(descriptor.description).toContain('due_before and due_after are EXCLUSIVE');
    expect(descriptor.description).toContain('updated_since is INCLUSIVE');
    expect(descriptor.description).toContain('There is no text search');
  });
});

describe('workel_get_task', () => {
  it('requires the read:tasks scope', () => {
    const descriptor = workelGetTask(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:tasks');
  });

  it('requests GET /tasks/{id} with the id in the path, no query params', async () => {
    const wireTask = {
      id: 't_9',
      title: 'Do the thing',
      description: null,
      project_id: 'p_1',
      card: null,
      priority: null,
      due_date: null,
      due_time: null,
      progress: null,
      completed: false,
      assignee_ids: [],
      created_at: null,
      updated_at: null,
    };
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(200, wireTask));
    const descriptor = workelGetTask(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ id: 't_9' });
    await descriptor.handler(parsed);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe('/api/public/v1/tasks/t_9');
    expect(url.search).toBe('');
  });

  it('surfaces the cover image and attachments, each attachment reduced to id/name/url/type/size/uploader/created_at', async () => {
    const wireTask = {
      id: 't_9',
      title: 'Do the thing',
      description: null,
      project_id: 'p_1',
      card: null,
      priority: null,
      due_date: null,
      due_time: null,
      progress: null,
      completed: false,
      assignee_ids: [],
      cover_image: { url: 'https://cdn.test/covers/a.png', name: 'a.png', type: 'image/png', size: 2048 },
      attachments: [
        {
          id: 'att_1',
          name: 'spec.pdf',
          url: 'https://cdn.test/attachments/spec.pdf',
          type: 'application/pdf',
          size: 4096,
          uploaded_by: { id: 'u_1', name: 'Ada' },
          created_at: '2026-08-26T10:00:00+00:00',
        },
      ],
      created_at: null,
      updated_at: null,
    };
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(200, wireTask));
    const descriptor = workelGetTask(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_9' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.cover_image).toEqual({
      url: 'https://cdn.test/covers/a.png',
      name: 'a.png',
      type: 'image/png',
      size: 2048,
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(Object.keys(parsed.attachments[0]).sort()).toEqual(
      ['created_at', 'id', 'name', 'size', 'type', 'uploaded_by', 'url'].sort()
    );
    expect(parsed.attachments[0].uploaded_by).toEqual({ id: 'u_1', name: 'Ada' });
  });

  it('reports an absent cover as null and an empty attachment list as [], distinguishing "none" from "not reported"', async () => {
    const wireTask = {
      id: 't_9',
      title: 'Do the thing',
      description: null,
      project_id: 'p_1',
      card: null,
      priority: null,
      due_date: null,
      due_time: null,
      progress: null,
      completed: false,
      assignee_ids: [],
      cover_image: null,
      attachments: [],
      created_at: null,
      updated_at: null,
    };
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(200, wireTask));
    const descriptor = workelGetTask(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_9' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.cover_image).toBeNull();
    expect(parsed.attachments).toEqual([]);
  });

  it('omits both keys entirely when the server did not report them, rather than inventing a null', async () => {
    // The listing does not carry cover_image/attachments. An explicit null
    // there would read as "this task has none", which is a different claim
    // from "this view does not report them" — so the keys must be absent.
    const wireTask = {
      id: 't_9',
      title: 'Do the thing',
      description: null,
      project_id: 'p_1',
      card: null,
      priority: null,
      due_date: null,
      due_time: null,
      progress: null,
      completed: false,
      assignee_ids: [],
      created_at: null,
      updated_at: null,
    };
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(200, wireTask));
    const descriptor = workelGetTask(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_9' });
    const parsed = JSON.parse(result.content[0].text);

    expect(Object.prototype.hasOwnProperty.call(parsed, 'cover_image')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'attachments')).toBe(false);
  });

  it('truncates a long description and derives column/column_id as null when there is no card', async () => {
    const longDescription = 'y'.repeat(9000);
    const wireTask = {
      id: 't_9',
      title: 'Do the thing',
      description: longDescription,
      project_id: null,
      card: null,
      priority: null,
      due_date: null,
      due_time: null,
      progress: null,
      completed: false,
      assignee_ids: [],
      created_at: null,
      updated_at: null,
    };
    const fetchMock = jest.fn().mockResolvedValue(itemResponse(200, wireTask));
    const descriptor = workelGetTask(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_9' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.description.length).toBeLessThan(longDescription.length);
    expect(parsed.column).toBeNull();
    expect(parsed.column_id).toBeNull();
  });
});

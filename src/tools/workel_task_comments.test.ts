import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelListTaskComments } from './workel_task_comments';

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

describe('workel_list_task_comments', () => {
  it('requires the read:tasks scope (comments have no scope of their own)', () => {
    const descriptor = workelListTaskComments(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:tasks');
  });

  it('requests GET /tasks/{id}/comments with the id in the path and limit/cursor as query params', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTaskComments(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ id: 't_1', limit: 12, cursor: 'cur_c' });
    await descriptor.handler(parsed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe('/api/public/v1/tasks/t_1/comments');
    expect(parsedUrl.searchParams.get('limit')).toBe('12');
    expect(parsedUrl.searchParams.get('cursor')).toBe('cur_c');
  });

  it('defaults limit to 25 when omitted', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTaskComments(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ id: 't_1' });
    await descriptor.handler(parsed);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get('limit')).toBe('25');
  });

  it('rejects limit: 101 at the schema without ever calling the client', async () => {
    const fetchMock = jest.fn();
    const descriptor = workelListTaskComments(makeClient(fetchMock));

    const outcome = z.object(descriptor.inputSchema).safeParse({ id: 't_1', limit: 101 });

    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps (truncated) body — never omits it the way a task/project description is omitted in list view', async () => {
    const wireBody = {
      data: [
        { id: 'cm_1', body: 'z'.repeat(9000), author: { id: 'u_1', name: 'Ada' }, created_at: null },
        { id: 'cm_2', body: 'short', author: null, created_at: '2026-01-01T00:00:00Z' },
      ],
      meta: { next_cursor: null },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireBody));
    const descriptor = workelListTaskComments(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toHaveProperty('body');
    expect(parsed.items[0].body.length).toBeLessThan(9000);
    expect(parsed.items[1].body).toBe('short');
    expect(parsed.items[1].author).toBeNull();
  });
});

import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelListProjectColumns } from './workel_project_columns';

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

describe('workel_list_project_columns', () => {
  it('requires the read:projects scope', () => {
    const descriptor = workelListProjectColumns(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:projects');
  });

  it('requests GET /projects/{id}/cards with the id in the path and limit/cursor as query params', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListProjectColumns(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ id: 'p_1', limit: 15, cursor: 'cur_x' });
    await descriptor.handler(parsed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe('/api/public/v1/projects/p_1/cards');
    expect(parsedUrl.searchParams.get('limit')).toBe('15');
    expect(parsedUrl.searchParams.get('cursor')).toBe('cur_x');
  });

  it('defaults limit to 25 when omitted', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListProjectColumns(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ id: 'p_1' });
    await descriptor.handler(parsed);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get('limit')).toBe('25');
  });

  it('rejects limit: 101 at the schema without ever calling the client', async () => {
    const fetchMock = jest.fn();
    const descriptor = workelListProjectColumns(makeClient(fetchMock));

    const outcome = z.object(descriptor.inputSchema).safeParse({ id: 'p_1', limit: 101 });

    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each column including order, and passes next_cursor through', async () => {
    const wireBody = {
      data: [
        { id: 'c_1', name: 'To Do', is_done: false, order: 0 },
        { id: 'c_2', name: 'Done', is_done: true, order: 1 },
      ],
      meta: { next_cursor: 'cur_next' },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireBody));
    const descriptor = workelListProjectColumns(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 'p_1' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.next_cursor).toBe('cur_next');
    expect(parsed.items).toEqual([
      { id: 'c_1', name: 'To Do', is_done: false, order: 0 },
      { id: 'c_2', name: 'Done', is_done: true, order: 1 },
    ]);
  });

  it('description clarifies columns are kanban lists, not tasks', () => {
    const descriptor = workelListProjectColumns(makeClient(jest.fn()));

    expect(descriptor.description).toContain('columns are kanban lists, not tasks');
  });
});

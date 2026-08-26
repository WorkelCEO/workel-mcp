import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelListMembers } from './workel_members';

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

describe('workel_list_members', () => {
  it('requires the read:members scope', () => {
    const descriptor = workelListMembers(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:members');
  });

  it('requests GET /members with limit/cursor as the only query params', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListMembers(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ limit: 5, cursor: 'cur_m' });
    await descriptor.handler(parsed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe('/api/public/v1/members');
    expect(parsedUrl.searchParams.get('limit')).toBe('5');
    expect(parsedUrl.searchParams.get('cursor')).toBe('cur_m');
  });

  it('defaults limit to 25 when omitted', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListMembers(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({});
    await descriptor.handler(parsed);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get('limit')).toBe('25');
  });

  it('rejects limit: 101 at the schema without ever calling the client', async () => {
    const fetchMock = jest.fn();
    const descriptor = workelListMembers(makeClient(fetchMock));

    const outcome = z.object(descriptor.inputSchema).safeParse({ limit: 101 });

    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each member (including email) and passes next_cursor through', async () => {
    const wireBody = {
      data: [
        { id: 'u_1', name: 'Ada', email: 'ada@example.com', role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
        { id: 'u_2', name: 'Grace', email: 'grace@example.com', role: null, joined_at: null },
      ],
      meta: { next_cursor: 'cur_next' },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireBody));
    const descriptor = workelListMembers(makeClient(fetchMock));

    const result = await descriptor.handler({ limit: 25 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.next_cursor).toBe('cur_next');
    expect(parsed.items).toEqual(wireBody.data);
  });
});

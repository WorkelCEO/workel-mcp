import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelListEvents } from './workel_events';

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

describe('workel_list_events', () => {
  it('requires the read:events scope', () => {
    const descriptor = workelListEvents(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:events');
  });

  it('requests GET /events with limit/cursor/from/to as query params', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListEvents(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({
      limit: 8,
      cursor: 'cur_e',
      from: '2026-01-01',
      to: '2026-02-01',
    });
    await descriptor.handler(parsed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe('/api/public/v1/events');
    expect(parsedUrl.searchParams.get('limit')).toBe('8');
    expect(parsedUrl.searchParams.get('cursor')).toBe('cur_e');
    expect(parsedUrl.searchParams.get('from')).toBe('2026-01-01');
    expect(parsedUrl.searchParams.get('to')).toBe('2026-02-01');
  });

  it('omits from/to entirely when not given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListEvents(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({});
    await descriptor.handler(parsed);

    const [url] = fetchMock.mock.calls[0] as [string];
    const parsedUrl = new URL(url);
    expect(parsedUrl.searchParams.get('limit')).toBe('25');
    expect(parsedUrl.searchParams.has('from')).toBe(false);
    expect(parsedUrl.searchParams.has('to')).toBe(false);
  });

  it('rejects limit: 101 at the schema without ever calling the client', async () => {
    const fetchMock = jest.fn();
    const descriptor = workelListEvents(makeClient(fetchMock));

    const outcome = z.object(descriptor.inputSchema).safeParse({ limit: 101 });

    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each event, truncates (never omits) a long description, and passes next_cursor through', async () => {
    const wireBody = {
      data: [
        {
          id: 'e_1',
          title: 'Standup',
          description: 'w'.repeat(9000),
          date: '2026-01-05',
          start_time: '09:00',
          end_time: '09:15',
          location: null,
          project_id: 'p_1',
          workspace_id: null,
          color: '#ff0000',
          repeat: 'daily',
          created_at: null,
          updated_at: null,
        },
      ],
      meta: { next_cursor: 'cur_next' },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireBody));
    const descriptor = workelListEvents(makeClient(fetchMock));

    const result = await descriptor.handler({ limit: 25 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.next_cursor).toBe('cur_next');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toHaveProperty('description');
    expect(parsed.items[0].description.length).toBeLessThan(9000);
    expect(parsed.items[0].repeat).toBe('daily');
  });

  it('description states the window semantics: from/to inclusive, 400-day maximum', () => {
    const descriptor = workelListEvents(makeClient(jest.fn()));

    expect(descriptor.description).toContain('from and to are INCLUSIVE');
    expect(descriptor.description).toContain('400-day');
  });
});

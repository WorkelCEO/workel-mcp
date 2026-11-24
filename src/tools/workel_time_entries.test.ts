import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { TEXT_CAP, TRUNCATION_MARKER } from '../output';
import { workelListTimeEntries } from './workel_time_entries';

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

function wireEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'te_1',
    task_id: 't_1',
    project_id: 'p_1',
    user: { id: 'u_1', name: 'Ada' },
    started_at: '2026-11-24T09:00:00+00:00',
    ended_at: '2026-11-24T09:45:00+00:00',
    duration_seconds: 2700,
    running: false,
    billable: true,
    note: 'Drafted the client report',
    source: 'timer',
    created_at: '2026-11-24T09:00:00+00:00',
    updated_at: '2026-11-24T09:45:00+00:00',
    ...overrides,
  };
}

describe('workel_list_time_entries', () => {
  it('requires the read:time scope, not read:tasks', () => {
    const descriptor = workelListTimeEntries(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:time');
  });

  it('requests GET /time-entries with every filter as a query param', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTimeEntries(makeClient(fetchMock));

    await descriptor.handler({
      limit: 10,
      cursor: 'c_1',
      from: '2026-11-17',
      to: '2026-11-24',
      task_id: 't_1',
      project_id: 'p_1',
      user_id: 'u_1',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/public/v1/time-entries');
    expect(init.method ?? 'GET').toBe('GET');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      limit: '10',
      cursor: 'c_1',
      from: '2026-11-17',
      to: '2026-11-24',
      task_id: 't_1',
      project_id: 'p_1',
      user_id: 'u_1',
    });
  });

  it('omits the filters it was not given', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTimeEntries(makeClient(fetchMock));

    await descriptor.handler({ limit: 25 });

    const parsed = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect([...parsed.searchParams.keys()]).toEqual(['limit']);
  });

  it('rejects limit: 101 at the schema without ever calling the client', () => {
    const fetchMock = jest.fn();
    const descriptor = workelListTimeEntries(makeClient(fetchMock));

    expect(z.object(descriptor.inputSchema).safeParse({ limit: 101 }).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each entry, keeps a running timer as running, truncates a long note, and passes next_cursor through', async () => {
    const longNote = 'x'.repeat(TEXT_CAP + 50);
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [
          wireEntry(),
          wireEntry({ id: 'te_2', ended_at: null, duration_seconds: null, running: true, note: longNote }),
        ],
        meta: { next_cursor: 'c_next' },
      })
    );
    const descriptor = workelListTimeEntries(makeClient(fetchMock));

    const result = await descriptor.handler({ limit: 25 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.next_cursor).toBe('c_next');
    expect(parsed.items[0]).toEqual({
      id: 'te_1',
      task_id: 't_1',
      project_id: 'p_1',
      user: { id: 'u_1', name: 'Ada' },
      started_at: '2026-11-24T09:00:00+00:00',
      ended_at: '2026-11-24T09:45:00+00:00',
      duration_seconds: 2700,
      running: false,
      billable: true,
      note: 'Drafted the client report',
      source: 'timer',
      created_at: '2026-11-24T09:00:00+00:00',
      updated_at: '2026-11-24T09:45:00+00:00',
    });
    expect(parsed.items[1].running).toBe(true);
    expect(parsed.items[1].ended_at).toBeNull();
    expect(parsed.items[1].duration_seconds).toBeNull();
    expect(parsed.items[1].note.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(parsed.items[1].note.length).toBeLessThan(longNote.length);
  });

  it('description states the window semantics: from inclusive, to exclusive, 400-day maximum', () => {
    const descriptor = workelListTimeEntries(makeClient(jest.fn()));

    expect(descriptor.description).toMatch(/from is inclusive/);
    expect(descriptor.description).toMatch(/to is EXCLUSIVE/);
    expect(descriptor.description).toMatch(/400 days/);
  });
});

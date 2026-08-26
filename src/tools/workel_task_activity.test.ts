import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelListTaskActivity } from './workel_task_activity';

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

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act_1',
    action: 'updated progress',
    actor: { id: 'u_1', name: 'Ada' },
    occurred_at: '2026-08-26T10:00:00+00:00',
    ...overrides,
  };
}

describe('workel_list_task_activity', () => {
  it('requires the read:tasks scope (activity has no scope of its own)', () => {
    const descriptor = workelListTaskActivity(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:tasks');
  });

  it('is annotated read-only and closed-world like every other read tool', () => {
    const descriptor = workelListTaskActivity(makeClient(jest.fn()));

    expect(descriptor.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it('requests GET /tasks/{id}/activity with the id in the path and limit/cursor as query params', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTaskActivity(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ id: 't_1', limit: 12, cursor: 'cur_a' });
    await descriptor.handler(parsed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe('/api/public/v1/tasks/t_1/activity');
    expect(parsedUrl.searchParams.get('limit')).toBe('12');
    expect(parsedUrl.searchParams.get('cursor')).toBe('cur_a');
  });

  it('percent-encodes an id rather than letting it alter the path', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListTaskActivity(makeClient(fetchMock));

    await descriptor.handler({ id: '../../me', limit: 25 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).pathname).toBe('/api/public/v1/tasks/..%2F..%2Fme/activity');
  });

  it('returns who/what/when per row and the cursor, and nothing else', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [activityRow()],
        meta: { next_cursor: 'cur_next' },
      })
    );
    const descriptor = workelListTaskActivity(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_1', limit: 25 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.items).toEqual([
      {
        id: 'act_1',
        action: 'updated progress',
        actor: { id: 'u_1', name: 'Ada' },
        occurred_at: '2026-08-26T10:00:00+00:00',
      },
    ]);
    expect(payload.next_cursor).toBe('cur_next');
  });

  it('drops any unrecognized wire key rather than leaking it through', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [activityRow({ is_read: true, subject_type: 'App\\Models\\Task', comment_snippet: 'secret' })],
        meta: { next_cursor: null },
      })
    );
    const descriptor = workelListTaskActivity(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_1', limit: 25 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    // The mapper builds each row field-by-field, so a field the server starts
    // sending later cannot silently become part of this tool's contract.
    expect(Object.keys(payload.items[0]).sort()).toEqual(['action', 'actor', 'id', 'occurred_at']);
    expect((result.content[0] as { text: string }).text).not.toContain('secret');
  });

  it('tolerates a system row with no actor', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, { data: [activityRow({ actor: null })], meta: { next_cursor: null } })
    );
    const descriptor = workelListTaskActivity(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 't_1', limit: 25 });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.items[0].actor).toBeNull();
  });

  it("description warns that `action` is prose, not an enum, and that mention rows are excluded", () => {
    const descriptor = workelListTaskActivity(makeClient(jest.fn()));

    expect(descriptor.description).toContain('NOT an');
    expect(descriptor.description).toContain('never branch on its exact wording');
    expect(descriptor.description).toContain('mentioned');
  });
});

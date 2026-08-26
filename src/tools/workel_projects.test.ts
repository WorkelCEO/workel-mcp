import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelListProjects, workelGetProject } from './workel_projects';

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

function requestedUrl(fetchMock: jest.Mock): URL {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url] = fetchMock.mock.calls[0] as [string];
  return new URL(url);
}

describe('workel_list_projects', () => {
  it('requires the read:projects scope', () => {
    const descriptor = workelListProjects(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:projects');
  });

  it('requests GET /projects with limit=25 and no cursor when limit is omitted', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListProjects(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({});
    await descriptor.handler(parsed);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe('/api/public/v1/projects');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('forwards an explicit limit and cursor unchanged', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { data: [], meta: { next_cursor: null } }));
    const descriptor = workelListProjects(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ limit: 10, cursor: 'cur_abc' });
    await descriptor.handler(parsed);

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('cursor')).toBe('cur_abc');
  });

  it('rejects limit: 101 at the schema without ever calling the client', async () => {
    const fetchMock = jest.fn();
    const descriptor = workelListProjects(makeClient(fetchMock));

    const outcome = z.object(descriptor.inputSchema).safeParse({ limit: 101 });

    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each project, drops description, and passes next_cursor through as items/next_cursor', async () => {
    const wireBody = {
      data: [
        { id: 'p_1', name: 'Alpha', description: 'a very long project description', created_at: null, updated_at: null },
        { id: 'p_2', name: 'Beta', description: null, created_at: '2026-01-01T00:00:00Z', updated_at: null },
      ],
      meta: { next_cursor: 'cur_next' },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireBody));
    const descriptor = workelListProjects(makeClient(fetchMock));

    const result = await descriptor.handler({ limit: 25 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.next_cursor).toBe('cur_next');
    expect(parsed.items).toHaveLength(2);
    for (const item of parsed.items) {
      expect(item).not.toHaveProperty('description');
    }
    expect(parsed.items[0]).toMatchObject({ id: 'p_1', name: 'Alpha' });
  });
});

describe('workel_get_project', () => {
  it('requires the read:projects scope', () => {
    const descriptor = workelGetProject(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('read:projects');
  });

  it('requests GET /projects/{id} with the id in the path, no query params', async () => {
    const wireProject = { id: 'p_9', name: 'Gamma', description: null, created_at: null, updated_at: null };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireProject));
    const descriptor = workelGetProject(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({ id: 'p_9' });
    await descriptor.handler(parsed);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe('/api/public/v1/projects/p_9');
    expect(url.search).toBe('');
  });

  it('truncates a long description rather than omitting it', async () => {
    const longDescription = 'x'.repeat(9000);
    const wireProject = { id: 'p_9', name: 'Gamma', description: longDescription, created_at: null, updated_at: null };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireProject));
    const descriptor = workelGetProject(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 'p_9' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty('description');
    expect(parsed.description.length).toBeLessThan(longDescription.length);
    expect(parsed.description.length).toBeGreaterThan(0);
  });

  it('keeps a null description as null rather than throwing', async () => {
    const wireProject = { id: 'p_9', name: 'Gamma', description: null, created_at: null, updated_at: null };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, wireProject));
    const descriptor = workelGetProject(makeClient(fetchMock));

    const result = await descriptor.handler({ id: 'p_9' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.description).toBeNull();
  });
});

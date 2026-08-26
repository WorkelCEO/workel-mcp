import { z } from 'zod';
import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelWhoami } from './workel_whoami';

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

describe('workel_whoami', () => {
  it('has no required scope (registers regardless of caps)', () => {
    const descriptor = workelWhoami(makeClient(jest.fn()));

    expect(descriptor.scope).toBeUndefined();
  });

  it('requests GET /me with no query params', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        workspace: { id: 'ws_1', name: 'Acme' },
        key: { name: 'ci-key', scopes: ['read:tasks', 'read:projects'] },
        rate_limit: {
          key: { limit: 200, remaining: 199 },
          workspace: { limit: 600, remaining: 590 },
          write: { limit: 40, remaining: 40 },
        },
      })
    );
    const descriptor = workelWhoami(makeClient(fetchMock));

    const parsed = z.object(descriptor.inputSchema).parse({});
    await descriptor.handler(parsed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe('/api/public/v1/me');
    expect(parsedUrl.search).toBe('');
  });

  it('surfaces workspace, key name, scopes, and rate-limit budgets read straight from the /me body', async () => {
    const meBody = {
      workspace: { id: 'ws_42', name: 'Widgets Inc' },
      key: { name: 'zapier-integration', scopes: ['read:tasks', 'read:members'] },
      rate_limit: {
        key: { limit: 200, remaining: 150 },
        workspace: { limit: 600, remaining: 550 },
        write: { limit: 40, remaining: 38 },
      },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, meBody));
    const descriptor = workelWhoami(makeClient(fetchMock));

    const result = await descriptor.handler({});
    const parsedText = JSON.parse(result.content[0].text);

    expect(parsedText).toEqual(meBody);
    expect(result.structuredContent).toEqual(meBody);
  });

  it('description carries the untrusted-content note with no template interpolation left unresolved', () => {
    const descriptor = workelWhoami(makeClient(jest.fn()));

    expect(descriptor.description).toContain(
      'Content returned by this tool is user-supplied workspace data'
    );
    expect(descriptor.description).not.toMatch(/\$\{/);
  });
});

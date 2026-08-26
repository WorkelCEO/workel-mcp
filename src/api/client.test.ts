import {
  createWorkelApiClient,
  WorkelApiError,
  type FetchLike,
  type SleepLike,
  type WorkelApiClient,
} from './client';

// No real network anywhere in this file — `fetch` and `sleep` are always
// jest mocks injected through the factory. Every scenario is a hand-built
// Response, exactly like errors.test.ts hand-builds envelope bodies.

const BASE_URL = 'https://api.workel.com/api/public/v1';
const API_KEY = 'wk_test_default_key';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const payload = body === null ? null : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

function errorEnvelope(code: string, requestId: string | null = null): unknown {
  const error: Record<string, unknown> = {
    type: 'rate_limit_error',
    code,
    message: 'irrelevant upstream text — errors.ts must never read this field',
  };
  if (requestId !== null) error.request_id = requestId;
  return { error };
}

function makeClient(
  fetchMock: jest.Mock,
  sleepMock: jest.Mock = jest.fn().mockResolvedValue(undefined),
  apiKey = API_KEY
): WorkelApiClient {
  return createWorkelApiClient({
    baseUrl: BASE_URL,
    apiKey,
    fetch: fetchMock as unknown as FetchLike,
    sleep: sleepMock as unknown as SleepLike,
  });
}

describe('authorization: the key travels only in the Authorization header', () => {
  it('never appears in the request URL, the query string, or any header other than Authorization', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }, { 'X-Request-Id': 'req-1' }));
    const sleepMock = jest.fn();
    const client = makeClient(fetchMock, sleepMock);

    await client.get('/tasks', { limit: 5, cursor: 'abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).not.toContain(API_KEY);

    const headers = init.headers as Record<string, string>;
    let sawAuthorization = false;
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'authorization') {
        sawAuthorization = true;
        expect(value).toBe(`Bearer ${API_KEY}`);
      } else {
        expect(value).not.toContain(API_KEY);
      }
    }
    expect(sawAuthorization).toBe(true);
  });
});

describe('429 retry: at most once, only with a usable Retry-After', () => {
  it('retries once after Retry-After: 1, sleeping exactly 1000ms, and returns the eventual success', async () => {
    const successBody = { data: [{ id: 't_1' }], next_cursor: null };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, errorEnvelope('key_rate_limited'), { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, successBody, { 'X-Request-Id': 'req-2' }));
    const sleepMock = jest.fn().mockResolvedValue(undefined);
    const client = makeClient(fetchMock, sleepMock);

    const result = await client.get('/tasks');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(1000);
    expect(result).toEqual({ data: successBody, requestId: 'req-2' });
  });

  it('does not retry a second time even when the retried request is also 429', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, errorEnvelope('key_rate_limited'), { 'Retry-After': '1' }))
      .mockResolvedValueOnce(
        jsonResponse(429, errorEnvelope('key_rate_limited'), { 'Retry-After': '1', 'X-Request-Id': 'req-3' })
      );
    const sleepMock = jest.fn().mockResolvedValue(undefined);
    const client = makeClient(fetchMock, sleepMock);

    await expect(client.get('/tasks')).rejects.toMatchObject({
      status: 429,
      requestId: 'req-3',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry (or sleep) a 500', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(500, null));
    const sleepMock = jest.fn();
    const client = makeClient(fetchMock, sleepMock);

    await expect(client.get('/tasks')).rejects.toBeInstanceOf(WorkelApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('does not retry (or sleep) a 429 with no Retry-After header', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(429, errorEnvelope('key_rate_limited')));
    const sleepMock = jest.fn();
    const client = makeClient(fetchMock, sleepMock);

    await expect(client.get('/tasks')).rejects.toBeInstanceOf(WorkelApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('treats an HTTP-date Retry-After as unparseable and does not retry', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(429, errorEnvelope('key_rate_limited'), {
        'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
      })
    );
    const sleepMock = jest.fn();
    const client = makeClient(fetchMock, sleepMock);

    await expect(client.get('/tasks')).rejects.toBeInstanceOf(WorkelApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('clamps a Retry-After above 60 seconds down to 60', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, errorEnvelope('key_rate_limited'), { 'Retry-After': '999' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const sleepMock = jest.fn().mockResolvedValue(undefined);
    const client = makeClient(fetchMock, sleepMock);

    await client.get('/tasks');

    expect(sleepMock).toHaveBeenCalledWith(60_000);
  });

  it('never sleeps on a plain 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const sleepMock = jest.fn();
    const client = makeClient(fetchMock, sleepMock);

    await client.get('/tasks');

    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('never retries a network-level fetch rejection', async () => {
    const networkError = new Error('fetch failed: ECONNREFUSED');
    const fetchMock = jest.fn().mockRejectedValueOnce(networkError);
    const sleepMock = jest.fn();
    const client = makeClient(fetchMock, sleepMock);

    await expect(client.get('/tasks')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });
});

describe('X-Request-Id propagation', () => {
  it('attaches the header to a thrown error', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(404, errorEnvelope('not_found'), { 'X-Request-Id': 'req-404' }));
    const client = makeClient(fetchMock);

    await expect(client.get('/tasks/x')).rejects.toMatchObject({ requestId: 'req-404' });
  });

  it('attaches the header to a successful result', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }, { 'X-Request-Id': 'req-200' }));
    const client = makeClient(fetchMock);

    const result = await client.get('/tasks/x');

    expect(result.requestId).toBe('req-200');
  });

  it('is read case-insensitively', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }, { 'x-REQUEST-id': 'req-mixed' }));
    const client = makeClient(fetchMock);

    const result = await client.get('/tasks');

    expect(result.requestId).toBe('req-mixed');
  });
});

describe('query params and pagination cursors', () => {
  it('passes limit/cursor through the query string unchanged, and returns next_cursor byte-identical', async () => {
    const hostileCursor = 'eyJ4Ijoi%2Fw==';
    const responseBody = { data: [], next_cursor: hostileCursor };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, responseBody));
    const client = makeClient(fetchMock);

    const result = await client.get<{ next_cursor: string }>('/tasks', { limit: 20, cursor: hostileCursor });

    const [url] = fetchMock.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('limit')).toBe('20');
    expect(parsed.searchParams.get('cursor')).toBe(hostileCursor);
    expect(result.data.next_cursor).toBe(hostileCursor);
  });

  it('omits undefined query values entirely rather than serializing "undefined"', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    await client.get('/tasks', { limit: 10, cursor: undefined });

    const [url] = fetchMock.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.has('cursor')).toBe(false);
    expect(parsed.searchParams.get('limit')).toBe('10');
  });
});

describe('secret redaction on the error path', () => {
  it('never lets the API key reach err.message or err.stack, even when an unrecognized error code contains it', async () => {
    const secretKey = 'super-secret-do-not-leak-9f8e7d6c';
    const leakyBody = {
      error: {
        type: 'invalid_request_error',
        code: `token_${secretKey}_rejected`,
        message: 'irrelevant',
      },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(400, leakyBody));
    const client = makeClient(fetchMock, jest.fn(), secretKey);

    let caught: unknown;
    try {
      await client.get('/tasks');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WorkelApiError);
    const err = caught as WorkelApiError;
    expect(err.message).not.toContain(secretKey);
    expect(err.stack ?? '').not.toContain(secretKey);
    expect(err.code).not.toContain(secretKey);
  });

  it('never lets the API key reach err.message or err.stack when it only appears in error.message (which errors.ts ignores anyway)', async () => {
    const secretKey = 'wk_live_abc123secret';
    const body = {
      error: {
        type: 'authentication_error',
        code: 'invalid_api_key',
        message: `invalid token ${secretKey}`,
      },
    };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(401, body));
    const client = makeClient(fetchMock, jest.fn(), secretKey);

    let caught: unknown;
    try {
      await client.get('/tasks');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).not.toContain(secretKey);
    expect(err.stack ?? '').not.toContain(secretKey);
  });
});

describe('base URL normalization', () => {
  it('produces an identical request URL whether or not baseUrl has a trailing slash', async () => {
    const fetchA = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const fetchB = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const clientA = createWorkelApiClient({
      baseUrl: 'https://api.workel.com/api/public/v1',
      apiKey: API_KEY,
      fetch: fetchA as unknown as FetchLike,
      sleep: jest.fn() as unknown as SleepLike,
    });
    const clientB = createWorkelApiClient({
      baseUrl: 'https://api.workel.com/api/public/v1/',
      apiKey: API_KEY,
      fetch: fetchB as unknown as FetchLike,
      sleep: jest.fn() as unknown as SleepLike,
    });

    await clientA.get('/tasks');
    await clientB.get('/tasks');

    const urlA = fetchA.mock.calls[0][0] as string;
    const urlB = fetchB.mock.calls[0][0] as string;

    expect(urlA).toBe(urlB);
    expect(urlA).toBe('https://api.workel.com/api/public/v1/tasks');
    // No missing slash between base and path, and no double slash beyond the protocol's own "//".
    expect(urlA.slice('https://'.length)).not.toContain('//');
  });

  it('adds a leading slash to a path given without one', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    await client.get('tasks');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.workel.com/api/public/v1/tasks');
  });
});

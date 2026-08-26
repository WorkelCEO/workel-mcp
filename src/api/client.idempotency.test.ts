import {
  createWorkelApiClient,
  WorkelApiError,
  type FetchLike,
  type SleepLike,
  type WorkelApiClient,
} from './client';

// No real network anywhere in this file — `fetch` and `sleep` are always
// jest mocks injected through the factory, exactly like client.test.ts.
// These helpers are deliberately NOT imported from client.test.ts: doing so
// would re-execute that file's own top-level `describe` blocks as a side
// effect of the import, registering every one of its tests a second time.

const BASE_URL = 'https://api.workel.com/api/public/v1';
const API_KEY = 'wk_test_default_key';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const payload = body === null ? null : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

function errorEnvelope(code: string): unknown {
  return { error: { type: 'rate_limit_error', code, message: 'irrelevant — errors.ts must never read this field' } };
}

function makeClient(fetchMock: jest.Mock, sleepMock: jest.Mock = jest.fn().mockResolvedValue(undefined)): WorkelApiClient {
  return createWorkelApiClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: fetchMock as unknown as FetchLike,
    sleep: sleepMock as unknown as SleepLike,
  });
}

/** Case-insensitive lookup into the plain header object client.ts builds for `RequestInit.headers`. */
function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

function initOf(fetchMock: jest.Mock, callIndex: number): RequestInit {
  return (fetchMock.mock.calls[callIndex] as [string, RequestInit])[1];
}

/** Drains the microtask queue via a macrotask boundary — safer than counting `await Promise.resolve()` hops by hand. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('Idempotency-Key on POST', () => {
  it('auto-generates a v4 UUID when the caller supplies none', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    await client.post('/tasks', { title: 'x' });

    const key = getHeader(initOf(fetchMock, 0).headers as Record<string, string>, 'Idempotency-Key');
    expect(key).toBeDefined();
    expect(key as string).toMatch(UUID_V4_PATTERN);
  });

  it('generates a different key for each of two successive POSTs', async () => {
    // A fresh Response per call — a `Response` body can only be read once,
    // and both POSTs in this test really do call fetch (unlike most other
    // tests here, which only ever call it a single time per client).
    const fetchMock = jest.fn().mockImplementation(() => jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    await client.post('/tasks', { title: 'a' });
    await client.post('/tasks', { title: 'b' });

    const key1 = getHeader(initOf(fetchMock, 0).headers as Record<string, string>, 'Idempotency-Key');
    const key2 = getHeader(initOf(fetchMock, 1).headers as Record<string, string>, 'Idempotency-Key');
    expect(key1).not.toBe(key2);
  });

  it('sends a caller-supplied key verbatim, with no reformatting', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    await client.post('/tasks', { title: 'x' }, { idempotencyKey: 'caller-supplied-not-a-uuid' });

    const key = getHeader(initOf(fetchMock, 0).headers as Record<string, string>, 'Idempotency-Key');
    expect(key).toBe('caller-supplied-not-a-uuid');
  });

  it('reuses the identical key across a 429 retry', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, errorEnvelope('write_rate_limited'), { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const sleepMock = jest.fn().mockResolvedValue(undefined);
    const client = makeClient(fetchMock, sleepMock);

    await client.post('/tasks', { title: 'x' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const key1 = getHeader(initOf(fetchMock, 0).headers as Record<string, string>, 'Idempotency-Key');
    const key2 = getHeader(initOf(fetchMock, 1).headers as Record<string, string>, 'Idempotency-Key');
    expect(key1).toBeDefined();
    expect(key1).toBe(key2);
  });

  it('sends the request body JSON-encoded with a Content-Type header', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(201, { id: 't_1' }));
    const client = makeClient(fetchMock);

    await client.post('/tasks', { title: 'from the client' });

    const init = initOf(fetchMock, 0);
    expect(init.body).toBe(JSON.stringify({ title: 'from the client' }));
    expect(getHeader(init.headers as Record<string, string>, 'Content-Type')).toBe('application/json');
  });
});

describe('PATCH never carries Idempotency-Key', () => {
  it('has no Idempotency-Key header on the fetch call, checked case-insensitively', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    await client.patch('/tasks/t_1', { title: 'renamed' });

    const init = initOf(fetchMock, 0);
    expect(init.method).toBe('PATCH');
    expect(hasHeader(init.headers as Record<string, string>, 'Idempotency-Key')).toBe(false);
  });
});

describe(
  'replay detection derives from the Idempotent-Replay response header ' +
    '(PublicApiIdempotency.php:99 — the store-a-cached-hit branch adds it; a fresh response never carries it)',
  () => {
    it('reports replayed: true when the response carries Idempotent-Replay: true', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(jsonResponse(200, { id: 't_1' }, { 'Idempotent-Replay': 'true' }));
      const client = makeClient(fetchMock);

      const result = await client.post('/tasks', { title: 'x' });

      expect(result.replayed).toBe(true);
    });

    it('reports replayed: false on a fresh (non-replayed) POST response', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { id: 't_1' }));
      const client = makeClient(fetchMock);

      const result = await client.post('/tasks', { title: 'x' });

      expect(result.replayed).toBe(false);
    });

    it('never sets replayed on a GET or PATCH result', async () => {
      // A fresh Response per call — this test calls fetch twice (GET, then PATCH).
      const fetchMock = jest.fn().mockImplementation(() => jsonResponse(200, { id: 't_1' }));
      const client = makeClient(fetchMock);

      const getResult = await client.get('/tasks');
      const patchResult = await client.patch('/tasks/t_1', { title: 'x' });

      expect(getResult.replayed).toBeUndefined();
      expect(patchResult.replayed).toBeUndefined();
    });
  }
);

describe('write serialization: writes on one client instance run strictly sequentially', () => {
  it('does not start a second POST until the first has settled', async () => {
    let resolveFirst: (value: Response) => void = () => {
      throw new Error('resolveFirst called before assignment');
    };
    const firstDeferred = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(() => firstDeferred)
      .mockResolvedValueOnce(jsonResponse(200, { id: 'second' }));
    const client = makeClient(fetchMock);

    const firstCall = client.post('/tasks', { title: 'first' });
    const secondCall = client.post('/tasks', { title: 'second' });

    await flushMicrotasks();
    // The first write's fetch has fired (it's in flight, deferred); the
    // second write must not have started yet — it is still queued behind it.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(jsonResponse(200, { id: 'first' }));

    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstResult.data).toEqual({ id: 'first' });
    expect(secondResult.data).toEqual({ id: 'second' });
  });

  it('a GET issued while a write is in flight goes straight to fetch, bypassing the write queue', async () => {
    let resolveWrite: (value: Response) => void = () => {
      throw new Error('resolveWrite called before assignment');
    };
    const writeDeferred = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    const fetchMock = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return writeDeferred;
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    const client = makeClient(fetchMock);

    const writeCall = client.post('/tasks', { title: 'slow' });
    const readCall = client.get('/tasks');

    // The read must resolve on its own — it never joins the write queue —
    // even though the write ahead of it is still pending.
    const readResult = await readCall;
    expect(readResult.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveWrite(jsonResponse(200, { ok: true }));
    await writeCall;
  });

  it('a write that rejects does not poison the queue — the next queued write still completes', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, null))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    // Both queued back-to-back, with no await in between, so this exercises
    // the internal chain's own recovery rather than two independently
    // awaited calls that would pass even with a naive (non-recovering) queue.
    const firstCall = client.post('/tasks', { title: 'fails' });
    const secondCall = client.post('/tasks', { title: 'succeeds' });

    await expect(firstCall).rejects.toBeInstanceOf(WorkelApiError);
    const secondResult = await secondCall;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(secondResult.data).toEqual({ ok: true });
  });

  it('a write whose fetch itself rejects (network failure) does not poison the queue either', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock);

    const firstCall = client.post('/tasks', { title: 'fails' });
    const secondCall = client.post('/tasks', { title: 'succeeds' });

    await expect(firstCall).rejects.toThrow('fetch failed');
    const secondResult = await secondCall;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(secondResult.data).toEqual({ ok: true });
  });
});

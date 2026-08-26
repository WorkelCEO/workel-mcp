import {
  createWorkelApiClient,
  WorkelApiError,
  type FetchLike,
  type SleepLike,
  type WorkelApiClient,
} from './client';

/**
 * Pins two gaps closed in 0.1.1:
 *
 * 1. A REJECTED fetch never reaches `throwMappedError` (that path needs a
 *    Response), so every transport failure — DNS, TLS, socket, or this
 *    client's own deadline — arrived at the model as the bare string
 *    "fetch failed": no cause, no host, and no signal that retrying is sane.
 *
 * 2. `performWrite` lacked the empty-2xx-body guard `get()` has, so a write
 *    whose body was empty or unparseable threw a raw TypeError at the model
 *    instead of the uniform mapped error every other failure produces.
 */

const BASE_URL = 'https://api.workel.com/api/public/v1';
const API_KEY = 'wk_test_transport_key';

function makeClient(fetchMock: jest.Mock): WorkelApiClient {
  return createWorkelApiClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: fetchMock as unknown as FetchLike,
    sleep: jest.fn().mockResolvedValue(undefined) as unknown as SleepLike,
  });
}

/** The shape undici actually produces: a terse top-level message, real reason on `cause`. */
function undiciFailure(causeMessage: string): Error {
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = new Error(causeMessage);
  return err;
}

/** Awaits a call expected to reject and hands back the error, correctly typed. */
async function captureError(run: () => Promise<unknown>): Promise<WorkelApiError> {
  try {
    await run();
  } catch (e) {
    return e as WorkelApiError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('a rejected fetch becomes a mapped error, not "fetch failed"', () => {
  it('maps a DNS failure to a WorkelApiError carrying the real cause', async () => {
    const fetchMock = jest.fn().mockRejectedValue(undiciFailure('getaddrinfo ENOTFOUND api.workel.com'));

    await expect(makeClient(fetchMock).get('/tasks')).rejects.toBeInstanceOf(WorkelApiError);

    const err = await captureError(() => makeClient(fetchMock).get('/tasks'));

    expect(err.message).toContain('ENOTFOUND');
    expect(err.message).toContain('api.workel.com');
    expect(err.message).not.toBe('fetch failed');
  });

  it('marks transport failures non-terminal so the model retries rather than giving up', async () => {
    const fetchMock = jest.fn().mockRejectedValue(undiciFailure('ECONNREFUSED'));

    const err = await captureError(() => makeClient(fetchMock).get('/tasks'));

    expect(err.terminal).toBe(false);
  });

  it('names the client deadline when the request times out, rather than reporting a bare abort', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const fetchMock = jest.fn().mockRejectedValue(timeout);

    const err = await captureError(() => makeClient(fetchMock).get('/tasks'));

    expect(err.message).toMatch(/timeout/i);
    expect(err.message).toContain('30s');
    expect(err.terminal).toBe(false);
  });

  it('never puts the API key into a transport error message', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValue(new TypeError(`Headers.append: "Bearer ${API_KEY}" is an invalid header value.`));

    const err = await captureError(() => makeClient(fetchMock).get('/tasks'));

    // The message is built from the host + cause, never from the raw throwable's
    // text, so the header value cannot ride along.
    expect(err.message).not.toContain(API_KEY);
  });

  it('still returns normally when fetch resolves — the wrapper adds no behaviour on the happy path', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await expect(makeClient(fetchMock).get('/tasks')).resolves.toMatchObject({ data: { data: [] } });
  });
});

describe('writes get the same empty-2xx-body guard reads have', () => {
  it('throws a mapped error, not a TypeError, when a 2xx write body is unparseable', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const err = await captureError(() => makeClient(fetchMock).post('/tasks', { title_text: 'x' }));

    expect(err).toBeInstanceOf(WorkelApiError);
    expect(err.terminal).toBe(false);
    expect(err.message).not.toMatch(/Cannot read propert/);
  });

  it('applies the same guard to PATCH', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const err = await captureError(() => makeClient(fetchMock).patch('/tasks/abc', { title_text: 'x' }));

    expect(err).toBeInstanceOf(WorkelApiError);
  });

  it('a well-formed write still succeeds — the guard does not reject valid bodies', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'task_1' }), { status: 201 }));

    await expect(makeClient(fetchMock).post('/tasks', { title_text: 'x' })).resolves.toMatchObject({
      data: { id: 'task_1' },
    });
  });
});

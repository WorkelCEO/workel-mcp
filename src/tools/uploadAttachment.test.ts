import { createWorkelApiClient, type FetchLike, type SleepLike } from '../api/client';
import { workelUploadTaskAttachment } from './uploadAttachment';

const BASE_URL = 'https://api.test/api/public/v1';

function itemResponse(status: number, record: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data: record }), { status, headers });
}

function makeClient(fetchMock: jest.Mock) {
  return createWorkelApiClient({
    baseUrl: BASE_URL,
    apiKey: 'wk_test_key',
    fetch: fetchMock as unknown as FetchLike,
    sleep: jest.fn() as unknown as SleepLike,
  });
}

function lastRequest(fetchMock: jest.Mock): { url: URL; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalled();
  const calls = fetchMock.mock.calls as [string, RequestInit][];
  const [url, init] = calls[calls.length - 1];
  return { url: new URL(url), init };
}

/** The FormData actually handed to fetch on the most recent call. */
function sentForm(fetchMock: jest.Mock): FormData {
  const { init } = lastRequest(fetchMock);
  expect(init.body).toBeInstanceOf(FormData);
  return init.body as FormData;
}

/** The `file` part, as the Blob/File the server will receive. */
async function sentFile(fetchMock: jest.Mock): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  const part = sentForm(fetchMock).get('file');
  expect(part).toBeInstanceOf(Blob);
  const blob = part as File;
  return {
    name: blob.name,
    type: blob.type,
    bytes: new Uint8Array(await blob.arrayBuffer()),
  };
}

function wireAttachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'att_1',
    name: 'notes.md',
    url: 'https://blob.test/attachments/notes.md',
    type: 'text/markdown',
    size: 12,
    uploaded_by: { id: 'u_1', name: 'Ada' },
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('workel_upload_task_attachment', () => {
  it('requires the write:attachments scope, not write:tasks', () => {
    // The whole reason the scope is separate: a key that can edit tasks must
    // not gain the ability to spend the workspace's storage.
    const descriptor = workelUploadTaskAttachment(makeClient(jest.fn()));

    expect(descriptor.scope).toBe('write:attachments');
  });

  it('sets the annotations honestly for a non-idempotent create', () => {
    const descriptor = workelUploadTaskAttachment(makeClient(jest.fn()));

    expect(descriptor.annotations).toEqual({
      title: 'Upload task attachment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('does not declare a fake-safety confirm input parameter', () => {
    const descriptor = workelUploadTaskAttachment(makeClient(jest.fn()));

    expect(Object.prototype.hasOwnProperty.call(descriptor.inputSchema, 'confirm')).toBe(false);
  });

  describe('the multipart request', () => {
    it('POSTs to /tasks/{id}/attachments with the content as the file part', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', filename: 'notes.md', content: '# Notes\n' });

      const { url, init } = lastRequest(fetchMock);
      expect(url.pathname).toBe('/api/public/v1/tasks/t_1/attachments');
      expect(init.method).toBe('POST');

      const file = await sentFile(fetchMock);
      expect(file.name).toBe('notes.md');
      expect(Buffer.from(file.bytes).toString('utf8')).toBe('# Notes\n');
    });

    it('never sets Content-Type itself, so fetch supplies the multipart boundary', async () => {
      // Setting it by hand is the reflex — every other write on this client
      // does — and it produces a header with no boundary, which PHP cannot
      // parse: it reports zero files and the endpoint 422s on a file that
      // was in fact sent.
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', filename: 'notes.md', content: '# Notes\n' });

      const headers = lastRequest(fetchMock).init.headers as Record<string, string>;
      const contentTypeKeys = Object.keys(headers).filter((k) => /^content-type$/i.test(k));
      expect(contentTypeKeys).toEqual([]);
    });

    it('still sends Authorization', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', filename: 'notes.md', content: '# Notes\n' });

      const headers = lastRequest(fetchMock).init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer wk_test_key');
    });

    it('url-encodes the task id', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({ id: 'a/b c', filename: 'notes.md', content: 'x' });

      expect(lastRequest(fetchMock).url.pathname).toBe('/api/public/v1/tasks/a%2Fb%20c/attachments');
    });

    it('sends the caller-supplied content_type, and octet-stream when none is given', async () => {
      // mockImplementation, not mockResolvedValue: this test makes TWO calls,
      // and a Response body can only be read once.
      const fetchMock = jest.fn().mockImplementation(() => itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', filename: 'notes.md', content: 'x' });
      expect((await sentFile(fetchMock)).type).toBe('application/octet-stream');

      await descriptor.handler({
        id: 't_1',
        filename: 'notes.md',
        content: 'x',
        content_type: 'text/markdown',
      });
      expect((await sentFile(fetchMock)).type).toBe('text/markdown');
    });
  });

  describe('encoding', () => {
    it('treats content as utf8 by default, preserving multi-byte characters', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', filename: 'notes.md', content: '# Café — naïve ✅\n' });

      const file = await sentFile(fetchMock);
      expect(Buffer.from(file.bytes).toString('utf8')).toBe('# Café — naïve ✅\n');
      // Byte length, not character length: the point of decoding properly.
      expect(file.bytes.length).toBe(Buffer.byteLength('# Café — naïve ✅\n', 'utf8'));
    });

    it('decodes base64 content to the original bytes', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));
      const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      await descriptor.handler({
        id: 't_1',
        filename: 'tiny.png',
        content: original.toString('base64'),
        encoding: 'base64',
      });

      const file = await sentFile(fetchMock);
      expect(Buffer.from(file.bytes).equals(original)).toBe(true);
    });

    it('rejects content that is not really base64 instead of storing garbage', async () => {
      // Buffer.from(x, 'base64') silently DISCARDS out-of-alphabet
      // characters, so without the re-encode check this would upload a file
      // full of nonsense and report success.
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await expect(
        descriptor.handler({
          id: 't_1',
          filename: 'notes.md',
          content: '# This is plainly not base64!',
          encoding: 'base64',
        })
      ).rejects.toThrow(/not valid base64/i);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('tolerates whitespace/newlines inside base64', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));
      const original = Buffer.from('hello world, this is a longer payload to wrap');
      const wrapped = original.toString('base64').replace(/(.{8})/g, '$1\n');

      await descriptor.handler({
        id: 't_1',
        filename: 'note.txt',
        content: wrapped,
        encoding: 'base64',
      });

      expect(Buffer.from((await sentFile(fetchMock)).bytes).equals(original)).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('forwards a caller-supplied idempotency_key verbatim', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({
        id: 't_1',
        filename: 'notes.md',
        content: 'x',
        idempotency_key: 'my-key-1',
      });

      const headers = lastRequest(fetchMock).init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('my-key-1');
    });

    it('generates one when the caller omits it', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await descriptor.handler({ id: 't_1', filename: 'notes.md', content: 'x' });

      const headers = lastRequest(fetchMock).init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('reports replayed: true when the server says the response was replayed', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(itemResponse(201, wireAttachment(), { 'Idempotent-Replay': 'true' }));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      const result = await descriptor.handler({ id: 't_1', filename: 'notes.md', content: 'x' });

      expect(JSON.parse(result.content[0].text as string).replayed).toBe(true);
    });

    it('reports replayed: false for a fresh upload', async () => {
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      const result = await descriptor.handler({ id: 't_1', filename: 'notes.md', content: 'x' });

      expect(JSON.parse(result.content[0].text as string).replayed).toBe(false);
    });
  });

  describe('response mapping', () => {
    it('returns the attachment from inside the {data: ...} envelope', async () => {
      // Mocking the bare record instead of the envelope is what let an
      // earlier envelope bug ship across this whole client.
      const fetchMock = jest.fn().mockResolvedValue(itemResponse(201, wireAttachment()));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      const result = await descriptor.handler({ id: 't_1', filename: 'notes.md', content: 'x' });
      const payload = JSON.parse(result.content[0].text as string);

      expect(payload).toEqual({
        id: 'att_1',
        name: 'notes.md',
        url: 'https://blob.test/attachments/notes.md',
        type: 'text/markdown',
        size: 12,
        uploaded_by: { id: 'u_1', name: 'Ada' },
        created_at: '2026-01-01T00:00:00Z',
        replayed: false,
      });
    });

    it('maps a null uploader without inventing one', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(itemResponse(201, wireAttachment({ uploaded_by: null })));
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      const result = await descriptor.handler({ id: 't_1', filename: 'notes.md', content: 'x' });

      expect(JSON.parse(result.content[0].text as string).uploaded_by).toBeNull();
    });
  });

  describe('upstream errors', () => {
    it.each([
      [403, 'storage_quota_exceeded'],
      [404, 'not_found'],
      [409, 'idempotency_key_reuse'],
      [422, 'validation_error'],
    ])('surfaces a %s (%s) as a thrown mapped error', async (status, code) => {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { type: 'x', code, message: 'nope' } }), { status })
      );
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      await expect(
        descriptor.handler({ id: 't_1', filename: 'notes.md', content: 'x' })
      ).rejects.toThrow();
    });

    it('never leaks the API key into a thrown error', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { type: 'x', code: 'wk_test_key', message: 'leaked wk_test_key' } }),
          { status: 422 }
        )
      );
      const descriptor = workelUploadTaskAttachment(makeClient(fetchMock));

      const thrown = await descriptor
        .handler({ id: 't_1', filename: 'notes.md', content: 'x' })
        .then(() => null)
        .catch((err: Error) => err);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain('wk_test_key');
      expect((thrown as Error).stack ?? '').not.toContain('wk_test_key');
    });
  });
});

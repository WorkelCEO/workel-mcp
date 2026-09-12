/**
 * The single HTTP seam between every MCP tool and the Workel Public API v1.
 *
 * This is where the server's core invariant is enforced: a curl user
 * holding the same API key has exactly the same power as any tool built on
 * this client, no more. The key travels ONLY in the `Authorization` header
 * — never in the URL, never in the query string, never in any other
 * header — and tenancy/scope come entirely from what the server resolves
 * for that key server-side. This client never adds anything to a request
 * that widens what a curl user with the same key could already do.
 *
 * `fetch` and `sleep` are constructor-injected (never read from a
 * global/module scope, never from `process.env`) so every behaviour below
 * — retry timing, header shape, redaction — is testable with no real
 * network call. `createWorkelApiClientFromEnv` is the only place that
 * reaches for the real `fetch` and `src/config.ts`'s environment loading,
 * and only for production wiring; no test needs it.
 *
 * Writes (T9): every POST carries an `Idempotency-Key` header — either the
 * caller's own value, sent verbatim with no reformatting, or (when the
 * caller supplies none) a fresh v4 UUID from `node:crypto`'s
 * `randomUUID()`. That key is generated exactly ONCE per logical `post()`
 * call, above `fetchWithRetry`'s own 429-retry loop, and reused unchanged
 * on the retried attempt — a retried write is provably the same request as
 * far as the server's idempotency store is concerned. PATCH never carries
 * the header at all: read `PublicApiIdempotency::handle()`
 * (`backend/services/laravel-backend/app/Http/Middleware/PublicApi/PublicApiIdempotency.php:65-67`)
 * — it early-returns for any method other than POST — so sending the
 * header on PATCH would only invite a caller to assume a guarantee the
 * server does not provide there.
 *
 * Replay detection: on a cache hit, that same middleware returns the
 * stored response WITH an added `Idempotent-Replay: true` header
 * (PublicApiIdempotency.php:97-99); a freshly-executed response carries no
 * such header. That is a genuinely distinguishable signal, so this client
 * reads it directly rather than keeping any idempotency bookkeeping of its
 * own — the middleware is the sole source of truth for whether a given
 * response was served from its store. (The middleware's OTHER branch — the
 * same key reused with a DIFFERENT body — is a 409 `idempotency_error`,
 * handled by the ordinary error path below, not by this flag; see
 * PublicApiIdempotency.php:86-95.)
 *
 * Write serialization: POST and PATCH issued through one client instance
 * run strictly sequentially, chained on a closure-scoped promise so a
 * second write never starts until the first has settled — success or
 * failure; a rejected write does not block the next one. This is a
 * PER-PROCESS guarantee only. It says nothing about two separate processes
 * (or two separate client instances) racing the same Idempotency-Key —
 * that residual window is exactly what the server's 24h idempotency-record
 * cache exists to close, not this client. GET never joins this queue: a
 * read issued while a write is in flight goes straight to `fetch`.
 */

import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config';
import { redact } from './redact';
import { mapApiError, type MappedApiError, NO_ENVELOPE_CODE } from './errors';

export type FetchLike = typeof fetch;
export type SleepLike = (ms: number) => Promise<void>;

/** Default per-attempt request deadline. Generous for a JSON API, far below undici's 300s default. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface WorkelApiClientDeps {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  sleep: SleepLike;
  /**
   * Per-attempt request deadline. Without one, a stalled upstream (TCP open,
   * no response) hangs the tool call — and therefore the model's turn —
   * until undici's 300s default, with `boot()` awaiting the same stall
   * before the transport exists. A fresh signal is built per attempt so the
   * 429 retry gets a full budget rather than the remainder of the first.
   */
  timeoutMs?: number;
}

/**
 * Values are stringified and included; `undefined` values are omitted
 * entirely rather than serialized as the literal string `"undefined"`.
 */
export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface WorkelApiResult<T> {
  data: T;
  requestId: string | null;
  /**
   * Present ONLY on a `post()` result — `true` when the response was
   * served from the server's idempotency store rather than freshly
   * executed (`Idempotent-Replay: true`, PublicApiIdempotency.php:99),
   * `false` when it was freshly executed. Left unset (never `true` or
   * `false`) on `get()`/`patch()` results, since neither ever carries an
   * `Idempotency-Key` and so neither can ever be a replay.
   */
  replayed?: boolean;
}

export interface WorkelApiWriteOptions {
  /**
   * Caller-supplied `Idempotency-Key`, sent verbatim — no trimming, no
   * case change, no reformatting, and no validation that it looks like a
   * UUID. Omit to have this client generate a fresh v4 UUID automatically.
   */
  idempotencyKey?: string;
}

export interface WorkelApiClient {
  get<T = unknown>(path: string, query?: QueryParams): Promise<WorkelApiResult<T>>;
  post<T = unknown>(path: string, body?: unknown, options?: WorkelApiWriteOptions): Promise<WorkelApiResult<T>>;
  /**
   * `multipart/form-data` POST — the upload path. Shares every behaviour
   * `post` has (write queue, 429 retry, error mapping, replay detection,
   * body-parse guard) and differs only in how the body is framed.
   */
  postFile<T = unknown>(
    path: string,
    file: UploadPart,
    options?: WorkelApiWriteOptions
  ): Promise<WorkelApiResult<T>>;
  /** Never carries `Idempotency-Key` — see the file-level docblock. */
  patch<T = unknown>(path: string, body?: unknown): Promise<WorkelApiResult<T>>;
}

/**
 * One file part of a multipart upload.
 *
 * `fieldName` defaults to `file`, which is what every current upload route
 * expects; it is a parameter rather than a constant so a future endpoint
 * naming its part differently does not need a second client method.
 */
export interface UploadPart {
  fieldName?: string;
  fileName: string;
  bytes: Uint8Array;
  contentType?: string;
}

/** A 429 is retried at most once, and only after waiting this long — never more, regardless of what `Retry-After` asked for. */
const MAX_RETRY_AFTER_SECONDS = 60;

const REQUEST_ID_HEADER = 'x-request-id';
const RETRY_AFTER_HEADER = 'retry-after';
const REPLAY_HEADER = 'idempotent-replay';

/**
 * Thrown for every non-2xx response. Wraps `errors.ts`'s pure, network-free
 * mapping with the one thing that module deliberately has no knowledge of:
 * the API key. Redaction happens here, not there, because only this module
 * knows the key.
 */
export class WorkelApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly terminal: boolean;
  readonly requestId: string | null;

  constructor(mapped: MappedApiError) {
    super(mapped.message);
    this.name = 'WorkelApiError';
    this.code = mapped.code;
    this.status = mapped.status;
    this.terminal = mapped.terminal;
    this.requestId = mapped.requestId;
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

/**
 * `baseUrl` with/without a trailing slash must produce an identical request
 * URL, and `path` with/without a leading slash must too — both are
 * normalized here, once, rather than trusted to whatever a given call site
 * happened to pass.
 */
function buildRequestUrl(baseUrl: string, path: string, query?: QueryParams): string {
  const url = new URL(`${stripTrailingSlashes(baseUrl)}${ensureLeadingSlash(path)}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

/**
 * Parses `Retry-After` as a finite, non-negative integer number of seconds,
 * clamped to `MAX_RETRY_AFTER_SECONDS`. Anything else — missing, an
 * HTTP-date, a decimal, a negative number, empty — is treated as
 * unparseable and returns `null`; the caller must not retry (let alone
 * sleep(0)) on unparseable input, only on a header it can actually honor.
 */
function parseRetryAfterSeconds(headerValue: string | null): number | null {
  if (headerValue === null) return null;

  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return null; // rejects HTTP-dates, decimals, negatives, and blanks

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return null; // guards a digit string long enough to overflow to Infinity

  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Reads the body as text and attempts a JSON parse. A body that isn't valid
 * JSON (or is empty) becomes `null` rather than throwing — `errors.ts`'s
 * envelope check already tolerates any non-object body (it's exactly the
 * shape an uncaught server `\Throwable`'s fallback text, or a genuinely
 * empty body, produces), so there's nothing gained by surfacing the raw
 * unparsed text here, and doing so is exactly the kind of "upstream body
 * text" this module must not let leak into an error unredacted.
 */
async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Guards the 2xx path: `readResponseBody` collapses an empty or unparseable
 * body to `null`, which is indistinguishable from a legitimately-null field
 * once it reaches a tool. Throwing a mapped, retryable error instead means
 * the failure reads the same as every other API failure.
 */
/** Hostname only — never the full URL, which can carry caller-supplied path segments. */
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the Workel API';
  }
}

/**
 * Converts a rejected `fetch` into the same `WorkelApiError` shape every other
 * failure produces. Always `terminal: false` — DNS, TLS, socket and deadline
 * failures are transient by nature, and telling the model so is the difference
 * between it retrying sensibly and it giving up or hammering.
 */
function transportError(err: unknown, host: string, timeoutMs: number): WorkelApiError {
  const name = err instanceof Error ? err.name : '';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';

  // `err.cause` is where undici puts the real reason (ENOTFOUND, ECONNREFUSED,
  // CERT_HAS_EXPIRED); the top-level message is almost always just "fetch failed".
  // `cause` is ES2022; this package targets lower, so read it structurally
  // rather than widening the whole build's lib for one field.
  const rawCause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const cause = rawCause instanceof Error ? rawCause.message : '';
  // Redact at construction, not just at the tool boundary: when the throwable
  // has no `cause` we fall back to its own message, and undici puts the entire
  // Authorization header value in that message for a header-illegal key.
  const detail = redact(cause || (err instanceof Error ? err.message : String(err)));

  const message = isTimeout
    ? `The request to ${host} exceeded this client's ${Math.round(timeoutMs / 1000)}s timeout before a response arrived. This is a network or server-side delay, not a problem with your request — retrying shortly is reasonable.`
    : `Could not reach ${host}: ${detail}. This is a network-level failure, not a problem with your request — check connectivity and retry shortly.`;

  return new WorkelApiError({
    code: NO_ENVELOPE_CODE,
    status: 0,
    terminal: false,
    requestId: null,
    message,
  });
}

function assertParsedBody(body: unknown, requestId: string | null): void {
  if (body !== null) return;
  const suffix = requestId === null ? '' : ` (request_id: ${requestId})`;
  throw new WorkelApiError({
    code: NO_ENVELOPE_CODE,
    status: 200,
    // Not terminal: an empty/unreadable body from a 2xx is a transient
    // server-side fault, so retrying this exact request is reasonable.
    terminal: false,
    requestId,
    message: `The Workel API returned a successful status with an empty or unreadable body. This is a server-side problem, not a problem with your request — retrying shortly is reasonable.${suffix}`,
  });
}

function extractRequestId(response: Response): string | null {
  const value = response.headers.get(REQUEST_ID_HEADER);
  return value && value.length > 0 ? value : null;
}

/** `true` only when the response carries `Idempotent-Replay: true` (PublicApiIdempotency.php:99). */
function isReplayedResponse(response: Response): boolean {
  return response.headers.get(REPLAY_HEADER) === 'true';
}

export function createWorkelApiClient(deps: WorkelApiClientDeps): WorkelApiClient {
  const { baseUrl, apiKey, fetch: doFetch, sleep } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /** Wraps `doFetch` with a fresh per-attempt deadline (see `timeoutMs`). */
  async function fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // A rejected fetch never reaches throwMappedError (that path needs a
      // Response), so without this every transport failure arrived at the model
      // as the bare string "fetch failed" — no cause, no context, and no signal
      // that retrying is reasonable. Never let the raw throwable through: undici
      // embeds the whole Authorization header value in a header-illegal-value
      // TypeError.
      throw transportError(err, extractHostname(url), timeoutMs);
    }
  }

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };

  /**
   * Per-instance write queue. Every `post`/`patch` call chains its work
   * onto this promise so writes on ONE client execute strictly
   * sequentially. The tail re-attached to `writeQueue` on every call
   * always swallows (`() => undefined` on both branches) so a rejected
   * write can never poison the chain for the next queued write — the
   * caller's OWN returned promise (`result` below) still rejects
   * normally; only the shared continuation is laundered back to settled.
   */
  let writeQueue: Promise<void> = Promise.resolve();

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task, task);
    writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Issues `init` against `url`, retrying exactly once on a 429 whose
   * `Retry-After` this client can actually honor. `init` (including any
   * `Idempotency-Key` header a write call built) is reused UNCHANGED on
   * the retried attempt — the retry is provably the same request.
   */
  async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let response = await fetchWithDeadline(url, init);

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get(RETRY_AFTER_HEADER));
      // Retry exactly once, and only when the header gave us something we
      // can actually honor. A second 429 (or anything else) after the
      // retry falls straight through to the caller — there is no second
      // retry regardless of what the second response's headers say.
      if (retryAfterSeconds !== null) {
        await sleep(retryAfterSeconds * 1000);
        response = await fetchWithDeadline(url, init);
      }
    }

    return response;
  }

  async function throwMappedError(response: Response): Promise<never> {
    const body = await readResponseBody(response);
    const requestId = extractRequestId(response);
    const mapped = mapApiError(response.status, body, requestId);

    // Redact BEFORE constructing the error, not after: `Error`'s `.stack`
    // embeds `.message` as its first line at construction time, so a
    // post-construction redaction of `.message` alone would still leave
    // the secret sitting in `.stack`. `code` is redacted too — an
    // unrecognized wire `code` is untrusted, attacker/record-controlled
    // text (see errors.ts's docblock) that `mapped.message` already
    // interpolates verbatim, so the same secret can reach both fields.
    const safeMapped: MappedApiError = {
      ...mapped,
      code: redact(mapped.code, [apiKey]),
      message: redact(mapped.message, [apiKey]),
    };

    throw new WorkelApiError(safeMapped);
  }

  async function get<T = unknown>(path: string, query?: QueryParams): Promise<WorkelApiResult<T>> {
    const url = buildRequestUrl(baseUrl, path, query);
    const response = await fetchWithRetry(url, { method: 'GET', headers: requestHeaders });

    if (!response.ok) {
      return throwMappedError(response);
    }

    const body = await readResponseBody(response);
    // A 2xx whose body is empty or unparseable is a broken response, not
    // data. Returning null here made eight tools dereference it and throw a
    // raw TypeError at the model; failing at the seam keeps every tool's
    // error path uniform and legible.
    assertParsedBody(body, extractRequestId(response));
    // `body` is returned verbatim — including a `next_cursor` field, if the
    // endpoint's shape has one — with no decode/re-encode/validation step;
    // it is an opaque token as far as this client is concerned.
    return { data: body as T, requestId: extractRequestId(response) };
  }

  async function performWrite<T>(
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
    idempotencyKey: string | null
  ): Promise<WorkelApiResult<T>> {
    const hasBody = body !== undefined;

    const headers: Record<string, string> = { ...requestHeaders };
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;

    return sendWrite<T>(method, path, headers, hasBody ? JSON.stringify(body) : undefined);
  }

  /**
   * The multipart sibling of performWrite.
   *
   * Content-Type is deliberately NOT set: `fetch` derives it from the
   * FormData body, and the value it derives carries the multipart BOUNDARY.
   * Setting it by hand — the reflex, since every other write here sets it —
   * produces a header with no boundary, which the server cannot parse; PHP
   * then reports zero fields and zero files and the endpoint 422s on a
   * "missing" file that was in fact sent. (The web app hit exactly this:
   * CLAUDE.md §57.3.)
   */
  async function performMultipartWrite<T>(
    path: string,
    file: UploadPart,
    idempotencyKey: string | null
  ): Promise<WorkelApiResult<T>> {
    const headers: Record<string, string> = { ...requestHeaders };
    if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;

    const form = new FormData();
    // `bytes.slice()` hands Blob a plain ArrayBuffer of exactly this view's
    // range — a Uint8Array over a larger/pooled buffer would otherwise
    // contribute the WHOLE buffer to the part.
    const blob = new Blob([file.bytes.slice()], {
      type: file.contentType ?? 'application/octet-stream',
    });
    form.append(file.fieldName ?? 'file', blob, file.fileName);

    return sendWrite<T>('POST', path, headers, form);
  }

  async function sendWrite<T>(
    method: 'POST' | 'PATCH',
    path: string,
    headers: Record<string, string>,
    // Not `BodyInit`: that type ships with the DOM lib, and this project
    // compiles against lib ES2020 + @types/node. The union is exactly what
    // the two callers pass.
    body: string | FormData | undefined
  ): Promise<WorkelApiResult<T>> {
    const url = buildRequestUrl(baseUrl, path);

    const response = await fetchWithRetry(url, { method, headers, body });

    if (!response.ok) {
      return throwMappedError(response);
    }

    const responseBody = await readResponseBody(response);
    // Same guard `get()` applies at its own seam: a 2xx with an empty or
    // unparseable body is a broken response, not data. Without this the four
    // write tools dereference null and throw a raw TypeError at the model
    // instead of the uniform mapped error every other failure produces.
    assertParsedBody(responseBody, extractRequestId(response));
    const result: WorkelApiResult<T> = { data: responseBody as T, requestId: extractRequestId(response) };

    if (method === 'POST') {
      result.replayed = isReplayedResponse(response);
    }

    return result;
  }

  async function post<T = unknown>(
    path: string,
    body?: unknown,
    options?: WorkelApiWriteOptions
  ): Promise<WorkelApiResult<T>> {
    // Generated ONCE per logical call, above fetchWithRetry's own 429-retry
    // loop — a caller-supplied key is honored verbatim; an auto-generated
    // one is reused unchanged on a retried attempt.
    const idempotencyKey = options?.idempotencyKey ?? randomUUID();
    return enqueueWrite(() => performWrite<T>('POST', path, body, idempotencyKey));
  }

  async function postFile<T = unknown>(
    path: string,
    file: UploadPart,
    options?: WorkelApiWriteOptions
  ): Promise<WorkelApiResult<T>> {
    // Same one-key-per-logical-call rule as post(): generated above the
    // retry loop so a retried attempt reuses it unchanged. It matters more
    // here — a retried upload without a stable key stores the file twice.
    const idempotencyKey = options?.idempotencyKey ?? randomUUID();
    return enqueueWrite(() => performMultipartWrite<T>(path, file, idempotencyKey));
  }

  async function patch<T = unknown>(path: string, body?: unknown): Promise<WorkelApiResult<T>> {
    // Never carries Idempotency-Key: PublicApiIdempotency::handle() only
    // inspects POST (PublicApiIdempotency.php:65-67).
    return enqueueWrite(() => performWrite<T>('PATCH', path, body, null));
  }

  return { get, post, postFile, patch };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Production wiring: builds a client from `loadConfig`'s environment-driven
 * configuration and the real global `fetch`. This is how the MCP
 * entrypoint constructs the real client — `createWorkelApiClient` above is
 * the seam every test injects into instead; no test in this project needs
 * this function.
 */
export function createWorkelApiClientFromEnv(env: NodeJS.ProcessEnv = process.env): WorkelApiClient {
  const config = loadConfig(env);
  return createWorkelApiClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch,
    sleep: defaultSleep,
  });
}

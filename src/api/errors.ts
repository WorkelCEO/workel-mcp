/**
 * Turns a Public API v1 error response into text an LLM tool-caller can act
 * on. Pure and network-free — it only inspects the `status`/`body` a caller
 * already received; it never makes a request.
 *
 * Matches on `error.code` ONLY, never on `error.message`. The upstream
 * `message` is documented as "not intended for stable string matching —
 * match on `code`" (OpenAPI spec, ErrorEnvelope.code description) and is
 * never read by this module for ANY purpose — not for matching, and not
 * for interpolation into the text this module produces. `message` (and any
 * unrecognized `code`, which is untrusted input the same way) could contain
 * attacker- or record-controlled text (e.g. a workspace name laundered into
 * a validation message); the tool-facing text this module emits never
 * repeats it back verbatim (D8).
 *
 * `API_ERROR_CODES` below is a hand-derived snapshot of every
 * `ErrorEnvelope::make(...)` call site in
 * `backend/services/laravel-backend/app/` as of the commit this file was
 * written against (grepped directly, then cross-checked against the `code`
 * enum documented in
 * `backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:445-457`,
 * which itself is explicitly "non-exhaustive — new codes may be added
 * without a version bump"). The test suite proves every code in that array
 * has a message mapped — it proves internal consistency of this file, NOT
 * that the array still matches the live API. Re-derive it by re-running the
 * grep in this file's header the next time this module is touched.
 *
 * The one response shape this module must also tolerate is NOT the
 * envelope at all: an uncaught `\Throwable` inside the Laravel app never
 * reaches `ErrorEnvelope::make()` (`app/Exceptions/Handler.php:429-432`
 * returns `null` for anything that isn't a `ValidationException` or an
 * `HttpException`, which is Laravel's signal to fall through to its own
 * default JSON rendering — `{"message":"Server Error"}` in production, with
 * no `error` key and, because `AttachRequestId`'s post-`$next()` header
 * write never runs on an exception-unwound path either, typically no
 * `X-Request-Id` header). `mapApiError` must produce a sane result for that
 * shape too, without throwing.
 */

/** Character class an untrusted string is reduced to before ever appearing in output text. */
const SAFE_TOKEN_PATTERN = /[^A-Za-z0-9_.:-]/g;

/** Shared cap for both an unrecognized `code` and a `request_id` — see `sanitizeUntrustedToken`. */
const MAX_TOKEN_LENGTH = 64;

/**
 * Strips `value` to `SAFE_TOKEN_PATTERN` and truncates to `MAX_TOKEN_LENGTH`.
 * Used for anything that reaches this module from the wire and is destined
 * to be interpolated into a tool-facing message: an unrecognized `code`, and
 * a `request_id` (caller-supplied header OR envelope body — both are just as
 * untrusted as any other wire value, regardless of how well-behaved the
 * server that is supposed to have generated them is meant to be).
 * Returns `null` when `value` isn't a non-empty string, or when nothing
 * survives stripping (e.g. a value made entirely of disallowed characters).
 */
function sanitizeUntrustedToken(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const stripped = value.replace(SAFE_TOKEN_PATTERN, '');
  if (stripped.length === 0) return null;
  return stripped.length > MAX_TOKEN_LENGTH ? stripped.slice(0, MAX_TOKEN_LENGTH) : stripped;
}

// ---------------------------------------------------------------------------
// The code inventory. One entry per distinct `code` string passed to
// `ErrorEnvelope::make(...)` anywhere under `backend/services/laravel-backend/app/`.
// `status`/`type` are read from the same call site as the code (`type` is
// the envelope's broad category — `authentication_error` / `permission_error`
// / `invalid_request_error` / `rate_limit_error` / `idempotency_error` — per
// the OpenAPI ErrorEnvelope.type description, cross-checked against every
// citation below and consistent in every case).
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  // auth:api-key guard itself has no token / an unparseable one — the ONLY
  // interception point for that failure on /api/public/v1/* per the
  // docblock on Authenticate::unauthenticated() (Laravel's exception
  // Handler special-cases HttpResponseException and returns this verbatim
  // before Handler.php is ever consulted).
  { code: 'invalid_api_key', status: 401, type: 'authentication_error' }, // app/Http/Middleware/Authenticate.php:44-52

  // A key resolved by the guard, but it isn't a WorkspaceApiKey instance —
  // i.e. no usable key at all. Two independent middleware emit the same code.
  { code: 'api_key_required', status: 401, type: 'authentication_error' }, // app/Http/Middleware/PublicApi/RequireAnyApiKey.php:31-39, app/Http/Middleware/EnsureApiKeyScope.php:34-36

  // The key resolved fine but WorkspaceApiKey::isActive() is false (revoked/disabled).
  { code: 'api_key_disabled', status: 403, type: 'permission_error' }, // app/Http/Middleware/PublicApi/RequireAnyApiKey.php:41-49, app/Http/Middleware/EnsureApiKeyScope.php:38-40

  // Per-route scope assertion: the key's token doesn't carry the ability this route requires.
  { code: 'scope_required', status: 403, type: 'permission_error' }, // app/Http/Middleware/EnsureApiKeyScope.php:48-50

  // Default-deny terminal: a route that asserted no scope middleware at all.
  { code: 'scope_not_asserted', status: 403, type: 'permission_error' }, // app/Http/Middleware/RequireAssertedApiKeyScope.php:26-29

  // Authenticated + correctly scoped, but denied at the per-project permission layer.
  { code: 'forbidden', status: 403, type: 'permission_error' }, // app/Http/Controllers/Api/PublicApi/V1/TasksController.php:243-252

  // FormRequest field validation failure. Emitted from every write FormRequest's failedValidation().
  { code: 'validation_error', status: 422, type: 'invalid_request_error' }, // app/Http/Requests/PublicApi/V1/StorePublicTaskRequest.php:88-91, UpdatePublicTaskRequest.php:82-85, StorePublicTaskCommentRequest.php:58-61, StorePublicEventRequest.php:125-128

  { code: 'no_open_column', status: 422, type: 'invalid_request_error' }, // app/Http/Controllers/Api/PublicApi/V1/TasksController.php:254-270

  { code: 'invalid_assignee', status: 422, type: 'invalid_request_error' }, // app/Http/Controllers/Api/PublicApi/V1/TasksController.php:273-286

  { code: 'inbox_project', status: 422, type: 'invalid_request_error' }, // app/Http/Controllers/Api/PublicApi/V1/TasksController.php:345-356

  { code: 'invalid_date', status: 422, type: 'invalid_request_error' }, // app/Http/Controllers/Api/PublicApi/V1/EventsController.php:183-195

  { code: 'window_too_large', status: 422, type: 'invalid_request_error' }, // app/Http/Controllers/Api/PublicApi/V1/EventsController.php:198-207

  // Resource lookup miss OR the caller's key can't see it — no existence oracle by design.
  { code: 'not_found', status: 404, type: 'invalid_request_error' }, // app/Http/Controllers/Api/PublicApi/V1/TasksController.php:466-469, TaskCommentsController.php:135-138, ProjectsController.php:95-98

  { code: 'idempotency_key_reuse', status: 409, type: 'idempotency_error' }, // app/Http/Middleware/PublicApi/PublicApiIdempotency.php:86-95

  { code: 'key_rate_limited', status: 429, type: 'rate_limit_error' }, // app/Providers/RouteServiceProvider.php:179-184
  { code: 'workspace_rate_limited', status: 429, type: 'rate_limit_error' }, // app/Providers/RouteServiceProvider.php:185-190
  { code: 'write_rate_limited', status: 429, type: 'rate_limit_error' }, // app/Providers/RouteServiceProvider.php:206-214
  { code: 'anonymous_rate_limited', status: 429, type: 'rate_limit_error' }, // app/Providers/RouteServiceProvider.php:236-243
] as const;

export type KnownApiErrorCode = (typeof API_ERROR_CODES)[number]['code'];

/**
 * One model-actionable message per known code. Deliberately never reads
 * `error.message` from the wire — every string below is fully static,
 * written from the code's own call site, so a compromised or merely
 * confusing upstream message can never reach this module's output even for
 * a code we recognize.
 *
 * `Record<KnownApiErrorCode, string>` makes an entry missing for any member
 * of `API_ERROR_CODES` a TypeScript compile error (belt) in addition to the
 * runtime totality test in errors.test.ts (suspenders).
 */
const ERROR_CODE_MESSAGES: Record<KnownApiErrorCode, string> = {
  invalid_api_key:
    'The API key was rejected — it is missing, malformed, or not recognized by the server. ' +
    'This will not succeed by retrying the same request: the configured API key needs to be replaced ' +
    'with a valid, current workspace API key before this tool can be used again.',

  api_key_required:
    'No usable API key was presented with this request. This will not succeed by retrying: ' +
    "check that the server's API key configuration is actually set before trying again.",

  api_key_disabled:
    'This API key has been disabled and can no longer authenticate requests. This will not succeed ' +
    'by retrying — a new or re-enabled API key is required before this tool can be used again.',

  scope_required:
    "The current API key does not carry the scope this operation requires. A key's scopes can be " +
    'narrowed after the key was issued, so this can appear even for a key that used to work. ' +
    "Restarting the MCP server re-probes the key's currently available scopes; if the scope is " +
    'still missing after a restart, a key with the necessary scope is required — this is not something ' +
    'retrying the same request can fix on its own.',

  scope_not_asserted:
    'This route requires an explicitly asserted API key scope, and the server found none asserted for ' +
    'it. This points at a server-side routing or tool-definition problem rather than anything the caller ' +
    'did wrong, and should not occur through the tools this MCP server exposes.',

  forbidden:
    "The request was authenticated and the API key's scope was sufficient, but access to this specific " +
    'project or resource was denied. This is a per-project authorization failure, not a problem with the ' +
    'API key itself — the same key may still work for other projects in this workspace.',

  validation_error:
    'The request was rejected because one or more fields failed validation. Retrying the exact same ' +
    'request will fail the same way — the offending field(s) need to be corrected first.',

  no_open_column:
    'This project has no open (not-done) column to receive a new task. Either specify an existing ' +
    'column explicitly, or create/open one in the project before creating a task without one.',

  invalid_assignee:
    'One or more of the requested assignees are not members of this workspace. Confirm the assignee ' +
    "id(s) against the workspace's member list before retrying.",

  inbox_project:
    'This project is an inbox project and cannot receive tasks created through the API. Choose a ' +
    'different, non-inbox project and retry.',

  invalid_date:
    'One of the date parameters supplied could not be parsed as a valid date. Check its format and ' +
    'value before retrying.',

  window_too_large:
    'The requested date window is larger than the server allows. Narrow the from/to range and retry.',

  not_found:
    'No matching resource was found for this request — OR it exists but is not visible to this API key ' +
    '(a project in a different workspace, a private or archived project, or an inbox project all produce ' +
    'this exact same response, by design, so that a caller cannot use this response to distinguish "does ' +
    'not exist" from "not yours" from "not visible right now"). A 404 here does NOT prove the resource ' +
    'does not exist, and its absence should not be treated or cached as permanent nonexistence — it may ' +
    'become reachable later (e.g. if workspace access changes) with no change on the caller\'s side at all.',

  idempotency_key_reuse:
    'The Idempotency-Key supplied for this request was already used with a different request body. Use ' +
    'a fresh Idempotency-Key for a genuinely new request, or resend the exact original request body to ' +
    'get back the original result.',

  key_rate_limited:
    "This API key has exceeded its per-minute request budget. This is transient — it's reasonable to " +
    'wait and retry with backoff.',

  workspace_rate_limited:
    "This workspace has exceeded its per-minute request budget across all of its API keys. This is " +
    "transient — it's reasonable to wait and retry with backoff.",

  write_rate_limited:
    "This API key has exceeded its per-minute WRITE-request budget specifically. This is transient — " +
    "it's reasonable to wait and retry with backoff, and to prefer fewer, larger write requests where " +
    'possible.',

  anonymous_rate_limited:
    'Too many requests have been made from this network address without a valid API key being ' +
    "recognized. If a key is configured, verify it; if it's valid, this is transient and it's " +
    'reasonable to wait and retry with backoff.',
};

/** True for status codes worth an automatic retry (rate limits, server errors) — false for everything else. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function withRequestIdSuffix(message: string, requestId: string | null): string {
  const suffix = requestId ? `(request_id: ${requestId})` : '(no request_id available)';
  return `${message} ${suffix}`;
}

interface ExtractedEnvelopeError {
  code: string;
  requestId: string | null;
}

/**
 * Recognizes the `{error:{code, request_id, ...}}` envelope shape and pulls
 * out only `code`/`request_id` — never `message` or `type` (this module has
 * no use for either, and touching `message` here would be exactly the
 * interpolation this module exists to avoid). Returns `null` for anything
 * that isn't that shape: a string, `null`, an array, a plain object with no
 * `error` key (the uncaught-`\Throwable` `{"message":"Server Error"}` body),
 * or an `error` object whose `code` isn't a non-empty string. Never throws —
 * `body` is `unknown` and may be genuinely anything a JSON.parse (or a
 * JSON.parse failure represented as raw text) could hand back.
 */
function extractEnvelopeError(body: unknown): ExtractedEnvelopeError | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const maybeError = (body as Record<string, unknown>).error;
  if (typeof maybeError !== 'object' || maybeError === null || Array.isArray(maybeError)) return null;

  const errorObj = maybeError as Record<string, unknown>;
  const code = typeof errorObj.code === 'string' && errorObj.code.length > 0 ? errorObj.code : null;
  if (code === null) return null;

  const requestId = typeof errorObj.request_id === 'string' && errorObj.request_id.length > 0
    ? errorObj.request_id
    : null;

  return { code, requestId };
}

/** Sentinel `code` this module reports when the body wasn't the error envelope at all. */
/** Also used by client.ts when a 2xx body is empty/unparseable — same "no usable envelope" situation. */
export const NO_ENVELOPE_CODE = 'no_error_envelope';

export interface MappedApiError {
  /** The wire `error.code` (known or, sanitized, unrecognized), or `NO_ENVELOPE_CODE` when the body wasn't the envelope shape at all. */
  code: string;
  status: number;
  /** `true` when retrying this exact request is not expected to help — i.e. every status except 429 and 5xx. */
  terminal: boolean;
  /** The request id to hand back to a human for support, sanitized. `null` when none was available anywhere. */
  requestId: string | null;
  /** Model-actionable text. Never contains upstream `error.message` or any other unsanitized wire content. */
  message: string;
}

/**
 * Maps a Public API v1 HTTP response into text an LLM tool-caller can act
 * on. Pure — makes no network call, and never throws regardless of what
 * `body` turns out to be.
 *
 * `requestId`, when given, should be the response's `X-Request-Id` header —
 * it takes priority over any `request_id` found inside `body.error`, since
 * the header is set directly by `ErrorEnvelope::make()` on every envelope
 * response and, unlike the body, is also present on responses that bypass
 * `AttachRequestId`'s own header-write step (an exception-converted 401 —
 * see the file-level docblock). Falls back to `body.error.request_id`, then
 * to `null` when neither is available (the uncaught-`\Throwable` fallback
 * body has neither).
 */
export function mapApiError(
  status: number,
  body: unknown,
  requestId?: string | null
): MappedApiError {
  const envelope = extractEnvelopeError(body);
  const suppliedRequestId = typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
  const rawRequestId = suppliedRequestId ?? envelope?.requestId ?? null;
  const sanitizedRequestId = sanitizeUntrustedToken(rawRequestId);
  const terminal = !isTransientStatus(status);

  if (envelope) {
    const known = ERROR_CODE_MESSAGES[envelope.code as KnownApiErrorCode] as string | undefined;

    if (known) {
      return {
        code: envelope.code,
        status,
        terminal,
        requestId: sanitizedRequestId,
        message: withRequestIdSuffix(known, sanitizedRequestId),
      };
    }

    const safeCode = sanitizeUntrustedToken(envelope.code) ?? 'unknown';
    const message =
      `The server returned an error with code \`${safeCode}\` (HTTP ${status}), which this tool has ` +
      'no specific guidance for. Treat this as a failure and do not assume it is safe to retry without ' +
      'understanding the cause first.';

    return {
      code: safeCode,
      status,
      terminal,
      requestId: sanitizedRequestId,
      message: withRequestIdSuffix(message, sanitizedRequestId),
    };
  }

  const retryGuidance = terminal
    ? 'Given the HTTP status, retrying this exact request unchanged is unlikely to succeed.'
    : 'This looks transient; it is reasonable to wait and retry with backoff.';
  const message =
    `The server returned an error (HTTP ${status}) without the API's usual structured error body — ` +
    'most consistent with an unexpected server-side failure rather than a problem with the request ' +
    `itself. ${retryGuidance}`;

  return {
    code: NO_ENVELOPE_CODE,
    status,
    terminal,
    requestId: sanitizedRequestId,
    message: withRequestIdSuffix(message, sanitizedRequestId),
  };
}

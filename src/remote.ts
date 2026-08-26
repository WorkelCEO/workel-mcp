/**
 * The stateless Streamable HTTP entry — the v2 remote transport
 * (docs/MCP_SERVER_PLAN.md §"Phase 5 — v2 remote (bearer)"). This is
 * Phase 5 as CODE ONLY: nothing here is deployed, wired into CI, or given a
 * hostname. Its job is to prove `buildServer()` (`./server.ts`) is really
 * transport-independent — this module never edits it, only imports it — and
 * to make the remote-specific risks the stdio transport never had to face
 * concrete and testable: a curl-style `wk_`-only bearer check, a bare
 * `WWW-Authenticate: Bearer` challenge with none of the OAuth metadata that
 * is known to make some MCP clients silently ignore a static header, Origin
 * validation, and a front throttle keyed on a HASH of the bearer rather
 * than the caller's IP — per-IP is worthless here, since claude.ai and the
 * OpenAI Agents SDK both call out from shared provider egress ranges, so
 * every real tenant would collide in one IP-keyed bucket while a hashed-key
 * bucket keeps them apart without ever storing the raw key.
 *
 * Every request pipeline step below runs in a FIXED order and each step is
 * an unconditional early return — that order IS the security property, not
 * an implementation detail:
 *
 *   1. method      — only POST is ever handled; everything else is 405.
 *   2. Origin      — a PRESENT, disallowed Origin is 403. An ABSENT Origin
 *                    is allowed: server-to-server connectors (the only
 *                    caller this endpoint is designed for) send none, and
 *                    refusing them would break the one caller that matters.
 *   3. auth        — no `Authorization` header, or a bearer not shaped like
 *                    `wk_...`, is 401 with a BARE `WWW-Authenticate: Bearer`
 *                    challenge — no `realm`, no `resource_metadata`, no
 *                    parameters at all — and, critically, NO upstream fetch
 *                    happens for either failure. A `wk_`-shaped bearer that
 *                    turns out to be wrong is not this module's problem to
 *                    diagnose: it goes to dispatch and comes back as
 *                    whatever the real Workel API says.
 *   4. throttle     — a fixed window per SHA-256(bearer), sized (see
 *                     `REQUESTS_ALLOWED_PER_WINDOW` below) to match the
 *                     Public API v1's own per-key write ceiling
 *                     (`RouteServiceProvider.php`), so this front door is
 *                     never the tighter one. Exceeding it is a 429
 *                     response carrying `Retry-After`.
 *   5. dispatch     — a brand-new `WorkelApiClient` bound to THIS request's
 *                     bearer, a brand-new `buildServer()` result, and a
 *                     brand-new stateless transport, connected and handed
 *                     the request. Nothing from one request — client,
 *                     server, transport, or key — is ever reused by the
 *                     next one; see `dispatch()` below.
 *
 * No per-request `/me` scope probe (a deliberate scope decision, not an
 * oversight — see the docblock on `computeCaps()` below for why, and the
 * final report's `decisions_outside_brief` for the tradeoff it accepts).
 *
 * Env reads: the ONLY function in this file that ever reads an environment
 * variable is `startRemote()`, and the ONLY way it does so is through
 * `config.ts`'s existing exported `loadConfig()` — see the docblock on
 * `startRemote()` for the one real friction point that decision creates
 * (`loadConfig` requires `WORKEL_API_KEY`, which this transport has no use
 * for) and why it is accepted rather than worked around by touching
 * `config.ts`, which is out of scope for this module.
 */

import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { loadConfig } from './config';
import { createWorkelApiClient, type FetchLike, type WorkelApiClient } from './api/client';
import { defaultSleep, probeMe } from './boot';
import { redactDeep } from './api/redact';
import { buildServer, type ServerCaps } from './server';
import { READ_TOOLS } from './tools';
import { registeredWriteTools } from './tools/registration';
import type { ToolFactory } from './tools/defineTool';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

// Deliberately NOT the Node.js `http` module's `IncomingMessage`/
// `ServerResponse` types directly: a real `IncomingMessage`/`ServerResponse`
// satisfies these structurally (a real request is an async-iterable stream
// of `Buffer` chunks with a `.method`/`.headers`; a real response has
// `writeHead`/`end`), but so does a plain object built in a test with no
// socket, no EventEmitter, and no stream machinery behind it — which is the
// entire point: this module's own pipeline (steps 1-4 above) only ever
// touches `method`/`headers`, and only `dispatch()` (step 5) ever reads the
// body, via ordinary async iteration that a hand-built test double can
// trivially implement.
export interface RemoteRequest extends AsyncIterable<Buffer> {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  /**
   * Only the liveness probe reads this. Every other request is handled
   * identically regardless of path (see the file docblock, step 1) — the probe
   * is the one case that must be told apart, so it can answer before the
   * POST-only rule and before auth.
   */
  url?: string;
}

export interface RemoteResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(chunk?: string): void;
}

/**
 * `message` is always a static string literal at every call site in this
 * file — nothing dynamic (an Origin value, a throttle key, an upstream
 * error) is ever string-interpolated into it. Anything dynamic rides in
 * `meta`, and `log()` below runs `meta` through `redactDeep` before it ever
 * reaches this interface's implementation — see `log()`'s docblock for why
 * that is a real, load-bearing second line of defense and not just
 * decoration.
 */
export interface RemoteLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RemoteHandlerDeps {
  fetch: FetchLike;
  logger: RemoteLogger;
  /** Defaults to `[]` when omitted — see the file docblock, step 2: an empty allowlist refuses every PRESENT Origin, but an absent Origin is still allowed regardless of this list's contents. */
  allowedOrigins?: string[];
  now: () => number;
  /** The Public API v1 base URL every per-request `WorkelApiClient` is built against. */
  baseUrl: string;
  /**
   * Gate (b) of D5 ("Read-only by default; writes are a double opt-in",
   * docs/MCP_SERVER_PLAN.md), resolved ONCE by the caller (`startRemote`,
   * from `config.ts`'s `loadConfig().enableWrites`) and passed in as a
   * plain boolean — never re-read from the environment inside the request
   * pipeline itself. `registeredWriteTools(writesEnabled)` (`./tools/registration.ts`)
   * is the same gate (b) `boot.ts` applies for stdio; passing this value
   * explicitly is what keeps this file from needing its own `process.env`
   * read to apply it.
   */
  writesEnabled: boolean;
  /**
   * The URL of this server's RFC 9728 protected-resource metadata document,
   * which turns this endpoint from a static-bearer server into an OAuth one.
   *
   * Absent (the default) keeps the original behaviour exactly: a bare
   * `WWW-Authenticate: Bearer` challenge and a `wk_`-only bearer filter, for
   * clients that paste a Workel API key as a static header.
   *
   * Present switches on OAuth mode, which changes two things together — they
   * are one decision, not two:
   *   1. The 401 advertises `resource_metadata`, which is the ONLY way Claude
   *      can discover where to authorize. Without it the connection fails as
   *      an unexplained "couldn't reach the MCP server".
   *   2. The `wk_` prefix filter is lifted, because an OAuth access token is
   *      not `wk_`-shaped and would otherwise be rejected here before the API
   *      ever saw it. Nothing is weakened by this: the prefix test was only
   *      ever a cheap shape check, never verification — every bearer is still
   *      validated upstream by the Public API, which is the real boundary.
   */
  protectedResourceMetadataUrl?: string;
}

export type RemoteRequestHandler = (req: RemoteRequest, res: RemoteResponse) => Promise<void>;

/** Never matched against anything user-supplied; see `config.ts`'s own key-format note — no exported constant exists there to reuse, so this is declared once, here. */
const WK_BEARER_PATTERN = /^wk_/;

/**
 * Sized to match the Public API v1's own per-key write ceiling
 * (`public-api` in `RouteServiceProvider.php`) so this front door is
 * never the tighter one for a legitimately busy key. Exported so
 * `remote.test.ts` can assert against this single source of the number
 * rather than restating it as a second, driftable literal.
 */
export const REQUESTS_ALLOWED_PER_WINDOW = 120;
const THROTTLE_WINDOW_MS = 60_000;

/** A Fetch-API `Request` needs an absolute URL even though nothing downstream of this file ever inspects its path — every request this server accepts is handled identically regardless of what path it arrived on (see the file docblock, step 1). `.invalid` is the RFC 2606 TLD reserved for exactly this "never a real, resolvable domain" purpose. */
const INTERNAL_REQUEST_URL = 'http://mcp.internal.invalid/mcp';

const DEFAULT_REMOTE_PORT = 8787;

interface ThrottleEntry {
  count: number;
  windowStart: number;
}

/**
 * Module-local by design (not per-handler-instance): a long-running remote
 * process serves many requests through the SAME `createRemoteHandler`
 * closure, and the throttle must persist across them — a Map recreated
 * per-request would throttle nothing. Keyed on the hashed bearer (never the
 * raw one), so this Map itself never holds a real API key.
 */
const throttleState = new Map<string, ThrottleEntry>();

/** SHA-256, not a substring/prefix of the bearer — the whole point is that this value can be logged and bucketed without ever being reversible to, or containing a recognizable fragment of, the real key. Truncated to 16 hex chars purely to keep log lines short; 64 bits of a cryptographic digest is already far more collision-resistant than this bucket size needs. */
function hashBearer(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex').slice(0, 16);
}

/**
 * Fixed window. Prunes every expired entry on each write so a long-running
 * process serving many distinct bearers over time doesn't grow this Map
 * without bound — a hashed key that stops being used simply falls out of
 * the map the next time ANY request causes a write.
 */
function checkThrottle(hash: string, now: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  for (const [key, entry] of throttleState) {
    if (now - entry.windowStart >= THROTTLE_WINDOW_MS) throttleState.delete(key);
  }

  const existing = throttleState.get(hash);
  if (existing === undefined || now - existing.windowStart >= THROTTLE_WINDOW_MS) {
    throttleState.set(hash, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (existing.count >= REQUESTS_ALLOWED_PER_WINDOW) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.windowStart + THROTTLE_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true };
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** RFC 6750's scheme name (`Bearer`) is case-sensitive; this matches it exactly, the same way every real client sends it. */
function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (authorizationHeader === undefined) return null;
  // RFC 7235 §2.1: the auth-scheme name is case-INsensitive ("Bearer",
  // "bearer" and "BEARER" are the same scheme), so matching the literal
  // string would reject spec-conformant clients.
  const separator = authorizationHeader.indexOf(' ');
  if (separator === -1) return null;
  if (authorizationHeader.slice(0, separator).toLowerCase() !== 'bearer') return null;
  const token = authorizationHeader.slice(separator + 1).trim();
  return token.length > 0 ? token : null;
}

/** Absent Origin is always allowed, regardless of `allowedOrigins`'s contents — see the file docblock, step 2. */
function isOriginAllowed(originHeader: string | undefined, allowedOrigins: string[]): boolean {
  return originHeader === undefined || allowedOrigins.includes(originHeader);
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: null;
  error: { code: number; message: string };
}

function jsonRpcError(code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}

/**
 * `redactDeep` (`./api/redact.ts`) scrubs any `wk_`-shaped token it finds
 * anywhere in `meta`, unconditionally — that pattern match needs no prior
 * `registerSecret()` call to work. That is deliberate here: `registerSecret`
 * adds to a process-global, never-cleared Set, which is exactly correct for
 * `boot.ts`'s single-process, single-key stdio lifetime but would be a slow
 * unbounded leak on a long-running remote process serving one bearer per
 * request — this module never calls it. `redactDeep`'s pattern-only
 * matching is the one piece of `redact.ts` that fits a multi-tenant
 * process, and it is what actually makes "no logger call ever contains a
 * substring of the raw bearer" true even if a future call site here
 * accidentally passed one through — not just the discipline of every
 * current call site staying static-string-only.
 */
function log(logger: RemoteLogger, level: keyof RemoteLogger, message: string, meta: Record<string, unknown> = {}): void {
  logger[level](message, redactDeep(meta) as Record<string, unknown>);
}

/**
 * The largest request body this server will buffer. JSON-RPC tool calls are
 * kilobytes; this is generous. The cap is load-bearing: the only gate ahead
 * of this read is a `wk_` PREFIX test, never an upstream key verification, so
 * an attacker who has never held a valid key can reach it. Uncapped, a single
 * request buffered 200 MiB off-heap (+915 MB RSS) with zero upstream calls.
 */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Thrown by `readRawBody` when a body exceeds `MAX_REQUEST_BODY_BYTES`; the handler turns it into a 413. */
export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the maximum accepted size.');
    this.name = 'RequestBodyTooLargeError';
  }
}

async function readRawBody(req: RemoteRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    // Abort as soon as the running total crosses the cap — never after
    // buffering the whole thing, which would defeat the point.
    if (total > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** `READ_TOOLS` (`./tools/index.ts`) unconditionally, `WRITE_TOOLS` (`./tools/registration.ts`) only when gate (b) is open — the exact same composition `boot.ts` would use if it wired writes in, expressed through the same exported `registeredWriteTools` gate rather than a second one. */
function toolsForRequest(writesEnabled: boolean): ToolFactory[] {
  return [...READ_TOOLS, ...registeredWriteTools(writesEnabled)];
}

/**
 * There is no per-request `GET /me` scope probe here, unlike `boot.ts`'s
 * startup probe. `boot.ts` can afford one because it runs exactly once per
 * process, for exactly one configured key. A stateless remote request
 * carries a DIFFERENT bearer on every call — probing `/me` before every
 * single tool invocation would double the upstream call count of this
 * server for no correctness gain the API itself doesn't already provide:
 * `buildServer`'s caps filter (gate (a) of D5) is UX ("don't offer a tool
 * the key can't use"), and the API's own per-request scope check is — and
 * remains — the real boundary regardless of what this function decides to
 * register. So `caps` here is deliberately the UNION of every scope any
 * INCLUDED tool declares (mirroring `boot.ts`'s own `skipStartupCheck`
 * branch, which makes the identical trade for the identical reason): every
 * tool this request is otherwise eligible for (by gate (b)) is offered, and
 * a key that doesn't actually hold a given tool's scope finds out from the
 * API's own 403 on the first real call, exactly as `boot.ts`'s doc already
 * says is the honest fallback. See the final report's
 * `decisions_outside_brief` for this tradeoff spelled out explicitly.
 */
function computeCaps(client: WorkelApiClient, tools: ToolFactory[]): ServerCaps {
  const scopes = new Set<string>();
  for (const factory of tools) {
    const descriptor = factory(client);
    if (descriptor.scope !== undefined) scopes.add(descriptor.scope);
  }
  return { scopes: Array.from(scopes) };
}

/**
 * True when the body is a JSON-RPC `initialize` call — the one message whose
 * response carries `serverInfo.name` to the client.
 *
 * Deliberately total: any parse failure, batch, or other method returns false
 * and the request proceeds unnamed. A malformed body is the transport's to
 * reject with a proper JSON-RPC error, not this function's to throw on.
 */
function isInitialize(rawBody: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { method?: unknown }).method === 'initialize'
    );
  } catch {
    return false;
  }
}

/** Longest workspace name we will put in `serverInfo.name`. */
const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * `workel — <workspace>`, or `undefined` if the workspace cannot be
 * determined.
 *
 * NEVER throws and never fails the request: the name is cosmetic, and a `/me`
 * that is slow, rate-limited or down must degrade to the plain server name
 * rather than break a session the caller is otherwise entitled to. A bearer
 * that is simply invalid also lands here, and the real 401 is produced by the
 * tool call that follows — this must not pre-empt it with a different error.
 *
 * The workspace name is USER-SUPPLIED, so it is sanitised before going into a
 * protocol field: control characters stripped (they can break framing or smuggle
 * escape sequences into a terminal client) and length capped.
 */
async function resolveDisplayName(
  client: WorkelApiClient,
  deps: RemoteHandlerDeps
): Promise<string | undefined> {
  try {
    const me = await probeMe(client);
    const raw = me.workspace?.name;
    if (typeof raw !== 'string') return undefined;

    // eslint-disable-next-line no-control-regex
    const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned === '') return undefined;

    const label =
      cleaned.length > MAX_DISPLAY_NAME_LENGTH
        ? `${cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH - 1)}…`
        : cleaned;

    return `workel — ${label}`;
  } catch (err) {
    // Name only. Never the bearer, and never the upstream body.
    log(deps.logger, 'info', 'remote.display_name_unavailable', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return undefined;
  }
}

function collectResponseHeaders(webResponse: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    // Defense in depth: stateless mode (`sessionIdGenerator: undefined`)
    // never sets this header inside the SDK, but every response on every
    // path here MUST NOT carry one regardless of how that invariant is
    // upheld upstream — see the file docblock's step 5 and the class
    // invariant this whole transport exists to prove.
    if (key.toLowerCase() === 'mcp-session-id') return;
    headers[key] = value;
  });
  return headers;
}

/**
 * Runs an already-authorized, already-throttled POST all the way through:
 * a fresh `WorkelApiClient` bound to `bearer`, a fresh `buildServer()`
 * result, and a fresh stateless `WebStandardStreamableHTTPServerTransport`
 * — none of the three are ever reused across requests, and none of them
 * are ever cached anywhere this function can see on its next invocation.
 *
 * `WebStandardStreamableHTTPServerTransport` (not the Node-wrapper
 * `StreamableHTTPServerTransport`, which bridges through `@hono/node-server`
 * and needs a real `IncomingMessage`/`ServerResponse` pair with working
 * stream/socket internals) operates on the Fetch API's `Request`/`Response`
 * — Node has shipped both as real globals since v18, so building one from
 * the bytes this function already read off `req` needs nothing beyond the
 * standard library, and a caller can construct one in a test with zero
 * mocking of Node's HTTP internals. `enableJsonResponse: true` is the other
 * half of that choice: it turns off this transport's SSE-by-default
 * response mode in favor of one buffered JSON `Response` per call — the
 * only mode this server's short-lived, no-server-initiated-messages tool
 * calls ever need, and the only one a test can assert on with a plain
 * `await response.text()`.
 *
 * `sessionIdGenerator: undefined` also means: this transport instance
 * throws if `handleRequest` is ever called on it a second time (see the
 * class's own source) — reusing it across requests is not just against
 * this function's contract, it is a hard runtime error, which is why a
 * fresh one is constructed on every call with no fallback path that could
 * accidentally reuse an old one.
 */
async function dispatch(
  req: RemoteRequest,
  respond: (status: number, headers: Record<string, string>, body?: string) => void,
  bearer: string,
  deps: RemoteHandlerDeps
): Promise<void> {
  const client = createWorkelApiClient({
    baseUrl: deps.baseUrl,
    apiKey: bearer,
    fetch: deps.fetch,
    sleep: defaultSleep,
  });

  const tools = toolsForRequest(deps.writesEnabled);
  const caps = computeCaps(client, tools);

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      log(deps.logger, 'warn', 'remote.body_too_large', { limit: MAX_REQUEST_BODY_BYTES });
      respond(413, { 'Content-Type': 'application/json' }, JSON.stringify(jsonRpcError(-32600, 'Request body too large')));
      return;
    }
    throw err;
  }

  // Only the `initialize` handshake carries the server name to the client, so
  // that is the only message worth spending a round trip to personalise. Tool
  // calls skip this entirely and cost exactly what they did before — which is
  // the whole reason `computeCaps` deliberately avoids probing `/me` too.
  const displayName = isInitialize(rawBody) ? await resolveDisplayName(client, deps) : undefined;
  const server = buildServer(client, caps, tools, displayName);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);

    const webRequest = new Request(INTERNAL_REQUEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Required by the transport's own Accept-header check regardless
        // of what the real caller sent — this Request is an internal
        // bridging artifact, not the caller's actual request, so it always
        // declares exactly what the transport requires.
        accept: 'application/json, text/event-stream',
      },
      body: rawBody,
    });

    const webResponse = await transport.handleRequest(webRequest);
    const bodyText = await webResponse.text();
    respond(webResponse.status, collectResponseHeaders(webResponse), bodyText);
  } catch (err) {
    // An oversized body is the caller's fault and is not an internal error:
    // reporting it as 500 would hide a deliberate, attacker-reachable limit
    // behind a generic failure.
    if (err instanceof RequestBodyTooLargeError) {
      log(deps.logger, 'warn', 'remote.body_too_large', { limit: MAX_REQUEST_BODY_BYTES });
      respond(413, { 'Content-Type': 'application/json' }, JSON.stringify(jsonRpcError(-32600, 'Request body too large')));
      return;
    }
    log(deps.logger, 'error', 'remote.dispatch_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    respond(500, { 'Content-Type': 'application/json' }, JSON.stringify(jsonRpcError(-32603, 'Internal server error')));
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/**
 * Builds the stateless request pipeline described in the file docblock.
 * Returns a plain `async (req, res) => void` function with no top-level
 * side effects of its own — constructing it opens no socket and reaches no
 * network; only actually CALLING the returned function (once per real HTTP
 * request, from `startRemote`'s `http.Server`, or directly from a test)
 * does anything.
 */
export function createRemoteHandler(deps: RemoteHandlerDeps): RemoteRequestHandler {
  const allowedOrigins = deps.allowedOrigins ?? [];

  return async function handleRemoteRequest(req, res) {
    let responded = false;
    const respond = (status: number, headers: Record<string, string>, body?: string): void => {
      if (responded) return;
      responded = true;
      res.writeHead(status, headers);
      res.end(body);
    };

    const method = (req.method ?? '').toUpperCase();

    // Liveness probe, ahead of every other check. Azure App Service polls a
    // GET endpoint and restarts the container when it fails, so this has to
    // answer before the POST-only rule below turns it into a 405 — and before
    // auth, since a probe carries no credentials.
    //
    // It reports only that the process is up: no config, no version, no
    // upstream reachability. This endpoint is unauthenticated, so anything it
    // returns is public.
    if (method === 'GET' && (req.url ?? '').split('?')[0] === '/health') {
      respond(200, { 'Content-Type': 'application/json' }, JSON.stringify({ status: 'ok' }));
      return;
    }

    if (method !== 'POST') {
      respond(405, { Allow: 'POST', 'Content-Type': 'application/json' }, JSON.stringify(jsonRpcError(-32000, 'Method not allowed. This endpoint only accepts POST.')));
      return;
    }

    const originHeader = normalizeHeaderValue(req.headers['origin']);
    if (!isOriginAllowed(originHeader, allowedOrigins)) {
      log(deps.logger, 'warn', 'remote.origin_rejected', { origin: originHeader ?? null });
      respond(403, { 'Content-Type': 'application/json' }, JSON.stringify(jsonRpcError(-32003, 'Origin not allowed.')));
      return;
    }

    const authorizationHeader = normalizeHeaderValue(req.headers['authorization']);
    const bearer = extractBearerToken(authorizationHeader);

    // In OAuth mode any non-empty bearer is forwarded — an OAuth access token
    // is not `wk_`-shaped, and the prefix test was only ever a shape check,
    // never verification. In static-bearer mode the original `wk_` filter
    // still applies. Either way the upstream API is what actually decides.
    const oauthMode = typeof deps.protectedResourceMetadataUrl === 'string' && deps.protectedResourceMetadataUrl !== '';
    const bearerAccepted = bearer !== null && (oauthMode || WK_BEARER_PATTERN.test(bearer));

    if (!bearerAccepted) {
      log(deps.logger, 'warn', 'remote.auth_rejected', { reason: bearer === null ? 'missing' : 'bad_prefix' });
      // The challenge is what makes OAuth discoverable: Claude reads
      // `resource_metadata` off this 401 to find the protected-resource
      // document, and from there the authorization server. Anthropic honours
      // it ONLY on a 401 — never on a 200 — so this response code and this
      // header have to travel together.
      //
      // Without a metadata URL configured the challenge stays bare, because a
      // static-`Authorization` client is known to ignore its own header once a
      // challenge advertises OAuth metadata (docs/MCP_SERVER_PLAN.md, D10).
      const challenge = oauthMode
        ? `Bearer resource_metadata="${deps.protectedResourceMetadataUrl}"`
        : 'Bearer';

      respond(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge }, JSON.stringify(jsonRpcError(-32001, 'Unauthorized')));
      return;
    }

    const throttleHash = hashBearer(bearer);
    const throttleResult = checkThrottle(throttleHash, deps.now());
    if (!throttleResult.allowed) {
      log(deps.logger, 'warn', 'remote.throttled', { throttleKey: throttleHash });
      respond(
        429,
        { 'Content-Type': 'application/json', 'Retry-After': String(throttleResult.retryAfterSeconds) },
        JSON.stringify(jsonRpcError(-32005, 'Too many requests.'))
      );
      return;
    }

    log(deps.logger, 'info', 'remote.dispatch', { throttleKey: throttleHash });
    await dispatch(req, respond, bearer, deps);
  };
}

export interface StartRemoteOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  logger?: RemoteLogger;
  now?: () => number;
  allowedOrigins?: string[];
  port?: number;
  /** Overrides `WORKEL_OAUTH_RESOURCE_METADATA_URL`; see `RemoteHandlerDeps` for what setting it switches on. */
  protectedResourceMetadataUrl?: string;
}

const consoleLogger: RemoteLogger = {
  info: (message, meta) => console.error(message, meta ?? {}),
  warn: (message, meta) => console.error(message, meta ?? {}),
  error: (message, meta) => console.error(message, meta ?? {}),
};

/**
 * Binds `createRemoteHandler`'s pipeline to a real Node `http.Server`. This
 * is the only place in the file that reads `process.env` — and even here,
 * only through `config.ts`'s existing exported `loadConfig()`, never a new
 * `env.SOMETHING` read of this module's own invention.
 *
 * That constraint has one real, honestly-stated cost: `loadConfig` requires
 * `WORKEL_API_KEY` to be set (`config.ts`'s `resolveApiKey`), a requirement
 * that makes sense for the stdio entry (`index.ts`), which serves exactly
 * one configured key for its whole process lifetime, but does NOT describe
 * this transport at all — the remote server's bearer arrives fresh on
 * every request (`dispatch()` above) and `WORKEL_API_KEY`, if set, is never
 * read by any request this process handles. Reusing `loadConfig` here is
 * still the right call for `baseUrl`/`enableWrites` — this file must not
 * re-derive `config.ts`'s own validation (an `https://` scheme check, a
 * boolean-flag parse) a second, drifting time — but it means an operator
 * deploying this entry must still set an (unused-per-request)
 * `WORKEL_API_KEY` purely to satisfy that loader. `config.ts` is out of
 * scope for this change; a follow-up that gives it a remote-shaped loader
 * (or exports its currently-private `resolveBaseUrl`/`parseBooleanFlag`
 * helpers directly) is the honest fix, not a workaround added here.
 */
export function startRemote(opts: StartRemoteOptions = {}): http.Server {
  const env = opts.env ?? process.env;
  const config = loadConfig(env);

  const handler = createRemoteHandler({
    fetch: opts.fetch ?? fetch,
    logger: opts.logger ?? consoleLogger,
    allowedOrigins: opts.allowedOrigins ?? [],
    now: opts.now ?? (() => Date.now()),
    baseUrl: config.baseUrl,
    writesEnabled: config.enableWrites,
    // Read here rather than inside the request pipeline, matching how
    // `writesEnabled` is resolved once by the caller — the handler stays a
    // pure function of its deps and never touches `process.env` itself.
    // Unset leaves the server in its original static-bearer mode.
    protectedResourceMetadataUrl: opts.protectedResourceMetadataUrl ?? env.WORKEL_OAUTH_RESOURCE_METADATA_URL,
  });

  const server = http.createServer((req, res) => {
    void handler(req as unknown as RemoteRequest, res as unknown as RemoteResponse);
  });

  server.listen(opts.port ?? DEFAULT_REMOTE_PORT);
  return server;
}

// Same idiom `index.ts` uses for the stdio entry: guarded so importing this
// module (every test in `remote.test.ts` does exactly that) never opens a
// real socket — only running this file directly (`node dist/remote.js`) does.
//
// The `typeof module` probe is what lets `worker.ts` import this file on
// Cloudflare Workers. There is no CommonJS wrapper there, so a bare
// `require.main === module` throws ReferenceError at MODULE LOAD and the
// Worker never boots — it fails before serving a single request, which is a
// confusing way to discover a missing shim. `typeof` on an undeclared
// identifier is safe and yields 'undefined'.
if (typeof module !== 'undefined' && typeof require !== 'undefined' && require.main === module) {
  startRemote({ env: process.env, fetch, allowedOrigins: [] });
}

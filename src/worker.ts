/**
 * The Cloudflare Workers entry — a third transport shell around the SAME
 * `createRemoteHandler` the Node server uses (`./remote.ts`). This module
 * adapts Fetch's `Request`/`Response` to the small Node-shaped request/response
 * interfaces that handler expects, and does nothing else: no auth decisions, no
 * routing, no tool logic. Everything security-relevant stays in one place.
 *
 * Why Workers rather than a container: the frontend already deploys here, so
 * `mcp.workel.com` is a DNS record and a route on infrastructure that exists,
 * instead of a new App Service, a container registry push, and a Terraform
 * apply. The handler is transport-agnostic by design, which is what makes this
 * a ~100-line adapter rather than a port.
 *
 * Config comes from `env` bindings, never `process.env` — Workers has no
 * process. The names match the container's variables exactly so one runbook
 * covers both.
 *
 * One honest difference from the Node deployment: `remote.ts`'s front throttle
 * is a module-level Map, which on Workers is per-ISOLATE rather than
 * per-process. Isolates are many and short-lived, so that ceiling is softer
 * here. It is defense-in-depth either way — the authoritative per-key and
 * per-workspace limits live on the Public API and are reported live by
 * `/me`, so no amount of edge concurrency bypasses them. If this front
 * throttle ever needs to be authoritative, that is a Durable Object or the
 * Workers Rate Limiting API, not a bigger Map.
 */

import { createRemoteHandler, type RemoteRequest, type RemoteResponse } from './remote';

export interface WorkerEnv {
  /** Public API v1 base URL. The PUBLIC surface only — never internal, never the database. */
  WORKEL_API_BASE_URL?: string;
  /** Presence switches on OAuth mode; see RemoteHandlerDeps.protectedResourceMetadataUrl. */
  WORKEL_OAUTH_RESOURCE_METADATA_URL?: string;
  /** Comma-separated. Empty means: refuse any PRESENT Origin, still allow an absent one. */
  WORKEL_ALLOWED_ORIGINS?: string;
  /** "true" enables the write tools. Read-only by default, matching the stdio server. */
  WORKEL_ENABLE_WRITES?: string;
}

/**
 * Adapt a Fetch `Request` to the handler's request shape.
 *
 * The body is read once, up front, and yielded as a single chunk. The handler's
 * own `MAX_REQUEST_BODY_BYTES` guard still applies — it checks a running total
 * while iterating, so one large chunk trips it exactly as many small ones
 * would.
 */
function toRemoteRequest(request: Request, body: Uint8Array): RemoteRequest {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    method: request.method,
    headers,
    url: new URL(request.url).pathname,
    async *[Symbol.asyncIterator]() {
      if (body.byteLength > 0) {
        yield Buffer.from(body);
      }
    },
  };
}

/**
 * Collect what the handler writes into a real `Response`.
 *
 * The handler calls writeHead/end exactly once per request (it guards on a
 * `responded` flag), so a promise resolved by `end` is a faithful translation
 * rather than a race.
 */
function createCollector(): { res: RemoteResponse; response: Promise<Response> } {
  let resolve!: (r: Response) => void;
  const response = new Promise<Response>((r) => {
    resolve = r;
  });

  let status = 500;
  let headers: Record<string, string> = {};

  const res: RemoteResponse = {
    writeHead(s, h) {
      status = s;
      headers = h ?? {};
    },
    end(chunk) {
      resolve(new Response(chunk ?? null, { status, headers }));
    },
  };

  return { res, response };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const handler = createRemoteHandler({
      // FetchLike is `typeof fetch`, so the runtime's own global satisfies it
      // directly — no wrapper, and nothing here can accidentally alter a
      // request on its way upstream.
      fetch,
      logger: {
        // console in Workers goes to the observability log stream. Kept to the
        // same three levels the Node logger uses so log shape does not depend
        // on where the server happens to run.
        info: (message, meta) => console.log(message, meta ?? {}),
        warn: (message, meta) => console.warn(message, meta ?? {}),
        error: (message, meta) => console.error(message, meta ?? {}),
      },
      now: () => Date.now(),
      baseUrl: env.WORKEL_API_BASE_URL ?? 'https://api.workel.com/api/public/v1',
      writesEnabled: env.WORKEL_ENABLE_WRITES === 'true',
      protectedResourceMetadataUrl: env.WORKEL_OAUTH_RESOURCE_METADATA_URL,
      allowedOrigins: (env.WORKEL_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    });

    // Read the body before handing over: Workers gives a stream, the handler
    // wants async-iterable chunks, and a GET/HEAD has no body to read at all.
    const raw =
      request.method === 'GET' || request.method === 'HEAD'
        ? new Uint8Array(0)
        : new Uint8Array(await request.arrayBuffer());

    const { res, response } = createCollector();
    await handler(toRemoteRequest(request, raw), res);

    return response;
  },
};

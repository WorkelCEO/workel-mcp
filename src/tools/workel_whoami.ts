/**
 * `workel_whoami` — `GET /me` (no scope required; the `key.any` middleware
 * accepts any valid key). This is the "is my key working, and what can it
 * do" tool: it reports the key's own workspace, name, and effective
 * scopes, plus its remaining rate-limit budget for this minute across the
 * key/workspace/write buckets.
 *
 * `MeResource` (the backend serializer) is ALREADY minimal-disclosure by
 * design (D7) — no email, no avatar, no creator identity — so this handler
 * passes the response body straight through rather than re-mapping it
 * through a bespoke tool-facing type: there is nothing on the wire shape
 * here that needs renaming or narrowing further.
 */

import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult } from './conventions';

const DESCRIPTION =
  'Report the identity of the currently configured Workel API key: which workspace it belongs ' +
  "to, the key's own name, the scopes it currently carries, and its remaining rate-limit budget " +
  'for this minute (separate key, workspace, and write-request budgets). Call this first to confirm ' +
  'the server is configured correctly and to see which of the other tools this key can actually use ' +
  'before calling them. Takes no arguments. ' +
  UNTRUSTED_CONTENT_NOTE;

export const workelWhoami: ToolFactory = (client) =>
  defineTool({
    name: 'workel_whoami',
    description: DESCRIPTION,
    inputSchema: {},
    annotations: { ...READ_ANNOTATIONS, title: 'Who am I' },
    handler: async () => {
      const result = await client.get('/me');
      return jsonToolResult(result.data);
    },
  });

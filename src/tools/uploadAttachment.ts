/**
 * `workel_upload_task_attachment` — `POST /tasks/{id}/attachments`
 * (`write:attachments` scope — NOT `write:tasks`; attachments have their own
 * scope on this surface, matching `routes/api/public/v1.php`'s
 * `key.scope:write:attachments` middleware on this exact route). A key
 * granted only `write:tasks` cannot upload, and this tool is not even
 * registered for it (gate (a) in `./registration.ts`).
 *
 * ── Why the content is a STRING, not a path ─────────────────────────────
 *
 * MCP tool arguments are JSON. There is no file handle to pass and no shared
 * filesystem to read from: an MCP server may well be running on a different
 * machine from the model, so a `path` argument would be a promise this tool
 * cannot keep. The file's CONTENT therefore comes in as a string and the
 * multipart request is assembled here (`client.postFile` →
 * `../api/client.ts`).
 *
 * That makes the natural fit text — markdown, CSV, JSON, logs, code — which
 * is what an assistant actually has in hand. `encoding: 'base64'` exists for
 * bytes (a small image, a PDF) but is not the main path: base64 inflates the
 * payload by a third and the whole thing has to travel through the model's
 * context, so anything large belongs in the web UI's drag-and-drop instead.
 *
 * ── Bounds and why they are where they are ──────────────────────────────
 *
 * `MAX_CONTENT_CHARS` is a client-side guard against a runaway argument, set
 * far BELOW the server's own 100 MB file cap: a file that big could not have
 * arrived through a tool call in the first place, so the useful limit here is
 * "a plausible document", not "whatever the server would accept". Everything
 * else is left to the server and surfaces as the mapped upstream error —
 * this tool does not duplicate the blocked-extension list, the storage quota,
 * or the project-permission rule, all of which can change server-side
 * without a client release.
 *
 * A task id that is not visible to this key (foreign workspace, or an
 * archived/private/inbox project) and a genuinely nonexistent id both return
 * the same collapsed not-found error: the server offers no existence oracle
 * and this tool does not try to build one.
 *
 * `idempotency_key` (D7): forwarded verbatim as `Idempotency-Key`. Reusing
 * one across a retry of the SAME file returns the original attachment rather
 * than storing a second copy (`replayed: true` says so). Reusing one with a
 * DIFFERENT file is a 409 by design, not a silent replay — the server hashes
 * the actual parts for multipart bodies precisely so that case is loud
 * (`PublicApiIdempotency`).
 */

import { z } from 'zod';
import type { WireItem, WireTaskAttachment } from '../api/types';
import { mapTaskAttachmentFromWire } from '../api/mapping';
import { defineTool, type ToolFactory } from './defineTool';
import { UNTRUSTED_CONTENT_NOTE, jsonToolResult } from './conventions';

const SCOPE = 'write:attachments';

/**
 * ~1 MB of characters. Not the server's limit — see the file docblock: this
 * bounds the TOOL ARGUMENT, which has to fit in a model's context, and a
 * request over it is rejected here rather than spending an upload on it.
 */
const MAX_CONTENT_CHARS = 1_000_000;

const DESCRIPTION =
  'Attach a file to a task by task id, by passing the file CONTENT as text (markdown, CSV, JSON, ' +
  'plain text, code). There is no path or filesystem argument — the content travels in this call, so ' +
  'this is for files you can write out here, not for files on disk elsewhere. For binary (a small ' +
  'image or PDF) set encoding to base64; prefer the Workel web app for anything large. filename ' +
  'sets the attachment name and its extension decides how Workel displays it, so include one ' +
  '(e.g. notes.md). Uploads count against the workspace storage plan and some file types are ' +
  'refused for security (anything that renders as a page or script: .html, .svg, .js, .php and ' +
  'similar) — both surface as a clear error. A task id this key cannot see (different workspace, or ' +
  'an archived, private, or inbox project) and a nonexistent id both return not-found; this tool ' +
  'cannot tell those apart. An optional idempotency_key, reused across a retry of the exact same ' +
  'file, returns the ORIGINAL attachment instead of storing a second copy — `replayed` is true when ' +
  'that happened. Reusing the same key with a DIFFERENT file is rejected rather than silently ' +
  'replaying the first one. ' +
  UNTRUSTED_CONTENT_NOTE;

interface UploadAttachmentArgs {
  id: string;
  filename: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  content_type?: string;
  idempotency_key?: string;
}

/**
 * Decode the caller's content into bytes.
 *
 * base64 is validated rather than trusted: `Buffer.from(x, 'base64')`
 * silently DISCARDS every character outside the alphabet, so a caller who
 * passed utf8 text under `encoding: 'base64'` would otherwise get a
 * successfully-stored file full of garbage instead of an error. Re-encoding
 * and comparing is the cheapest way to catch that.
 */
function decodeContent(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  if (encoding === 'utf8') {
    return new Uint8Array(Buffer.from(content, 'utf8'));
  }

  const normalized = content.replace(/\s+/g, '');
  const decoded = Buffer.from(normalized, 'base64');

  if (decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw new Error(
      'content is not valid base64. Pass encoding "utf8" for text, or a correctly base64-encoded string.'
    );
  }

  return new Uint8Array(decoded);
}

export const workelUploadTaskAttachment: ToolFactory = (client) =>
  defineTool({
    name: 'workel_upload_task_attachment',
    description: DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
      filename: z.string().min(1).max(255),
      content: z.string().min(1).max(MAX_CONTENT_CHARS),
      encoding: z.enum(['utf8', 'base64']).optional(),
      content_type: z.string().min(1).max(255).optional(),
      idempotency_key: z.string().optional(),
    },
    annotations: {
      title: 'Upload task attachment',
      readOnlyHint: false,
      destructiveHint: false,
      // Two calls without an idempotency_key store two copies — the honest
      // answer is false, the same one workel_create_task gives.
      idempotentHint: false,
      openWorldHint: false,
    },
    scope: SCOPE,
    handler: async (args) => {
      const input = args as unknown as UploadAttachmentArgs;
      const bytes = decodeContent(input.content, input.encoding ?? 'utf8');

      const result = await client.postFile<WireItem<WireTaskAttachment>>(
        `/tasks/${encodeURIComponent(input.id)}/attachments`,
        {
          fileName: input.filename,
          bytes,
          // Omitted rather than guessed from the extension: the server
          // sniffs the real content anyway (and refuses script-bearing
          // types on that basis), so a client-side guess would only be a
          // second, weaker opinion.
          contentType: input.content_type,
        },
        { idempotencyKey: input.idempotency_key }
      );

      const attachment = mapTaskAttachmentFromWire(result.data.data);

      return jsonToolResult({ ...attachment, replayed: result.replayed ?? false });
    },
  });

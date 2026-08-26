/**
 * `workel_create_task_comment` — `POST /tasks/{id}/comments`
 * (`write:comments` scope — NOT `write:tasks`; comments have their own
 * scope on this surface, matching `routes/api/public/v1.php`'s
 * `key.scope:write:comments` middleware on this exact route).
 *
 * Registered only under the D5 double opt-in gate (`./registration.ts`):
 * this module only declares `scope: 'write:comments'` on its descriptor —
 * `registration.ts` is the sole place that decides whether this factory is
 * ever handed to `buildServer` at all.
 *
 * Verified directly against `StorePublicTaskCommentRequest` and
 * `TaskCommentsController::store`
 * (backend/services/laravel-backend/app/Http/{Requests,Controllers/Api/PublicApi/V1}/{StorePublicTaskCommentRequest,TaskCommentsController}.php):
 *
 * `mention_user_ids` is declared `prohibited` by the FormRequest — not
 * silently ignored: submitting one (even an empty array) 422s the WHOLE
 * request. No @-mention syntax is parsed out of `body` in v1 either; the
 * controller always passes an empty mention array to
 * `TaskCommentService::createComment()` regardless of what `body` contains.
 * Because of this, this tool's input schema has no `mention_user_ids` field
 * at all, and the wire body is built by naming `body` explicitly — never by
 * spreading the parsed input — so no key resembling a mention field can
 * ever reach the wire, regardless of what a caller forces onto the tool's
 * args object.
 *
 * The parent task is resolved through the SAME visible-project chain
 * `workel_get_task`/`workel_list_task_comments` use (`ChecksProjectVisibility`)
 * — a task outside it (foreign workspace, archived/private/inbox project,
 * or a genuinely nonexistent id) 404s before any comment is written, with
 * the exact same collapsed "not found" response the read side returns;
 * there is no existence oracle this tool could use to tell those cases
 * apart, and it does not try.
 *
 * Nothing else is pre-validated. `body`'s only client-side check is
 * non-empty; the server's own `max:10000` bound is left to surface as the
 * mapped upstream `validation_error` if exceeded, exactly like every other
 * field this surface's write tools don't duplicate a bound for.
 *
 * `idempotency_key` (D7, docs/MCP_SERVER_PLAN.md): forwarded verbatim to
 * `client.post`'s own `Idempotency-Key` header (`../api/client.ts`, T9),
 * the same way `workel_create_task` does — `PublicApiIdempotency` is
 * whole-group middleware on `/api/public/v1`'s POST routes
 * (routes/api/public/v1.php's file docblock: "every POST here honors
 * Idempotency-Key automatically"), so this route honors it exactly like
 * task creation does. Reusing the same `idempotency_key` on a retry returns
 * the ORIGINAL comment rather than creating a second one, and the result's
 * `replayed: true` says so plainly.
 */

import { z } from 'zod';
import type { WireItem, WireTaskComment } from '../api/types';
import { mapCreateCommentToWire, mapTaskCommentFromWire } from '../api/mapping';
import { defineTool, type ToolFactory } from './defineTool';
import { UNTRUSTED_CONTENT_NOTE, jsonToolResult } from './conventions';

const SCOPE = 'write:comments';

const DESCRIPTION =
  'Add a comment to a task by task id. Comments are plain text — no @-mention syntax is parsed out ' +
  'of body in v1, and there is no way to notify/mention a specific user through this tool: the server ' +
  'REJECTS the whole request (422) if a mention-style field is submitted at all, so this tool does not ' +
  'accept one and never sends one. A task id that is not visible to this API key (its project is ' +
  'archived, private, the inbox project, or in a different workspace, or the id is genuinely ' +
  'nonexistent) returns a not-found result either way — this tool cannot distinguish those cases and ' +
  "does not try. An optional idempotency_key, reused across a retry of the exact same call (e.g. when " +
  'unsure whether a previous call actually posted a comment), returns the ORIGINAL comment instead of ' +
  "creating a second one — the result's `replayed` field is true when that happened, false for a " +
  'freshly created comment. ' +
  UNTRUSTED_CONTENT_NOTE;

interface CreateCommentArgs {
  id: string;
  body: string;
  idempotency_key?: string;
}

export const workelCreateTaskComment: ToolFactory = (client) =>
  defineTool({
    name: 'workel_create_task_comment',
    description: DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
      body: z.string().min(1),
      idempotency_key: z.string().optional(),
    },
    annotations: {
      title: 'Create task comment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    scope: SCOPE,
    handler: async (args) => {
      const input = args as unknown as CreateCommentArgs;

      // Named explicitly, never spread: `mention_user_ids` (or any other
      // key a caller forces onto the raw args object) can never reach the
      // wire through this call site, independent of whatever
      // mapCreateCommentToWire itself does internally — see the file-level
      // docblock for why that matters specifically for this endpoint.
      const wireBody = mapCreateCommentToWire({ body: input.body });
      const result = await client.post<WireItem<WireTaskComment>>(
        `/tasks/${encodeURIComponent(input.id)}/comments`,
        wireBody,
        { idempotencyKey: input.idempotency_key }
      );
      const comment = mapTaskCommentFromWire(result.data.data);

      return jsonToolResult({ ...comment, replayed: result.replayed ?? false });
    },
  });

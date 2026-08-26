/**
 * `workel_list_task_activity` — `GET /tasks/{id}/activity` (`read:tasks`
 * scope, the same scope as the other task tools — activity is not its own
 * scope on this surface).
 *
 * The task's own history: created, every logged field change, and its
 * comments, newest first. Row selection on the server reuses the SAME
 * predicate the app's task-detail Activity panel uses, so this tool and the
 * UI can never show different histories for the same task.
 *
 * Two things are deliberately absent from every row:
 *
 * - Anything beyond who/what/when. The underlying `activity_logs` row also
 *   carries read state, subject payloads and comment snippets; none of it
 *   belongs on a timeline read by an integration, and the actor is `{id,
 *   name}` only — never an email or avatar.
 * - A machine-readable action type. `action` is the same human prose the app
 *   renders ("updated progress", "commented on", suffixed " via API" when the
 *   change came through this API). It is copy, and copy changes — branching
 *   on its exact text is how a caller breaks on a wording tweak.
 *
 * Unlike `workel_list_task_comments`, this listing IS ordered — newest
 * first — because a history is read backwards from now.
 */

import { z } from 'zod';
import type { WireCursorPage, WireTaskActivity } from '../api/types';
import { mapTaskActivityFromWire } from '../api/mapping';
import { listEnvelope, truncateText } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const DESCRIPTION =
  "List a task's activity history — who did what to it and when — newest first. Covers the task "
  + 'being created, each logged field change, and its comments. Each row is who acted (actor), what '
  + 'they did (action), and when (occurred_at); `action` is human-readable prose such as "updated '
  + 'progress" or "commented on" (suffixed " via API" when the change came through this API), NOT an '
  + 'enum — never branch on its exact wording. Rows that address one specific reader ("mentioned '
  + 'you...") are excluded, because "you" has no meaning on a shared timeline. A task id that is not '
  + 'visible to this API key (its project is archived, private, the inbox project, or in a different '
  + 'workspace, or the id is genuinely nonexistent) returns a not-found result either way. '
  + 'Paginated via an opaque `cursor`; a `null` next_cursor means there are no more pages. '
  + UNTRUSTED_CONTENT_NOTE;

export const workelListTaskActivity: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_task_activity',
    description: DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
      limit: limitSchema,
      cursor: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List task activity' },
    scope: 'read:tasks',
    handler: async (args) => {
      const { id, limit, cursor } = args as { id: string; limit: number; cursor?: string };
      const result = await client.get<WireCursorPage<WireTaskActivity>>(
        `/tasks/${encodeURIComponent(id)}/activity`,
        { limit, cursor }
      );
      const items = result.data.data.map((row) => {
        const mapped = mapTaskActivityFromWire(row);
        // `action` is short by construction, but it is server-stored text and
        // this is the only place it surfaces — bound it like any other
        // free-text field rather than trusting it to stay short.
        return { ...mapped, action: mapped.action === null ? null : truncateText(mapped.action) };
      });
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

/**
 * `workel_list_task_comments` — `GET /tasks/{id}/comments` (`read:tasks`
 * scope, same scope as the task tools — comments are not their own scope
 * on this surface).
 *
 * Returns every comment on the task, top-level and replies
 * alike — there is no threading filter. The parent task is resolved
 * through the same visible-project chain `workel_get_task` uses, so a
 * task outside it (or a genuinely nonexistent id) 404s before any comment
 * is queried — a non-visible task's comments are never enumerable through
 * this tool.
 *
 * There is no `workel_get_task_comment` tool and no way to fetch a single
 * comment on its own — `body` is truncated per row here (never omitted the
 * way a task/project's `description` is on their own list views) because
 * this list IS the only place a comment's text is ever visible through
 * this API.
 */

import { z } from 'zod';
import type { WireCursorPage, WireTaskComment } from '../api/types';
import { mapTaskCommentFromWire } from '../api/mapping';
import { listEnvelope, truncateText } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const DESCRIPTION =
  'List every comment on a task — top-level comments and replies together, with no threading '
  + 'filter available. The order returned is NOT chronological: sort by each comment\'s '
  + '`created_at` to find the newest — the last item on a page is not the latest comment. '
  + 'A task id that is not visible to this API key (its project is archived, private, the inbox '
  + 'project, or in a different workspace, or the id is genuinely nonexistent) returns a '
  + 'not-found result either way. There is no tool to fetch a single comment on its own — this '
  + "list is the only way to read a comment's body through this API. Paginated via an opaque "
  + '`cursor`; a `null` next_cursor means there are no more pages. '
  + UNTRUSTED_CONTENT_NOTE;

export const workelListTaskComments: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_task_comments',
    description: DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
      limit: limitSchema,
      cursor: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List task comments' },
    scope: 'read:tasks',
    handler: async (args) => {
      const { id, limit, cursor } = args as { id: string; limit: number; cursor?: string };
      const result = await client.get<WireCursorPage<WireTaskComment>>(
        `/tasks/${encodeURIComponent(id)}/comments`,
        { limit, cursor }
      );
      const items = result.data.data.map((comment) => {
        const mapped = mapTaskCommentFromWire(comment);
        return { ...mapped, body: truncateText(mapped.body) };
      });
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

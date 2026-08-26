/**
 * `workel_list_tasks` / `workel_get_task` — `GET /tasks` and
 * `GET /tasks/{id}` (`read:tasks` scope).
 *
 * A task is only reachable through a card belonging to a VISIBLE project
 * (`TasksController::visibleTasksQuery` — bound workspace, not inbox, not
 * archived, not private); a task outside that chain and a genuinely
 * nonexistent id both collapse to the same not-found result.
 *
 * Filter semantics — verified directly against `TasksController::applyFilters`,
 * not assumed:
 * - `due_before`/`due_after` compare with strict `<`/`>` against a task's due
 *   date — i.e. due_before and due_after are EXCLUSIVE of the date given (a
 *   task due exactly on that date is not returned by either).
 * - `updated_since` compares with `>=` — i.e. updated_since is INCLUSIVE (a
 *   task updated exactly at that instant IS returned).
 * - There is no text search filter on this endpoint at all — no `q`, no
 *   title/description match of any kind.
 */

import { z } from 'zod';
import type { WireCursorPage, WireTask } from '../api/types';
import { mapTaskFromWire } from '../api/mapping';
import { listEnvelope, omitLongText, truncateText } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const SCOPE = 'read:tasks';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const LIST_DESCRIPTION =
  'List tasks visible to this API key\'s workspace, optionally narrowed by project, column, ' +
  'completion, and due-date/update-time filters. due_before and due_after are EXCLUSIVE (a strict ' +
  '`<`/`>` comparison against the due date — a task due exactly on the given date is returned by ' +
  'neither), while updated_since is INCLUSIVE (`>=` — a task updated at exactly that instant IS ' +
  'returned). There is no text search on this endpoint — no title or description keyword filter ' +
  "exists; narrow by project_id/column_id/completed/dates instead, or fetch a page and read the " +
  "titles. Each task's `description` is omitted from this list view, and so are its cover image and " +
  'attachments (call workel_get_task for those); every other field is present. Paginated via an ' +
  'opaque `cursor`; a ' +
  '`null` next_cursor means there are no more pages. ' +
  UNTRUSTED_CONTENT_NOTE;

const GET_DESCRIPTION =
  'Fetch a single task by id — the full detail view. Includes everything the list view carries plus ' +
  'the full (possibly truncated) description, the task\'s cover image (cover_image, null when it has ' +
  'none), and its attachments (each with a downloadable url, size, and who uploaded it). For the ' +
  "task's history — who changed what and when — call workel_list_task_activity; for its discussion, " +
  'workel_list_task_comments. Cover image and attachments are read-only through this API: both are ' +
  'file uploads, so no tool can set them. A task id that ' +
  "does not exist, or that exists but isn't visible to this API key (its project is archived, " +
  'private, the inbox project, or in a different workspace), returns the same not-found result ' +
  'either way — this tool cannot be used to tell those cases apart. ' +
  UNTRUSTED_CONTENT_NOTE;

interface ListTasksArgs {
  limit: number;
  cursor?: string;
  project_id?: string;
  column_id?: string;
  completed?: boolean;
  due_before?: string;
  due_after?: string;
  updated_since?: string;
}

export const workelListTasks: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_tasks',
    description: LIST_DESCRIPTION,
    inputSchema: {
      limit: limitSchema,
      cursor: z.string().optional(),
      project_id: z.string().optional(),
      // Renamed on the wire to `card_id` (the server's vocabulary for a
      // board column) — see mapping.ts's file-level docblock on why every
      // rename happens explicitly rather than through a generic helper.
      column_id: z.string().optional(),
      completed: z.boolean().optional(),
      // The server accepts ONLY this exact shape for a date filter and
      // silently drops anything else rather than erroring — rejecting a
      // malformed date here, instead of silently forwarding a filter that
      // will be ignored, is more useful to a model than the server's own
      // permissive default.
      due_before: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD').optional(),
      due_after: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD').optional(),
      updated_since: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List tasks' },
    scope: SCOPE,
    handler: async (args) => {
      const {
        limit,
        cursor,
        project_id: projectId,
        column_id: columnId,
        completed,
        due_before: dueBefore,
        due_after: dueAfter,
        updated_since: updatedSince,
      } = args as unknown as ListTasksArgs;

      const result = await client.get<WireCursorPage<WireTask>>('/tasks', {
        limit,
        cursor,
        project_id: projectId,
        card_id: columnId,
        completed,
        due_before: dueBefore,
        due_after: dueAfter,
        updated_since: updatedSince,
      });
      const items = result.data.data.map((task) =>
        omitLongText(mapTaskFromWire(task) as unknown as Record<string, unknown>)
      );
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

export const workelGetTask: ToolFactory = (client) =>
  defineTool({
    name: 'workel_get_task',
    description: GET_DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Get task' },
    scope: SCOPE,
    handler: async (args) => {
      const { id } = args as { id: string };
      const result = await client.get<WireTask>(`/tasks/${encodeURIComponent(id)}`);
      const task = mapTaskFromWire(result.data);
      return jsonToolResult({
        ...task,
        description: task.description === null ? null : truncateText(task.description),
      });
    },
  });

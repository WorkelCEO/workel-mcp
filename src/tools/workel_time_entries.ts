/**
 * `workel_list_time_entries` — `GET /time-entries` (`read:time` scope; time
 * has its own scopes on this surface, NOT `read:tasks`).
 *
 * Time tracked on tasks: each row is one block of time someone ran a timer
 * for or logged by hand. Verified against `TimeEntriesController::index`:
 *
 * - Rows are limited to tasks on the workspace's visible projects (the same
 *   `ChecksProjectVisibility` chain every task tool uses), so time on an
 *   archived, private or inbox project never appears.
 * - `from` is inclusive and `to` is EXCLUSIVE, both compared against the
 *   entry's `started_at` (an entry belongs to the moment it started). Either
 *   accepts a date or a date-time; a bare date is midnight UTC. The window
 *   cannot exceed 400 days; the server rejects a wider one rather than
 *   narrowing it, so this tool does not pre-validate it.
 * - `task_id`, `project_id` and `user_id` narrow by exact id.
 * - A running timer is included, with `running: true` and `ended_at` /
 *   `duration_seconds` null: its elapsed time is now minus `started_at`.
 *
 * `note` is the tracker's own free text, so it is bounded like every other
 * free-text field and carries the untrusted-content note.
 */

import { z } from 'zod';
import type { WireCursorPage, WireTimeEntry } from '../api/types';
import { mapTimeEntryFromWire } from '../api/mapping';
import { listEnvelope, truncateText } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const DESCRIPTION =
  'List time tracked on tasks: each row is one block of time a person ran a timer for or logged by ' +
  'hand, with the task, its project, who tracked it, started_at, ended_at, duration_seconds, ' +
  'billable and an optional note. Narrow by task_id, project_id or user_id, and by from/to: from is ' +
  "inclusive and to is EXCLUSIVE, both compared against each entry's started_at, and either accepts " +
  'a date (midnight UTC) or a date-time; the window cannot exceed 400 days. A running timer appears ' +
  'with running: true and ended_at/duration_seconds null; its elapsed time is now minus started_at. ' +
  'To total time, add duration_seconds across the rows (and the running ones by hand). Only time on ' +
  "tasks of projects visible to this API key is returned. Paginated via an opaque `cursor`; a `null` " +
  'next_cursor means there are no more pages. ' +
  UNTRUSTED_CONTENT_NOTE;

export const workelListTimeEntries: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_time_entries',
    description: DESCRIPTION,
    inputSchema: {
      limit: limitSchema,
      cursor: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      task_id: z.string().optional(),
      project_id: z.string().optional(),
      user_id: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List time entries' },
    scope: 'read:time',
    handler: async (args) => {
      const { limit, cursor, from, to, task_id, project_id, user_id } = args as {
        limit: number;
        cursor?: string;
        from?: string;
        to?: string;
        task_id?: string;
        project_id?: string;
        user_id?: string;
      };
      const result = await client.get<WireCursorPage<WireTimeEntry>>('/time-entries', {
        limit,
        cursor,
        from,
        to,
        task_id,
        project_id,
        user_id,
      });
      const items = result.data.data.map((row) => {
        const mapped = mapTimeEntryFromWire(row);
        return { ...mapped, note: mapped.note === null ? null : truncateText(mapped.note) };
      });
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

/**
 * `workel_list_project_columns` — `GET /projects/{id}/cards`
 * (`read:projects` scope).
 *
 * A Workel "card" at this endpoint is a board COLUMN (a kanban list such as
 * "To Do" / "In Progress" / "Done"), never a task — `CardResource`'s own
 * docblock is explicit about this, and it's the single most likely
 * misreading of this endpoint's name, hence spelling it out in the tool
 * description itself rather than trusting the tool name alone to convey it.
 */

import { z } from 'zod';
import type { WireCursorPage, WireProjectColumn } from '../api/types';
import { mapProjectColumnFromWire } from '../api/mapping';
import { listEnvelope } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const DESCRIPTION =
  "List the board columns of a project. The order returned is not the board's display order — sort by each column's `order` field to reconstruct it. These columns are " +
  'kanban lists, not tasks — a column such as "To Do" or "Done" holds tasks but is not one itself; ' +
  'use workel_list_tasks with the returned column id (a task\'s `column_id`) to see the tasks inside ' +
  'one. `is_done` marks a column whose tasks are treated as complete. A project id that is not ' +
  "visible to this API key (archived, private, the inbox project, wrong workspace, or genuinely " +
  'nonexistent) returns a not-found result either way. Paginated via an opaque `cursor`; a `null` ' +
  'next_cursor means there are no more pages. ' +
  UNTRUSTED_CONTENT_NOTE;

export const workelListProjectColumns: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_project_columns',
    description: DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
      limit: limitSchema,
      cursor: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List project columns' },
    scope: 'read:projects',
    handler: async (args) => {
      const { id, limit, cursor } = args as { id: string; limit: number; cursor?: string };
      const result = await client.get<WireCursorPage<WireProjectColumn>>(
        `/projects/${encodeURIComponent(id)}/cards`,
        { limit, cursor }
      );
      const items = result.data.data.map(mapProjectColumnFromWire);
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

/**
 * `workel_list_events` — `GET /events` (`read:events` scope).
 *
 * Result set = events bound directly to the workspace OR to one of its
 * visible projects (`EventsController::index`); there is no per-project
 * filter argument on this endpoint at all — narrowing to one project's
 * events is not something this tool can do.
 *
 * Window semantics — verified directly against `EventsController::parseWindow`,
 * not assumed: `from`/`to` compare with `whereDate('date', '>='/'<=', ...)` —
 * i.e. from and to are INCLUSIVE of the boundary date itself. The window
 * between them cannot exceed the server's 400-day maximum; a wider window is
 * rejected by the server with a hard error rather than silently clamped, so
 * this tool does not attempt to pre-validate the window width itself.
 *
 * There is no `workel_get_event` tool — the server has no `GET /events/{id}`
 * endpoint at all, so a single event's full `description` is only ever
 * visible through this list (truncated, never omitted, for the same reason
 * `workel_list_task_comments` never omits `body`).
 */

import { z } from 'zod';
import type { WireCursorPage, WireEvent } from '../api/types';
import { mapEventFromWire } from '../api/mapping';
import { listEnvelope, truncateText } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const DESCRIPTION =
  "List events visible to this API key's workspace — events on the workspace itself, plus events " +
  'on any of its visible projects. There is no per-project filter; every visible event is returned, ' +
  "optionally narrowed by `from`/`to`. from and to are INCLUSIVE of the date given (compared with " +
  '`>=`/`<=` against each event\'s date), and the from/to window cannot exceed the server\'s 400-day ' +
  'maximum — a wider window is rejected outright rather than silently narrowed. There is no ' +
  "workel_get_event tool; an event's full description is only ever visible through this list " +
  '(truncated for a very long one, never dropped). Paginated via an opaque `cursor`; a `null` ' +
  'next_cursor means there are no more pages. ' +
  UNTRUSTED_CONTENT_NOTE;

export const workelListEvents: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_events',
    description: DESCRIPTION,
    inputSchema: {
      limit: limitSchema,
      cursor: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List events' },
    scope: 'read:events',
    handler: async (args) => {
      const { limit, cursor, from, to } = args as {
        limit: number;
        cursor?: string;
        from?: string;
        to?: string;
      };
      const result = await client.get<WireCursorPage<WireEvent>>('/events', { limit, cursor, from, to });
      const items = result.data.data.map((event) => {
        const mapped = mapEventFromWire(event);
        return { ...mapped, description: mapped.description === null ? null : truncateText(mapped.description) };
      });
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

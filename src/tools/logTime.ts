/**
 * `workel_log_time` — `POST /time-entries` (`write:time` scope — NOT
 * `write:tasks`; time has its own scope on this surface, matching
 * `routes/api/public/v1.php`'s `key.scope:write:time` on this route).
 *
 * Registered only under the D5 double opt-in gate (`./registration.ts`).
 *
 * Logs time that already happened, as the key's owner: there is no
 * start/stop timer over this API (a timer belongs to a person at a screen).
 * Verified against `TimeEntriesController::store`:
 *
 * - `duration_seconds` is 1 second to 24 hours. This tool takes
 *   `duration_minutes` instead, because people and agents say "45 minutes",
 *   and sends minutes × 60. The 24-hour bound is the server's to enforce; a
 *   longer value surfaces as the mapped upstream `validation_error`.
 * - `started_at` defaults to now minus the duration, so the time ends now.
 *   Time that would end in the future is refused by the server.
 * - The task must be on a visible project (`ChecksProjectVisibility`), or
 *   the server answers 422 on `task_id`.
 * - A locked workspace (over its plan) refuses new time like new tasks.
 *
 * `idempotency_key` is forwarded as the `Idempotency-Key` header, as for
 * every POST on this surface: a retry with the same key returns the ORIGINAL
 * entry, and the result's `replayed: true` says so.
 */

import { z } from 'zod';
import type { WireCreateTimeEntry, WireItem, WireTimeEntry } from '../api/types';
import { mapTimeEntryFromWire } from '../api/mapping';
import { defineTool, type ToolFactory } from './defineTool';
import { UNTRUSTED_CONTENT_NOTE, jsonToolResult } from './conventions';

const SCOPE = 'write:time';

const DESCRIPTION =
  'Log time already spent on a task, as the person who owns this API key — e.g. "45 minutes on the ' +
  'client report". duration_minutes is required (the server allows up to 24 hours per entry). ' +
  'started_at (ISO 8601) is optional and defaults to now minus the duration, so the time ends now; ' +
  "time that would end in the future is refused. note is optional free text; billable defaults to " +
  'false. There is no way to start or stop a live timer through this tool. A task that is not ' +
  'visible to this API key returns a validation error on task_id. An optional idempotency_key, ' +
  'reused across a retry of the exact same call, returns the ORIGINAL entry instead of logging the ' +
  "time twice — the result's `replayed` field is true when that happened. " +
  UNTRUSTED_CONTENT_NOTE;

interface LogTimeArgs {
  task_id: string;
  duration_minutes: number;
  started_at?: string;
  note?: string;
  billable?: boolean;
  idempotency_key?: string;
}

export const workelLogTime: ToolFactory = (client) =>
  defineTool({
    name: 'workel_log_time',
    description: DESCRIPTION,
    inputSchema: {
      task_id: z.string().min(1),
      duration_minutes: z.number().int().min(1),
      started_at: z.string().optional(),
      note: z.string().optional(),
      billable: z.boolean().optional(),
      idempotency_key: z.string().optional(),
    },
    annotations: {
      title: 'Log time',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    scope: SCOPE,
    handler: async (args) => {
      const input = args as unknown as LogTimeArgs;

      // Named field by field, never spread, so nothing a caller forces onto
      // the args object (idempotency_key included) reaches the wire body.
      const wireBody: WireCreateTimeEntry = {
        task_id: input.task_id,
        duration_seconds: input.duration_minutes * 60,
      };
      if (input.started_at !== undefined) wireBody.started_at = input.started_at;
      if (input.note !== undefined) wireBody.note = input.note;
      if (input.billable !== undefined) wireBody.billable = input.billable;

      const result = await client.post<WireItem<WireTimeEntry>>('/time-entries', wireBody, {
        idempotencyKey: input.idempotency_key,
      });

      return jsonToolResult({ ...mapTimeEntryFromWire(result.data.data), replayed: result.replayed ?? false });
    },
  });

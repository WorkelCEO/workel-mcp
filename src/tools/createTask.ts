/**
 * `workel_create_task` — `POST /tasks` (`write:tasks` scope).
 *
 * Registered only under the D5 double opt-in gate (`./registration.ts`):
 * this module only declares `scope: 'write:tasks'` on its descriptor —
 * `registration.ts` is the sole place that decides whether this factory is
 * ever handed to `buildServer` at all.
 *
 * MCP-facing vocabulary matches every read tool's: `title`, `column_id`,
 * `project_id`, `due_date`, `due_time`, `assignee_ids`. The wire rename to
 * `title_text`/`card_id`/`end_date`/`end_time`/`user_ids` happens ONLY in
 * `../api/mapping.ts`'s `mapCreateTaskToWire` — never re-implemented here.
 *
 * Three client-side rejections (zero fetch calls), each verified directly
 * against `StorePublicTaskRequest`/`TasksController::store`
 * (backend/services/laravel-backend/app/Http/{Requests,Controllers/Api/PublicApi/V1}/{StorePublicTaskRequest,TasksController}.php):
 *
 * 1. `column_id` AND `project_id` both given. `TasksController::store`
 *    reads `card_id` first and, when present, never even looks at
 *    `project_id` at all (TasksController.php:227-237) — silently honoring
 *    one and ignoring the other would be a worse experience than an
 *    explicit rejection naming which one wins.
 * 2. Neither `column_id` nor `project_id` given. `project_id` is
 *    `required_without:card_id` on the wire (StorePublicTaskRequest.php:67);
 *    rejecting here with guidance toward `workel_list_project_columns` /
 *    `workel_list_projects` / `workel_get_project` is more useful than the
 *    wire's generic "the project id field is required" message.
 * 3. `due_time` given without `due_date`. `TasksController::store` silently
 *    drops an orphan `end_time` when `end_date` is empty
 *    (TasksController.php:293-298 — "we never persist a floating HH:mm with
 *    no day"), so a caller who set only `due_time` would see the create
 *    succeed with NO time set at all and no indication why.
 *
 * Nothing else is pre-validated. A non-member `assignee_ids` entry (rejected
 * whole-request with the `invalid_assignee` code, TasksController.php:273-286),
 * an unknown `column_id`/`project_id`, or an archived/private/inbox project
 * all go straight to the wire and come back as the mapped upstream error
 * (`../api/errors.ts`) — this tool does not re-implement or anticipate any
 * of those checks.
 *
 * `idempotency_key` (D7, docs/MCP_SERVER_PLAN.md): forwarded verbatim to
 * `client.post`'s own `Idempotency-Key` header (`../api/client.ts`, T9). The
 * client already auto-generates a fresh one for its OWN transport retries
 * (a timeout re-sending the identical request); this field exists for the
 * different case D7 names explicitly — a model unsure whether its own
 * earlier tool call actually landed. Reusing the same `idempotency_key` on a
 * retry returns the ORIGINAL task rather than creating a second one, and the
 * result's `replayed: true` says so plainly rather than leaving the caller
 * to guess from two visually-identical task objects.
 */

import { z } from 'zod';
import type { WireTask } from '../api/types';
import { mapCreateTaskToWire, mapTaskFromWire, type CreateTaskInput } from '../api/mapping';
import { defineTool, type ToolFactory, type ToolResult } from './defineTool';
import { UNTRUSTED_CONTENT_NOTE, jsonToolResult } from './conventions';

const SCOPE = 'write:tasks';

const PRIORITY_VALUES = ['low', 'medium', 'high', 'urgent', 'none'] as const;

const DESCRIPTION =
  'Create a new task. Provide EXACTLY ONE of column_id or project_id to place it: column_id puts it ' +
  "directly in that board column (a column's `id`, from workel_list_project_columns), while " +
  "project_id lets the server place it in that project's first open (not-done) column. Giving both " +
  'is rejected by this tool — the server would silently honor column_id and ignore project_id, and ' +
  'this tool refuses to do that quietly. Giving neither is also rejected; call ' +
  'workel_list_project_columns, workel_list_projects, or workel_get_project first to get one of them. ' +
  'due_time is only meaningful alongside due_date — the server silently drops a due_time given ' +
  'without a due_date, so this tool rejects that combination instead of creating a task with no time ' +
  'set and no explanation why. assignee_ids are validated against workspace membership on the ' +
  'server: any id that is not a member of this workspace rejects the ENTIRE request (no partial ' +
  'assignment) with a clear error — this tool does not pre-check membership itself, so that ' +
  'rejection, like any other server-side validation failure, is returned as-is. An optional ' +
  'idempotency_key, reused across a retry of the exact same call (e.g. when unsure whether a previous ' +
  "call actually created a task), returns the ORIGINAL task instead of creating a second one — the " +
  "result's `replayed` field is true when that happened, false for a freshly created task. " +
  UNTRUSTED_CONTENT_NOTE;

interface CreateTaskArgs {
  title: string;
  column_id?: string;
  project_id?: string;
  description?: string;
  priority?: (typeof PRIORITY_VALUES)[number];
  progress?: number;
  due_date?: string;
  due_time?: string;
  assignee_ids?: string[];
  idempotency_key?: string;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A well-formed client-side rejection — never a thrown exception, so it never invents a fake protocol-level failure for what is, structurally, an ordinary tool result. */
function rejection(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export const workelCreateTask: ToolFactory = (client) =>
  defineTool({
    name: 'workel_create_task',
    description: DESCRIPTION,
    inputSchema: {
      title: z.string().min(1),
      column_id: z.string().optional(),
      project_id: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(PRIORITY_VALUES).optional(),
      progress: z.number().int().optional(),
      due_date: z.string().optional(),
      due_time: z.string().optional(),
      assignee_ids: z.array(z.string()).optional(),
      idempotency_key: z.string().optional(),
    },
    annotations: {
      title: 'Create task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    scope: SCOPE,
    handler: async (args) => {
      const input = args as unknown as CreateTaskArgs;

      if (hasOwn(args, 'column_id') && hasOwn(args, 'project_id')) {
        return rejection(
          'Both column_id and project_id were given. The server only honors column_id when both are ' +
            'present — project_id would be silently ignored. Supply exactly one: column_id to target a ' +
            "specific board column, or project_id to let the server pick that project's first open column."
        );
      }

      if (!hasOwn(args, 'column_id') && !hasOwn(args, 'project_id')) {
        return rejection(
          'Neither column_id nor project_id was given — one is required to place the new task. Call ' +
            'workel_list_project_columns (or workel_get_project / workel_list_projects) to find a ' +
            'column_id or project_id first, then retry with one of them set.'
        );
      }

      if (hasOwn(args, 'due_time') && !hasOwn(args, 'due_date')) {
        return rejection(
          'due_time was given without due_date. The server silently drops due_time when due_date is ' +
            'absent, so this task would be created with no time set and no indication why. Supply ' +
            'due_date alongside due_time, or omit due_time.'
        );
      }

      // `input` still carries `idempotency_key` as an own property here, but
      // `mapCreateTaskToWire` only ever reads the eight fields it explicitly
      // checks (`../api/mapping.ts`) — an extra key is never copied onto the
      // wire body, so no stripping step is needed before this call.
      const wireBody = mapCreateTaskToWire(input as unknown as CreateTaskInput);
      const result = await client.post<WireTask>('/tasks', wireBody, {
        idempotencyKey: input.idempotency_key,
      });
      const task = mapTaskFromWire(result.data);

      return jsonToolResult({ ...task, replayed: result.replayed ?? false });
    },
  });

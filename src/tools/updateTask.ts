/**
 * `workel_update_task` — `PATCH /tasks/{id}` (`write:tasks` scope).
 *
 * Registered only under the D5 double opt-in gate (`./registration.ts`);
 * this module only declares `scope: 'write:tasks'`.
 *
 * PATCH semantics (verified against `UpdatePublicTaskRequest` and
 * `TaskUpdateService`, backend/services/laravel-backend/app/{Http/Requests/PublicApi/V1/UpdatePublicTaskRequest,Services/TaskUpdateService}.php):
 * a field OMITTED from the call is left untouched on the server; a field
 * EXPLICITLY given as `null` clears it (e.g. `due_date: null` clears the due
 * date, and the server's own orphan cleanup then also clears `due_time` if
 * it was set — TaskUpdateService.php:72-77 — since a time with no day makes
 * no sense). This tool builds the PATCH body by explicit
 * `hasOwnProperty`-based presence check, one field at a time, rather than by
 * dot-accessing a possibly-absent field into a new object literal — the
 * latter would fabricate an `undefined` value for every omitted field, which
 * only looks correct by accident (JSON.stringify happens to drop `undefined`
 * values) rather than because the field was ever actually treated as absent.
 * The wire rename itself (`title` -> `title_text`, `due_date` -> `end_date`,
 * `due_time` -> `end_time`) happens ONLY in `../api/mapping.ts`'s
 * `mapUpdateTaskToWire` — never re-implemented here.
 *
 * Board moves and assignee changes ARE supported (`column_id` -> `card_id`,
 * `assignee_ids` -> `user_ids`). An earlier revision of this file said the
 * opposite, and it was true then: `UpdatePublicTaskRequest::rules()` did not
 * declare either field, so there was no wire field to forward them through.
 * Both are now accepted and server-validated — the target column must sit in
 * a project the key can see, and every assignee must be a member of the key's
 * workspace.
 *
 * `assignee_ids` is REPLACEMENT, not append: the given array becomes the
 * assignee set, `[]` clears it, and omitting the key leaves it untouched. It
 * is deliberately NOT nullable in the tool schema — `null` and `[]` would
 * mean the same thing to the server, and offering two spellings of "clear"
 * invites a model to guess. `column_id` is likewise non-nullable: a task
 * always belongs to a column, and the server rejects a null with 422.
 *
 * `project_id` is still not exposed: a task's project follows its column, so
 * `column_id` alone says where the task should live, and a `project_id` that
 * disagreed with `column_id` would have no coherent meaning.
 *
 * `reminder_date` is likewise never exposed here even
 * though the wire endpoint accepts it — see `../api/mapping.ts`'s
 * file-level docblock (it is write-only over this API; there is no read
 * endpoint that ever returns it, so exposing a field a caller can set but
 * never read back would break read/write symmetry).
 *
 * IMPORTANT capability note, verified directly against
 * `TasksController::update` vs. `TasksController::store`
 * (backend/services/laravel-backend/app/Http/Controllers/Api/PublicApi/V1/TasksController.php):
 * unlike `POST /tasks` — which requires `Permission::TASK_CREATE` on the
 * TARGET project before creating (TasksController.php:244-252) —
 * `PATCH /tasks/{id}` (TasksController.php:120-154) performs NO per-project
 * permission re-check at all. It only re-resolves the task through the same
 * visible-project chain `GET /tasks/{id}` already uses (bound workspace, not
 * archived, not private, not the inbox project — `ChecksProjectVisibility`)
 * — visibility, not project membership or role. A `write:tasks` key can
 * therefore update ANY task in ANY visible project in its own workspace,
 * regardless of whether the key's creator has any role or membership on
 * that specific project — a `write:tasks` key is workspace-wide for
 * updates, unlike task creation, which is project-scoped by the
 * `TASK_CREATE` permission check above. This is a real capability shape of
 * the underlying API, not something this tool works around.
 */

import { z } from 'zod';
import type { WireItem, WireTask } from '../api/types';
import { mapUpdateTaskToWire, mapTaskFromWire, type UpdateTaskInput } from '../api/mapping';
import { defineTool, type ToolFactory } from './defineTool';
import { UNTRUSTED_CONTENT_NOTE, jsonToolResult } from './conventions';

const SCOPE = 'write:tasks';

const PRIORITY_VALUES = ['low', 'medium', 'high', 'urgent', 'none'] as const;

const DESCRIPTION =
  'Update fields on an existing task by id, including MOVING it to a different column (column_id) ' +
  'and REASSIGNING it (assignee_ids). Every field is optional: an OMITTED field is left ' +
  'unchanged; a field EXPLICITLY set to null clears it (e.g. due_date: null clears the due date, ' +
  'which also clears due_time if it was set — a time cannot outlive its day). column_id moves the ' +
  'task to that column, which may belong to a DIFFERENT project — the task lands at the end of the ' +
  'destination column; get valid ids from workel_list_project_columns. assignee_ids REPLACES the ' +
  'assignee set rather than adding to it, so pass the complete list you want (send [] to clear all ' +
  'assignees, or omit the field to leave assignees alone) — read the current set from ' +
  'workel_get_task first if you mean to add someone. A cover image and attachments are readable ' +
  'via workel_get_task but cannot be set here: both are file uploads, not values. IMPORTANT: a write:tasks API key ' +
  'can update ANY task in ANY project visible to its workspace, regardless of whether the key\'s ' +
  "creator is actually a member of that specific project — this endpoint performs no per-project " +
  'permission check the way task CREATION does. Treat this tool as workspace-wide for existing ' +
  'tasks, not scoped to projects the key\'s creator personally belongs to. ' +
  UNTRUSTED_CONTENT_NOTE;

interface UpdateTaskArgs {
  id: string;
  title?: string | null;
  description?: string | null;
  priority?: (typeof PRIORITY_VALUES)[number] | null;
  progress?: number | null;
  due_date?: string | null;
  due_time?: string | null;
  column_id?: string;
  assignee_ids?: string[];
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export const workelUpdateTask: ToolFactory = (client) =>
  defineTool({
    name: 'workel_update_task',
    description: DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      priority: z.enum(PRIORITY_VALUES).nullable().optional(),
      progress: z.number().int().nullable().optional(),
      due_date: z.string().nullable().optional(),
      due_time: z.string().nullable().optional(),
      // Non-nullable on purpose — see the file-level docblock.
      column_id: z.string().min(1).optional(),
      assignee_ids: z.array(z.string().min(1)).optional(),
    },
    annotations: {
      title: 'Update task',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    scope: SCOPE,
    handler: async (args) => {
      const { id } = args as { id: string };
      const typedArgs = args as unknown as UpdateTaskArgs;

      // Explicit per-field presence check — see the file-level docblock for
      // why this is not the same as dot-accessing each field into a fresh
      // object literal.
      const updateInput: UpdateTaskInput = {};
      if (hasOwn(args, 'title')) updateInput.title = typedArgs.title;
      if (hasOwn(args, 'description')) updateInput.description = typedArgs.description;
      if (hasOwn(args, 'priority')) updateInput.priority = typedArgs.priority;
      if (hasOwn(args, 'progress')) updateInput.progress = typedArgs.progress;
      if (hasOwn(args, 'due_date')) updateInput.due_date = typedArgs.due_date;
      if (hasOwn(args, 'due_time')) updateInput.due_time = typedArgs.due_time;
      if (hasOwn(args, 'column_id')) updateInput.column_id = typedArgs.column_id;
      if (hasOwn(args, 'assignee_ids')) updateInput.assignee_ids = typedArgs.assignee_ids;

      const wireBody = mapUpdateTaskToWire(updateInput);
      const result = await client.patch<WireItem<WireTask>>(`/tasks/${encodeURIComponent(id)}`, wireBody);
      const task = mapTaskFromWire(result.data.data);

      return jsonToolResult(task);
    },
  });

/**
 * The single place that translates between the MCP tool vocabulary and the
 * Workel Public API v1 wire vocabulary. Everything downstream (the HTTP
 * client, the tools themselves) speaks tool vocabulary only — if a field
 * pair is missing here it is silently wrong everywhere it's used, not just
 * here, so this module intentionally does the renaming explicitly per
 * endpoint rather than through a generic `renameKeys(obj, map)` helper: an
 * explicit mapper is what a reviewer can read directly against the spec.
 *
 * Write direction (tool input -> wire request body): the request-side
 * "Wire*" types live here rather than in `types.ts`, since `types.ts` is
 * scoped to wire *response* shapes. Authority for every field name and
 * nullability below is `docs/openapi/public-api-v1.yaml` PLUS the actual
 * FormRequest under `app/Http/Requests/PublicApi/V1/` (the FormRequest
 * wins on any disagreement — it's what the server actually validates).
 *
 * Read direction (wire response -> tool object): uses the `Wire*` response
 * types from `./types`.
 *
 * Deliberately NOT exposed in either direction: `reminder_date` on task
 * update. The wire endpoint (`UpdatePublicTaskRequest`) accepts it, but it
 * is write-only over this API (no read endpoint ever returns it) — exposing
 * a field a caller can set but never read back breaks the read/write
 * symmetry this seam exists to guarantee, so it is left out of the tool
 * vocabulary entirely rather than passed through.
 *
 * Also deliberately NOT exposed: `mention_user_ids` on task comments. The
 * FormRequest declares it `prohibited` (not silently ignored) — no
 * @-mention syntax is parsed in v1 — so the tool-facing comment input has
 * no such field to begin with, and `mapCreateCommentToWire` cannot forward
 * one even if a caller forces it in via a type cast.
 */

import type {
  Column,
  TaskActivity,
  TaskAttachment,
  TaskCover,
  Event,
  Member,
  Project,
  ProjectColumn,
  Task,
  TaskComment,
  TaskCommentAuthor,
  WireCard,
  WireTaskActivity,
  WireTaskAttachment,
  WireTaskCover,
  WireEvent,
  WireMember,
  WireProject,
  WireProjectColumn,
  WireTask,
  WireTaskComment,
  WireTaskCommentAuthor,
} from './types';

/**
 * True when `key` is an own, enumerable property of `obj` — used by every
 * write mapper below to decide "was this field actually given" as opposed
 * to "is its value falsy/undefined". An omitted key must be absent from the
 * returned wire object entirely; an explicitly given `null` must survive to
 * the wire as `null`. This is the one shared primitive that keeps that
 * distinction identical across all four write mappers — if it drifts, it
 * drifts everywhere at once and is easy to catch.
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------------------------------------------------------------------------
// Create task
// wire authority: backend/services/laravel-backend/app/Http/Requests/PublicApi/V1/StorePublicTaskRequest.php:63-77
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:733-770
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  column_id?: string | null;
  project_id?: string | null;
  title: string;
  description?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'none' | null;
  progress?: number | null;
  due_date?: string | null;
  due_time?: string | null;
  assignee_ids?: string[] | null;
}

export interface WireCreateTaskRequest {
  card_id?: string | null;
  project_id?: string | null;
  title_text: string;
  description?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'none' | null;
  progress?: number | null;
  end_date?: string | null;
  end_time?: string | null;
  user_ids?: string[] | null;
}

export function mapCreateTaskToWire(input: CreateTaskInput): WireCreateTaskRequest {
  const wire: WireCreateTaskRequest = { title_text: input.title };

  if (hasOwn(input, 'column_id')) wire.card_id = input.column_id;
  if (hasOwn(input, 'project_id')) wire.project_id = input.project_id;
  if (hasOwn(input, 'description')) wire.description = input.description;
  if (hasOwn(input, 'priority')) wire.priority = input.priority;
  if (hasOwn(input, 'progress')) wire.progress = input.progress;
  if (hasOwn(input, 'due_date')) wire.end_date = input.due_date;
  if (hasOwn(input, 'due_time')) wire.end_time = input.due_time;
  if (hasOwn(input, 'assignee_ids')) wire.user_ids = input.assignee_ids;

  return wire;
}

// ---------------------------------------------------------------------------
// Update task
// wire authority: backend/services/laravel-backend/app/Http/Requests/PublicApi/V1/UpdatePublicTaskRequest.php:60-71
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:772-800
//
// PATCH semantics: every field optional. No `column_id`/`assignee_ids` here
// at all — the wire endpoint does not accept them ("Assignees and
// project/card moves cannot be changed through this endpoint"). No
// `reminder_date` either — see the file-level docblock.
// ---------------------------------------------------------------------------

export interface UpdateTaskInput {
  title?: string | null;
  description?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'none' | null;
  progress?: number | null;
  due_date?: string | null;
  due_time?: string | null;
  column_id?: string;
  assignee_ids?: string[];
}

export interface WireUpdateTaskRequest {
  title_text?: string | null;
  description?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'none' | null;
  progress?: number | null;
  end_date?: string | null;
  end_time?: string | null;
  card_id?: string;
  user_ids?: string[];
  // The wire endpoint accepts `reminder_date` (nullable date-time) — this
  // mapper never sets it. See the file-level docblock for why.
  reminder_date?: string | null;
}

export function mapUpdateTaskToWire(input: UpdateTaskInput): WireUpdateTaskRequest {
  const wire: WireUpdateTaskRequest = {};

  if (hasOwn(input, 'title')) wire.title_text = input.title;
  if (hasOwn(input, 'description')) wire.description = input.description;
  if (hasOwn(input, 'priority')) wire.priority = input.priority;
  if (hasOwn(input, 'progress')) wire.progress = input.progress;
  if (hasOwn(input, 'due_date')) wire.end_date = input.due_date;
  if (hasOwn(input, 'due_time')) wire.end_time = input.due_time;
  // Board move + assignee replacement. `column_id -> card_id` is the same
  // rename `mapCreateTaskToWire` performs, and `assignee_ids -> user_ids`
  // matches its `user_ids` too — the two write mappers must agree on these
  // names or a move works on create and silently no-ops on update.
  if (hasOwn(input, 'column_id')) wire.card_id = input.column_id;
  if (hasOwn(input, 'assignee_ids')) wire.user_ids = input.assignee_ids;

  return wire;
}

// ---------------------------------------------------------------------------
// Create event
// wire authority: backend/services/laravel-backend/app/Http/Requests/PublicApi/V1/StorePublicEventRequest.php:52-78
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:816-877
//
// `title` is NOT renamed here — confirmed against both the FormRequest
// (`'title' => 'required|string|max:255'`, StorePublicEventRequest.php:55)
// and the OpenAPI schema (:820-822): the wire field for an event's title
// really is `title`, unlike a task's `title_text`. The six-pair table in
// the task brief lists `title -> title_text` without saying it's task-only;
// verifying it against the spec (as instructed) shows it doesn't apply to
// events, so the tool-side name (`title`) is kept unrenamed here per the
// spec, not per the table.
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  title: string;
  description?: string | null;
  date: string;
  start_time: string;
  end_time: string;
  reminder_at?: string | null;
  timezone?: string | null;
  reminder_minutes_before?: number | null;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  repeat_interval?: number | null;
  location?: string | null;
  meet_link?: string | null;
  color?: string | null;
  order?: number | null;
  project_id?: string | null;
  invited_user_ids?: string[] | null;
}

export interface WireCreateEventRequest {
  title: string;
  description?: string | null;
  date: string;
  start_time: string;
  end_time: string;
  reminder_at?: string | null;
  timezone?: string | null;
  reminder_minutes_before?: number | null;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  repeat_interval?: number | null;
  location?: string | null;
  meet_link?: string | null;
  color?: string | null;
  order?: number | null;
  project_id?: string | null;
  invited_users?: string[] | null;
}

export function mapCreateEventToWire(input: CreateEventInput): WireCreateEventRequest {
  const wire: WireCreateEventRequest = {
    title: input.title,
    date: input.date,
    start_time: input.start_time,
    end_time: input.end_time,
    repeat: input.repeat,
  };

  if (hasOwn(input, 'description')) wire.description = input.description;
  if (hasOwn(input, 'reminder_at')) wire.reminder_at = input.reminder_at;
  if (hasOwn(input, 'timezone')) wire.timezone = input.timezone;
  if (hasOwn(input, 'reminder_minutes_before')) wire.reminder_minutes_before = input.reminder_minutes_before;
  if (hasOwn(input, 'repeat_interval')) wire.repeat_interval = input.repeat_interval;
  if (hasOwn(input, 'location')) wire.location = input.location;
  if (hasOwn(input, 'meet_link')) wire.meet_link = input.meet_link;
  if (hasOwn(input, 'color')) wire.color = input.color;
  if (hasOwn(input, 'order')) wire.order = input.order;
  if (hasOwn(input, 'project_id')) wire.project_id = input.project_id;
  if (hasOwn(input, 'invited_user_ids')) wire.invited_users = input.invited_user_ids;

  return wire;
}

// ---------------------------------------------------------------------------
// Create task comment
// wire authority: backend/services/laravel-backend/app/Http/Requests/PublicApi/V1/StorePublicTaskCommentRequest.php:41-47
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:802-814
//
// No rename: the wire field is `body`, same as the tool-facing field.
// `mention_user_ids` is `prohibited` by the FormRequest, not merely
// unlisted — see the file-level docblock for why it has no place in
// `CreateCommentInput` at all.
// ---------------------------------------------------------------------------

export interface CreateCommentInput {
  body: string;
}

export interface WireCreateCommentRequest {
  body: string;
}

export function mapCreateCommentToWire(input: CreateCommentInput): WireCreateCommentRequest {
  return { body: input.body };
}

// ---------------------------------------------------------------------------
// Read direction
// ---------------------------------------------------------------------------

/**
 * Maps a task's embedded board-column ("card") to the tool vocabulary's
 * `column`. Field-for-field, no rename among {id, name, is_done} — only the
 * container's own name (`card` -> `column`) and the derived `column_id`
 * (built by `mapTaskFromWire`, not here) change.
 */
export function mapColumnFromWire(card: WireCard): Column {
  return {
    id: card.id,
    name: card.name,
    is_done: card.is_done,
  };
}

/**
 * Maps a wire Task response to the tool vocabulary. The nested `card`
 * object becomes `column`, plus a derived `column_id` equal to the card's
 * own id (both null when the task has no card). Every other field keeps
 * its wire name — the OpenAPI Task schema already uses tool-natural names
 * on read. Built field-by-field (never via object spread) so an unknown
 * key on the wire response is silently dropped rather than leaking through,
 * and so the literal key `card` can never appear anywhere in the output.
 */
export function mapTaskCoverFromWire(cover: WireTaskCover): TaskCover {
  return {
    url: cover.url,
    name: cover.name,
    type: cover.type,
    size: cover.size,
  };
}

export function mapTaskAttachmentFromWire(attachment: WireTaskAttachment): TaskAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    url: attachment.url,
    type: attachment.type,
    size: attachment.size,
    uploaded_by: attachment.uploaded_by
      ? { id: attachment.uploaded_by.id, name: attachment.uploaded_by.name }
      : null,
    created_at: attachment.created_at,
  };
}

export function mapTaskActivityFromWire(row: WireTaskActivity): TaskActivity {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
    occurred_at: row.occurred_at,
  };
}

export function mapTaskFromWire(task: WireTask): Task {
  const column = task.card ? mapColumnFromWire(task.card) : null;

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    project_id: task.project_id,
    column,
    column_id: task.card ? task.card.id : null,
    priority: task.priority,
    due_date: task.due_date,
    due_time: task.due_time,
    progress: task.progress,
    completed: task.completed,
    assignee_ids: task.assignee_ids,
    // Detail-only fields. `undefined` (the listing) is passed through as
    // undefined so the key is dropped from JSON output entirely, rather than
    // appearing as an explicit null that would read as "this task has no
    // attachments" when the truth is "this view does not report them".
    ...(task.cover_image !== undefined
      ? { cover_image: task.cover_image ? mapTaskCoverFromWire(task.cover_image) : null }
      : {}),
    ...(task.attachments !== undefined
      ? { attachments: task.attachments.map(mapTaskAttachmentFromWire) }
      : {}),
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Read direction (continued, T7) — Project, Member, ProjectColumn,
// TaskComment, Event.
//
// Every field on each of these five wire response shapes already carries its
// tool-facing name (verified field-by-field against the resource classes
// cited in `./types`) — none of these five needs a rename the way
// `mapTaskFromWire` does for `card` -> `column`. Each mapper below still
// exists, rather than passing the wire object straight through, for the same
// reason `mapTaskFromWire`'s docblock gives: built field-by-field so an
// unrecognized key on the wire response can never leak into tool output.
// ---------------------------------------------------------------------------

export function mapProjectFromWire(project: WireProject): Project {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

export function mapMemberFromWire(member: WireMember): Member {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    joined_at: member.joined_at,
  };
}

/**
 * The FULL board-column listing shape (`GET /projects/{id}/cards`) — see
 * `ProjectColumn`'s own docblock in `./types` for why this is a distinct
 * type/mapper from `mapColumnFromWire`'s narrower, Task-embedded `Column`.
 */
export function mapProjectColumnFromWire(card: WireProjectColumn): ProjectColumn {
  return {
    id: card.id,
    name: card.name,
    is_done: card.is_done,
    order: card.order,
  };
}

export function mapTaskCommentAuthorFromWire(author: WireTaskCommentAuthor): TaskCommentAuthor {
  return {
    id: author.id,
    name: author.name,
  };
}

export function mapTaskCommentFromWire(comment: WireTaskComment): TaskComment {
  return {
    id: comment.id,
    body: comment.body,
    author: comment.author ? mapTaskCommentAuthorFromWire(comment.author) : null,
    created_at: comment.created_at,
  };
}

export function mapEventFromWire(event: WireEvent): Event {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    date: event.date,
    start_time: event.start_time,
    end_time: event.end_time,
    location: event.location,
    project_id: event.project_id,
    workspace_id: event.workspace_id,
    color: event.color,
    repeat: event.repeat,
    created_at: event.created_at,
    updated_at: event.updated_at,
  };
}

/**
 * Wire response shapes for the Workel Public API v1, and the tool-facing
 * shapes `mapping.ts` translates them into.
 *
 * `Wire*` types mirror `docs/openapi/public-api-v1.yaml` exactly — same
 * field names, same required/nullable shape — because that file (plus the
 * FormRequests under `app/Http/Requests/PublicApi/V1/` for the write side)
 * is the authority for wire vocabulary, not this comment or any design doc.
 * The tool-facing types (no `Wire` prefix) are what every MCP tool speaks;
 * keeping the two families textually distinct means a `WireTask` leaking
 * into code that expects a `Task` is a compile error, not a runtime bug.
 *
 * Types only — no runtime code, no functions. The translation itself lives
 * in `mapping.ts`.
 */

// ---------------------------------------------------------------------------
// Project
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:477-492
// ---------------------------------------------------------------------------

export interface WireProject {
  id: string;
  name: string;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Column (a Workel "card" — a board column such as "To Do"/"In Progress",
// not a task, per the Card schema's own description).
//
// This is deliberately the narrower shape embedded in a Task response
// (TaskCardSummary — id/name/is_done only), not the full board-column
// listing shape (Card, which additionally has `order`). The full listing
// shape belongs to whichever future task builds the `GET
// /projects/{id}/cards` tool; this task only needs the shape a Task's
// nested `card` object carries.
// spec (TaskCardSummary): backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:508-517
// spec (full Card, for reference/out of scope): backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:494-506
// ---------------------------------------------------------------------------

export interface WireCard {
  id: string;
  name: string;
  is_done: boolean;
}

export interface Column {
  id: string;
  name: string;
  is_done: boolean;
}

// ---------------------------------------------------------------------------
// ProjectColumn — the FULL board-column listing shape referenced above
// (`GET /projects/{id}/cards`, T7). Distinct from `WireCard`/`Column`
// (the narrower shape nested inside a Task response) rather than an
// extension of it: `order` is meaningful only for the standalone listing
// of a project's columns (it drives the display order of the board), and
// keeping the two types textually separate means a `Column` embedded in a
// `Task` can never be mistaken for a listing row that also carries `order`.
// `order` is a non-nullable `integer default 0` at the DB column level
// (no cast on the model) — never rendered null.
// spec: backend/services/laravel-backend/app/Http/Resources/PublicApi/V1/CardResource.php
// (this endpoint predates the OpenAPI spec's own Card schema at
// public-api-v1.yaml:494-506, which this resource matches field-for-field)
// ---------------------------------------------------------------------------

export interface WireProjectColumn {
  id: string;
  name: string;
  is_done: boolean;
  order: number;
}

export interface ProjectColumn {
  id: string;
  name: string;
  is_done: boolean;
  order: number;
}

// ---------------------------------------------------------------------------
// Member
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:651-672
// ---------------------------------------------------------------------------

export type MemberRole = 'owner' | 'admin' | 'member' | null;

export interface WireMember {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  joined_at: string | null;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  joined_at: string | null;
}

// ---------------------------------------------------------------------------
// Task
//
// The wire shape's `card` field (a nullable WireCard) becomes `column` +
// a derived `column_id` on the tool-facing Task — see `mapTaskFromWire` in
// mapping.ts. Every other field keeps its name: the OpenAPI Task schema
// already uses tool-natural names (`title`, `due_date`, `due_time`,
// `assignee_ids`, ...) on read — only the WRITE endpoints (StorePublicTaskRequest
// / UpdatePublicTaskRequest) use the differently-named wire fields
// (`title_text`, `end_date`, `end_time`, `user_ids`).
//
// `priority` is freeform on read (whatever is stored), unlike the write
// endpoints which constrain it to a fixed enum — so it is typed as a bare
// nullable string here, not a union of the write-side literals.
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:519-577
// cross-checked against the actual serializer:
// backend/services/laravel-backend/app/Http/Resources/PublicApi/V1/TaskResource.php:43-66
// ---------------------------------------------------------------------------

/**
 * A task's cover image, or null when it has none. Read-only over this API:
 * covers are created by file upload, so there is no way to SET one from a
 * tool call — only to see the one that exists.
 */
export interface WireTaskCover {
  url: string | null;
  name: string | null;
  type: string | null;
  size: number | null;
}

export interface WireTaskAttachmentUploader {
  id: string;
  name: string;
}

export interface WireTaskAttachment {
  id: string;
  name: string | null;
  url: string | null;
  type: string | null;
  size: number | null;
  uploaded_by: WireTaskAttachmentUploader | null;
  created_at: string | null;
}

export interface WireTask {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  card: WireCard | null;
  priority: string | null;
  due_date: string | null;
  due_time: string | null;
  progress: number | null;
  completed: boolean;
  assignee_ids: string[];
  // Present on GET /tasks/{id} and the PATCH response; ABSENT from the
  // listing, which omits both so a page of tasks costs no extra queries.
  cover_image?: WireTaskCover | null;
  attachments?: WireTaskAttachment[];
  created_at: string | null;
  updated_at: string | null;
}

/**
 * One row of a task's history. `action` is human-readable prose ("created a
 * new task", "updated progress", "commented on", suffixed " via API" when the
 * change came through this API) — deliberately NOT an enum, so never branch
 * on its exact text.
 */
export interface WireTaskActivity {
  id: string;
  action: string | null;
  actor: WireTaskAttachmentUploader | null;
  occurred_at: string | null;
}

export interface TaskCover {
  url: string | null;
  name: string | null;
  type: string | null;
  size: number | null;
}

export interface TaskAttachmentUploader {
  id: string;
  name: string;
}

export interface TaskAttachment {
  id: string;
  name: string | null;
  url: string | null;
  type: string | null;
  size: number | null;
  uploaded_by: TaskAttachmentUploader | null;
  created_at: string | null;
}

export interface TaskActivity {
  id: string;
  action: string | null;
  actor: TaskAttachmentUploader | null;
  occurred_at: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  column: Column | null;
  column_id: string | null;
  priority: string | null;
  due_date: string | null;
  due_time: string | null;
  progress: number | null;
  completed: boolean;
  assignee_ids: string[];
  // Detail-only, mirroring the wire shape: undefined on a listed task,
  // present (possibly null / empty) on a fetched one.
  cover_image?: TaskCover | null;
  attachments?: TaskAttachment[];
  created_at: string | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// TaskComment
// spec (TaskCommentAuthor): backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:579-586
// spec (TaskComment): backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:588-600
// ---------------------------------------------------------------------------

export interface WireTaskCommentAuthor {
  id: string;
  name: string;
}

export interface TaskCommentAuthor {
  id: string;
  name: string;
}

export interface WireTaskComment {
  id: string;
  body: string;
  author: WireTaskCommentAuthor | null;
  created_at: string | null;
}

export interface TaskComment {
  id: string;
  body: string;
  author: TaskCommentAuthor | null;
  created_at: string | null;
}

// ---------------------------------------------------------------------------
// Event
//
// The read shape is deliberately thinner than the create-event write
// request — it has no `reminder_at`, `timezone`, `reminder_minutes_before`,
// `repeat_interval`, `meet_link`, `order`, or `invited_users`. Those are
// write-only fields on this surface; there is nothing to rename here since
// nothing on this shape differs from its tool-facing name.
// spec: backend/services/laravel-backend/docs/openapi/public-api-v1.yaml:602-649
// ---------------------------------------------------------------------------

export type EventRepeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | null;

export interface WireEvent {
  id: string;
  title: string;
  description: string | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  project_id: string | null;
  workspace_id: string | null;
  color: string | null;
  repeat: EventRepeat;
  created_at: string | null;
  updated_at: string | null;
}

export interface Event {
  id: string;
  title: string;
  description: string | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  project_id: string | null;
  workspace_id: string | null;
  color: string | null;
  repeat: EventRepeat;
  created_at: string | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Pagination envelope (T7)
//
// Every list endpoint on this surface wraps its rows in this exact shape —
// `{data: [...], meta: {next_cursor}}` — never a bare array and never the
// tool-facing `{items, next_cursor}` shape `output.ts`'s `listEnvelope`
// produces (those are two different envelopes for two different layers: this
// one is what the wire sends, that one is what a tool hands back). `T` is
// always one of the `Wire*` response types above.
// spec: backend/services/laravel-backend/app/Http/Responses/PublicApi/CursorPage.php
// ---------------------------------------------------------------------------

export interface WireCursorPage<T> {
  data: T[];
  meta: {
    next_cursor: string | null;
  };
}

// ---------------------------------------------------------------------------
// Single-resource envelope
//
// The sibling of `WireCursorPage` for endpoints that return ONE record rather
// than a page: `{data: {...}}`, with no `meta`. Every single-object endpoint on
// this surface wraps its record this way — a `show()` response and the body a
// `store()`/`update()` echoes back alike — because they are all Laravel API
// Resources, and a Resource always wraps.
//
// This type exists to make that wrapping impossible to forget. Declaring a
// handler's response as the bare `Wire*` type instead type-checks perfectly
// while handing the envelope to the mapper, which then reads every field off
// the wrapper and finds nothing: `workel_get_task` threw
// "Cannot read properties of undefined (reading 'length')" on the absent
// `description`, and `workel_update_task` reported `column_id: null` for a
// board move that had in fact succeeded. Both were invisible to the suite
// because the fixtures mocked a bare record rather than a wrapped one.
//
// `workel_whoami` is the one endpoint that does NOT wrap — it is a plain JSON
// response, not a Resource — so it correctly reads `result.data` directly.
// spec: Laravel `JsonResource` / `$wrap = 'data'`
// ---------------------------------------------------------------------------

export interface WireItem<T> {
  data: T;
}

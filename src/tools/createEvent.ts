/**
 * `workel_create_event` — `POST /events` (`write:events` scope).
 *
 * Registered only under the D5 double opt-in gate (`./registration.ts`);
 * this module only declares `scope: 'write:events'`.
 *
 * MCP-facing vocabulary matches `../api/mapping.ts`'s `CreateEventInput`
 * field-for-field (verified against `StorePublicEventRequest::rules()` and
 * `docs/openapi/public-api-v1.yaml:816-877`, both cited in that mapper's
 * own docblock) — every field keeps its wire name EXCEPT
 * `invited_user_ids`, which `mapCreateEventToWire` renames to
 * `invited_users` on the wire. `title` is NOT renamed here (unlike a
 * task's `title -> title_text`) — `mapping.ts` documents that it verified
 * this directly against both the FormRequest and the OpenAPI schema rather
 * than assuming task-create's rename table applies to events too.
 *
 * ONE client-side rejection (zero fetch calls), a zod cross-field check
 * this tool's flat `inputSchema` (a `Record<string, ZodTypeAny>` shape,
 * `./defineTool.ts`) cannot express on its own — a raw shape has no
 * object-level `.superRefine`, so `REPEAT_INTERVAL_REQUIREMENT_SCHEMA`
 * below is a SEPARATE small zod object, safeParsed inside the handler
 * itself, before any fetch: `repeat` other than `"none"` with no
 * `repeat_interval` given. Verified directly against
 * `StorePublicEventRequest::rules()` — `repeat_interval` is
 * `required_unless:repeat,none` (StorePublicEventRequest.php:64-69), so the
 * server would 422 that exact combination; rejecting it here up front, by
 * name, is more useful than spending a round trip to discover it.
 * `repeat` itself defaults to `"none"` (via this schema's own
 * `z.enum(...).default('none')`) when a caller omits it entirely.
 *
 * Nothing else is pre-validated:
 *
 * - `end_time` is NOT checked against `start_time` here. The server
 *   requires `end_time` strictly `after:start_time`
 *   (StorePublicEventRequest.php:59) and 422s otherwise — this tool sends
 *   whatever ordering it was given and returns that mapped upstream error
 *   as-is.
 * - `project_id` is NOT pre-checked for visibility. A foreign-workspace,
 *   private, inbox, or genuinely nonexistent project id all collapse to
 *   the SAME 422 on the wire (StorePublicEventRequest's `visibleProjectRule`
 *   closure) — there is no existence oracle for a caller to distinguish
 *   those cases through this tool, by design.
 * - `invited_user_ids` existence is checked on the wire
 *   (`exists:users,id`) but workspace MEMBERSHIP is deliberately NOT: a
 *   real user id who is not a member of this workspace is silently
 *   dropped by `EventsController`'s invite-context filter rather than
 *   rejected, while a genuinely nonexistent user id 422s the ENTIRE
 *   request. This tool does not pre-check either case — see the
 *   description text below, which tells a caller to confirm ids with
 *   `workel_list_members` first specifically because this asymmetry is
 *   otherwise invisible until a request half-succeeds.
 *
 * `idempotency_key` (D7, docs/MCP_SERVER_PLAN.md): forwarded verbatim to
 * `client.post`'s own `Idempotency-Key` header (`../api/client.ts`, T9) —
 * `PublicApiIdempotency` is whole-group middleware on every POST under
 * `/api/public/v1`, so this route honors it exactly like task/comment
 * creation does. Reusing the same `idempotency_key` on a retry returns the
 * ORIGINAL event rather than creating a second one, and the result's
 * `replayed: true` says so plainly.
 */

import { z } from 'zod';
import type { WireEvent } from '../api/types';
import { mapCreateEventToWire, mapEventFromWire, type CreateEventInput } from '../api/mapping';
import { defineTool, type ToolFactory, type ToolResult } from './defineTool';
import { UNTRUSTED_CONTENT_NOTE, jsonToolResult } from './conventions';

const SCOPE = 'write:events';

const REPEAT_VALUES = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;

const DESCRIPTION =
  'Create a new calendar event. repeat defaults to "none" when omitted. When repeat is anything else ' +
  '(daily/weekly/monthly/yearly), repeat_interval — an integer count of the repeat unit, e.g. 2 for ' +
  '"every 2 weeks" when repeat is weekly — is REQUIRED: this tool rejects the call up front, with no ' +
  'request sent, if repeat is not "none" and repeat_interval is missing, since the server would 422 ' +
  'that exact combination anyway. end_time must be strictly after start_time (both H:i-formatted ' +
  'times) — this tool does NOT pre-check that ordering itself; a bad combination is returned as the ' +
  "server's own validation error, unchanged. project_id (optional) scopes the event to a project " +
  'instead of the whole workspace; a foreign-workspace, private, inbox, or genuinely nonexistent ' +
  'project id all 422 the exact same way, by design — there is no way to tell those cases apart ' +
  'through this tool. invited_user_ids (optional): a nonexistent user id 422s the WHOLE request, but ' +
  'an existing user who simply is not a member of this workspace is silently DROPPED from the invite ' +
  'list rather than rejected — call workel_list_members first to confirm an id is both a real user AND ' +
  'a member of this workspace before inviting them, since a successful-looking response does not by ' +
  'itself prove everyone requested was actually invited. ' +
  UNTRUSTED_CONTENT_NOTE;

interface CreateEventArgs {
  title: string;
  description?: string;
  date: string;
  start_time: string;
  end_time: string;
  reminder_at?: string;
  timezone?: string;
  reminder_minutes_before?: number;
  repeat: (typeof REPEAT_VALUES)[number];
  repeat_interval?: number;
  location?: string;
  meet_link?: string;
  color?: string;
  order?: number;
  project_id?: string;
  invited_user_ids?: string[];
  idempotency_key?: string;
}

/** A well-formed client-side rejection — never a thrown exception, so it never invents a fake protocol-level failure for what is, structurally, an ordinary tool result. */
function rejection(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * The one cross-field rule `inputSchema` (a flat `Record<string,
 * ZodTypeAny>` shape) cannot express — see the file-level docblock. A
 * SEPARATE small zod object, safeParsed inside the handler before any
 * fetch; not part of the descriptor's own `inputSchema`.
 */
const REPEAT_INTERVAL_REQUIREMENT_SCHEMA = z
  .object({
    repeat: z.enum(REPEAT_VALUES),
    repeat_interval: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.repeat !== 'none' && data.repeat_interval === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repeat_interval'],
        message: 'repeat_interval is required when repeat is not "none".',
      });
    }
  });

export const workelCreateEvent: ToolFactory = (client) =>
  defineTool({
    name: 'workel_create_event',
    description: DESCRIPTION,
    inputSchema: {
      title: z.string().min(1),
      description: z.string().optional(),
      date: z.string().min(1),
      start_time: z.string().min(1),
      end_time: z.string().min(1),
      reminder_at: z.string().optional(),
      timezone: z.string().optional(),
      reminder_minutes_before: z.number().int().optional(),
      repeat: z.enum(REPEAT_VALUES).default('none'),
      repeat_interval: z.number().int().optional(),
      location: z.string().optional(),
      meet_link: z.string().optional(),
      color: z.string().optional(),
      order: z.number().int().optional(),
      project_id: z.string().optional(),
      invited_user_ids: z.array(z.string()).optional(),
      idempotency_key: z.string().optional(),
    },
    annotations: {
      title: 'Create event',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    scope: SCOPE,
    handler: async (args) => {
      const input = args as unknown as CreateEventArgs;

      const repeatCheck = REPEAT_INTERVAL_REQUIREMENT_SCHEMA.safeParse({
        repeat: input.repeat,
        repeat_interval: input.repeat_interval,
      });

      if (!repeatCheck.success) {
        return rejection(
          `repeat is "${input.repeat}" but repeat_interval was not given. repeat_interval (an integer ` +
            'count of the repeat unit — e.g. 2 for "every 2 weeks" when repeat is weekly) is required ' +
            'whenever repeat is anything other than "none". Supply repeat_interval, or set repeat to ' +
            '"none" to skip repetition.'
        );
      }

      const wireBody = mapCreateEventToWire(input as unknown as CreateEventInput);
      const result = await client.post<WireEvent>('/events', wireBody, {
        idempotencyKey: input.idempotency_key,
      });
      const event = mapEventFromWire(result.data);

      return jsonToolResult({ ...event, replayed: result.replayed ?? false });
    },
  });

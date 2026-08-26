/**
 * `workel_list_members` — `GET /members` (`read:members` scope).
 *
 * Lists only ACTIVE members of the bound workspace — a pending invitation
 * or a suspended membership is not a member yet, per
 * `MembersController`'s docblock. `id` on each row is the member's own
 * USER id (not a pivot-row id), so it can be used directly as an entry in
 * a task's `assignee_ids`.
 *
 * `email` is present here and nowhere else on this API surface — a
 * deliberate, scoped exception to the minimal-disclosure convention every
 * other tool follows (owner decision; gated behind this tool's own
 * `read:members` scope).
 */

import { z } from 'zod';
import type { WireCursorPage, WireMember } from '../api/types';
import { mapMemberFromWire } from '../api/mapping';
import { listEnvelope } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const DESCRIPTION =
  "List the active members of this API key's workspace: each member's user id, name, email, role " +
  '(owner/admin/member, or null), and when they joined. A pending invitation or a suspended ' +
  "membership is never included — only members who have actually joined. A member's `id` is the " +
  "same id used elsewhere on this API as a task's assignee id. Paginated via an opaque `cursor`; a " +
  '`null` next_cursor means there are no more pages. ' +
  UNTRUSTED_CONTENT_NOTE;

export const workelListMembers: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_members',
    description: DESCRIPTION,
    inputSchema: {
      limit: limitSchema,
      cursor: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List members' },
    scope: 'read:members',
    handler: async (args) => {
      const { limit, cursor } = args as { limit: number; cursor?: string };
      const result = await client.get<WireCursorPage<WireMember>>('/members', { limit, cursor });
      const items = result.data.data.map(mapMemberFromWire);
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

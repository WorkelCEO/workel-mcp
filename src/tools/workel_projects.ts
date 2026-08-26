/**
 * `workel_list_projects` / `workel_get_project` — `GET /projects` and
 * `GET /projects/{id}` (`read:projects` scope).
 *
 * Both tools operate on the bound workspace only — there is no workspace
 * argument to either tool, because the server derives the workspace from
 * the API key itself and ignores anything a caller could send (D3); this
 * client has no notion of "which workspace" to ask for.
 *
 * A project reachable through this endpoint is never an inbox project, an
 * archived project, or a private one — `ProjectsController::visibleProjects`
 * filters all three out server-side; a project outside that set simply
 * cannot be listed or fetched by id (a foreign/private/archived/nonexistent
 * id all collapse to the same `not_found` — see `errors.ts`'s
 * `not_found` message for why that's by design, not a bug).
 */

import { z } from 'zod';
import type { WireCursorPage, WireItem, WireProject } from '../api/types';
import { mapProjectFromWire } from '../api/mapping';
import { listEnvelope, omitLongText, truncateText } from '../output';
import { defineTool, type ToolFactory } from './defineTool';
import { READ_ANNOTATIONS, UNTRUSTED_CONTENT_NOTE, jsonToolResult, limitSchema } from './conventions';

const SCOPE = 'read:projects';

const LIST_DESCRIPTION =
  "List the projects visible to this API key's workspace. Never includes archived projects, " +
  'private projects, or the per-user inbox project — those are not reachable through this API at ' +
  "all. Each project's `description` is omitted from this list view (call workel_get_project for " +
  'the full description of one project); every other field is present. Results are ordered by id ' +
  'and paginated via an opaque `cursor` — pass the `next_cursor` from a previous call to get the ' +
  'next page; a `null` next_cursor means there are no more pages. ' +
  UNTRUSTED_CONTENT_NOTE;

const GET_DESCRIPTION =
  'Fetch a single project by id, including its full (possibly truncated) description. A project ' +
  "id that does not exist, or that exists but isn't visible to this API key (archived, private, " +
  'the inbox project, or in a different workspace), returns the same not-found result either way — ' +
  'this tool cannot be used to tell those cases apart. ' +
  UNTRUSTED_CONTENT_NOTE;

export const workelListProjects: ToolFactory = (client) =>
  defineTool({
    name: 'workel_list_projects',
    description: LIST_DESCRIPTION,
    inputSchema: {
      limit: limitSchema,
      cursor: z.string().optional(),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List projects' },
    scope: SCOPE,
    handler: async (args) => {
      const { limit, cursor } = args as { limit: number; cursor?: string };
      const result = await client.get<WireCursorPage<WireProject>>('/projects', { limit, cursor });
      const items = result.data.data.map((project) =>
        omitLongText(mapProjectFromWire(project) as unknown as Record<string, unknown>)
      );
      return jsonToolResult(listEnvelope(items, result.data.meta.next_cursor));
    },
  });

export const workelGetProject: ToolFactory = (client) =>
  defineTool({
    name: 'workel_get_project',
    description: GET_DESCRIPTION,
    inputSchema: {
      id: z.string().min(1),
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Get project' },
    scope: SCOPE,
    handler: async (args) => {
      const { id } = args as { id: string };
      const result = await client.get<WireItem<WireProject>>(`/projects/${encodeURIComponent(id)}`);
      const project = mapProjectFromWire(result.data.data);
      return jsonToolResult({
        ...project,
        description: project.description === null ? null : truncateText(project.description),
      });
    },
  });

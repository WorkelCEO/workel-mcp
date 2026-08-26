/**
 * The tool registry: every read tool this server exposes, as an array of
 * `ToolFactory` — ready to hand straight to `buildServer(client, caps,
 * READ_TOOLS)` (server.ts). Nine tools across seven modules (`workel_projects`
 * and `workel_tasks` each export two factories, one per read action their
 * backend controller exposes — `ProjectsController`/`TasksController` bundle
 * index+show the same way).
 *
 * `src/conventions.test.ts` treats this array as the live source of truth —
 * it never hand-copies the tool list, so adding, removing, or renaming a
 * tool here is exactly what that test's assertions react to.
 */

import type { ToolFactory } from './defineTool';
import { workelWhoami } from './workel_whoami';
import { workelListProjects, workelGetProject } from './workel_projects';
import { workelListProjectColumns } from './workel_project_columns';
import { workelListMembers } from './workel_members';
import { workelListTasks, workelGetTask } from './workel_tasks';
import { workelListTaskComments } from './workel_task_comments';
import { workelListEvents } from './workel_events';

export const READ_TOOLS: ToolFactory[] = [
  workelWhoami,
  workelListProjects,
  workelGetProject,
  workelListProjectColumns,
  workelListMembers,
  workelListTasks,
  workelGetTask,
  workelListTaskComments,
  workelListEvents,
];

export * from './conventions';

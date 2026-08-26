/**
 * Builds an MCP server instance with the caps-permitted tools registered.
 *
 * Deliberately transport-agnostic: `buildServer` takes no transport
 * argument and never calls `.connect()`. Attaching stdio (or, later, HTTP)
 * is the entrypoint's job, not this module's — a server this function
 * hands back can be connected to whatever transport the caller chooses.
 *
 * This module also has no business reading configuration or writing to any
 * stream directly: it takes an already-constructed API client and an
 * already-resolved capability set as plain arguments, nothing more. There
 * is no environment or stdio access here — see `src/config.ts` for where
 * startup actually resolves its configuration, and the entrypoint (a later
 * task) for where a transport gets chosen and attached.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations as SdkToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodTypeAny } from 'zod';
import type { WorkelApiClient } from './api/client';
import type { ToolDescriptor, ToolFactory, ToolResult } from './tools/defineTool';
import { z } from 'zod';
import { createWorkspaceRegistry, type WorkspaceRegistry } from './workspaces';
import { redact } from './api/redact';
import { VERSION } from './version';

/**
 * The set of Public API v1 scopes the caller's API key currently carries.
 * `buildServer` registers a tool iff it declares no `scope` at all, or its
 * `scope` is a member of this list — it never registers a tool the key
 * cannot use and lets the call fail later, which would let a client
 * discover capabilities its key doesn't actually have via a tool listing.
 */
export interface ServerCaps {
  scopes: string[];
}

const SERVER_NAME = 'workel';
/**
 * Read from package.json via ./version rather than duplicated as a literal:
 * `serverInfo.version` is what every connected host reports for this server,
 * so a stale literal silently misidentifies the build during an incident.
 */
const SERVER_VERSION = VERSION;

function isPermitted(descriptor: ToolDescriptor, caps: ServerCaps): boolean {
  return descriptor.scope === undefined || caps.scopes.includes(descriptor.scope);
}

/**
 * `ToolResult` (defineTool.ts) is deliberately looser than the SDK's own
 * tool-result type — e.g. `structuredContent?: unknown` vs. the SDK's
 * `Record<string, unknown> | undefined` — because defineTool.ts must not
 * import the SDK to know its exact shape. This module is the one place
 * allowed to bridge the two, with an explicit cast rather than a silent
 * structural coincidence: every registered tool's result flows through this
 * single conversion, so a real divergence between the two shapes (a handler
 * setting `structuredContent` to something the SDK truly can't carry) fails
 * at the SDK's own runtime validation on the way out — not inside this cast,
 * and not separately inside every tool's callback.
 */
function toSdkToolResult(result: ToolResult): CallToolResult {
  return result as unknown as CallToolResult;
}

/**
 * `McpServer#registerTool`'s generic signature infers a mapped argument type
 * from `inputSchema` at every call site — appropriate for a single,
 * statically-known tool, but it blows past TypeScript's instantiation-depth
 * limit once `inputSchema`'s static type is the fully dynamic
 * `Record<string, ZodTypeAny>` every descriptor carries here (there is no
 * way, at this call site, to know any one tool's concrete shape ahead of
 * time — that is the entire point of a runtime registry). Calling through
 * this narrower, non-generic method type keeps `name` / `description` /
 * `inputSchema` / `annotations` — and the handler's own return type —
 * checked, while opting out of the specific per-tool argument-shape
 * inference that the SDK's generic can't resolve for a dynamic shape.
 */
type RegisterToolMethod = (
  name: string,
  config: { description?: string; inputSchema?: Record<string, ZodTypeAny>; annotations?: SdkToolAnnotations },
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
) => unknown;

/** The argument every tool gains when more than one workspace is configured. */
export const WORKSPACE_ARG = 'workspace';

/**
 * Builds the `workspace` argument's schema. An enum rather than a free string:
 * the model sees the exact set of reachable workspaces in the tool definition
 * and picks one, instead of guessing a name and learning it was wrong from an
 * error. `resolve()` still validates, since a client may ignore the schema.
 */
function workspaceArgSchema(labels: string[]): ZodTypeAny {
  return z
    .enum(labels as [string, ...string[]])
    .describe(
      'Which Workel workspace to act in. Each workspace is reached through its own API key, ' +
        'and they are fully isolated from one another — a task or project in one is never ' +
        `visible from another. Available: ${labels.map((l) => `"${l}"`).join(', ')}.`
    );
}

/**
 * `tools` defaults to an empty registry — a later task supplies the real
 * list of tool factories here.
 *
 * Single-workspace entry point, and the shape every existing caller and test
 * uses. It delegates into the multi-workspace builder with a one-entry
 * registry rather than duplicating the registration loop, so there is exactly
 * one implementation of scope gating, schema construction and the redaction
 * backstop — two loops would drift, and the security-relevant half is the one
 * that would drift silently.
 */
export function buildServer(
  client: WorkelApiClient,
  caps: ServerCaps,
  tools: ToolFactory[] = [],
  displayName?: string
): McpServer {
  const registry = createWorkspaceRegistry([
    { id: 'default', name: 'default', keyName: 'default', scopes: caps.scopes, client },
  ]);
  return buildWorkspaceServer(registry, tools, displayName);
}

/**
 * Registers one tool per NAME regardless of how many workspaces are
 * configured, with the workspace as an argument.
 *
 * The alternative — one server process (or one registration) per workspace —
 * multiplies the tool count by the workspace count, and every tool definition
 * is context the model pays for on every turn. Here 9 tools stay 9 tools
 * whether the user has one workspace or twelve.
 *
 * Each workspace keeps its OWN client, and therefore its own workspace-bound
 * key: this multiplexes addressing, never authority. A request still carries
 * exactly one key, and the API's tenancy check is unchanged.
 */
export function buildWorkspaceServer(
  registry: WorkspaceRegistry,
  tools: ToolFactory[] = [],
  displayName?: string
): McpServer {
  // `displayName` exists for the HOSTED connector, where one OAuth token
  // resolves to exactly one workspace and a user may connect several. Each
  // connection is a separate registered OAuth client, so they coexist — but
  // they all reported the same static `workel`, leaving the user with N
  // identical entries and no way to tell which workspace a call would hit.
  // Reporting "workel — Acme" is the difference between that working in
  // principle and being usable.
  //
  // Unset for stdio, which addresses multiple workspaces through the
  // `workspace` tool argument instead and so has nothing to disambiguate.
  const server = new McpServer({ name: displayName ?? SERVER_NAME, version: SERVER_VERSION });
  const registerTool = server.registerTool.bind(server) as unknown as RegisterToolMethod;

  for (const factory of tools) {
    // One descriptor per workspace: each closes over its own workspace's
    // client, so dispatching is a map lookup rather than a client swap.
    const byWorkspaceId = new Map(registry.entries.map((entry) => [entry.id, factory(entry.client)]));
    const sample = byWorkspaceId.get(registry.entries[0].id) as ToolDescriptor;

    // Register when ANY key can use it. A key that lacks the scope is refused
    // per-call with a message naming the workspace — withholding the tool
    // entirely would hide it from the workspaces that CAN use it.
    if (!isPermitted(sample, { scopes: registry.unionScopes })) continue;

    const inputSchema = registry.isSingle
      ? sample.inputSchema
      : { [WORKSPACE_ARG]: workspaceArgSchema(registry.labels), ...sample.inputSchema };

    registerTool(
      sample.name,
      {
        description: sample.description,
        inputSchema,
        annotations: sample.annotations,
      },
      async (args) => {
        try {
          const { [WORKSPACE_ARG]: requested, ...toolArgs } = args;
          // Throws a message naming the valid workspaces, which the redaction
          // backstop below turns into an error result the model can act on.
          const entry = registry.resolve(typeof requested === 'string' ? requested : undefined);

          // Scopes are per-key, so a tool registered off the union may still be
          // unusable in THIS workspace. Refusing here — naming the workspace and
          // the missing scope — beats a bare 403 that says neither.
          if (sample.scope !== undefined && !entry.scopes.includes(sample.scope)) {
            throw new Error(
              `The API key for workspace "${entry.label}" does not carry the "${sample.scope}" scope, ` +
                `so ${sample.name} cannot be used there. Grant that scope to the key in ` +
                'Workel Settings → Developers, or target a workspace whose key already has it.'
            );
          }

          const descriptor = byWorkspaceId.get(entry.id) as ToolDescriptor;
          // `workspace` is this layer's addressing argument — the tools know
          // nothing about it, so it never reaches their handlers.
          return toSdkToolResult(await descriptor.handler(registry.isSingle ? args : toolArgs));
        } catch (err) {
          /**
           * The last line of defence before a throwable becomes model-visible
           * text. Only WorkelApiError is redacted upstream (client.ts); anything
           * else — notably undici embedding the whole Authorization header value
           * in a TypeError for a header-illegal key — would otherwise reach the
           * model verbatim, and from there the provider's logs and any exported
           * transcript. Never remove without replacing the redaction.
           */
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: redact(message) }], isError: true } as CallToolResult;
        }
      }
    );
  }

  return server;
}

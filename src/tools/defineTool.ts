/**
 * The tool-registration seam every MCP tool is declared through.
 *
 * This module knows nothing about any MCP SDK — deliberately, and that is
 * the whole point of its existence. The SDK's tool-registration API wants a
 * specific Zod-raw-shape/callback shape today; if that surface changes (an
 * SDK major-version move, or a switch to a different transport library
 * entirely), the fix is a change to `server.ts`'s adapter code only, never a
 * rewrite of every individual tool file that calls `defineTool()`. Importing
 * `zod` here is fine and expected — `inputSchema` genuinely IS a Zod raw
 * shape; that is how a tool declares its own parameters, not an SDK detail.
 *
 * `ToolResult` and `ToolAnnotations` are defined structurally below rather
 * than imported from an SDK package, for the same reason: they are the
 * minimal shapes a tool handler / a tool's metadata need, not whatever an
 * SDK's own richer internal type happens to look like today.
 */

import type { ZodTypeAny } from 'zod';
import type { WorkelApiClient } from '../api/client';

/**
 * The minimal shape every tool handler resolves to. A `text` content block
 * is all v1 tools need; `structuredContent` and `isError` are optional so a
 * handler that has nothing more to say than a plain string doesn't have to
 * populate them.
 */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Hints about a tool's behaviour (is it read-only, is it destructive, ...).
 * All optional — a tool that doesn't set any of these is simply making no
 * claim either way.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  annotations?: ToolAnnotations;
  handler: ToolHandler;
  /**
   * The Public API v1 scope this tool requires (e.g. `read:tasks`), or
   * absent for a tool that needs no per-key gate. `buildServer` (server.ts)
   * is the only reader of this field — it decides, per API key, which
   * descriptors actually get registered. A descriptor with no `scope`
   * always registers.
   */
  scope?: string;
}

/**
 * A tool module exports a factory, not a bare descriptor, so `buildServer`
 * is the single place that decides which client a tool talks to — a tool
 * module never constructs or imports a client of its own.
 */
export type ToolFactory = (client: WorkelApiClient) => ToolDescriptor;

/**
 * Identity function with a name. Its only job is to give every tool module
 * one, greppable, five-field shape (`name`, `description`, `inputSchema`,
 * `annotations`, `handler`) to declare a tool through, plus the optional
 * `scope` gate above — rather than every tool module hand-assembling a
 * plain object and hoping it matches what `server.ts` expects.
 */
export function defineTool(descriptor: ToolDescriptor): ToolDescriptor {
  return descriptor;
}

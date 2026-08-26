/**
 * The multi-workspace registry.
 *
 * A Workel API key is bound to exactly ONE workspace by the API — that binding
 * is the tenancy boundary and nothing in this client can widen it. So reaching
 * several workspaces means holding several keys, and this module is what turns
 * a set of probed keys into the addressing layer the tools use.
 *
 * The alternative — running one server process per workspace — costs the model
 * a full tool set per workspace (9 tools each, growing linearly). Here the tool
 * count is constant and the workspace becomes an argument instead.
 *
 * This module is deliberately pure: `boot.ts` does the `GET /me` probing and
 * hands the results in, so every case below (collisions, single vs. multi,
 * unknown labels) is testable without a network.
 */

import type { WorkelApiClient } from './api/client';

export interface WorkspaceEntry {
  /** Workspace id from `GET /me`. Stable; the label is not. */
  id: string;
  /** Workspace display name from `GET /me`. May collide across keys. */
  name: string;
  /**
   * How this workspace is addressed in tool arguments. Equal to `name` when
   * that is unambiguous, otherwise `name (id)` — a label must identify exactly
   * one workspace or a caller cannot target reliably.
   */
  label: string;
  /** The key's own name, for diagnostics. Never the key itself. */
  keyName: string;
  /** Scopes THIS key carries. Different keys may carry different scopes. */
  scopes: string[];
  /** The client bound to this workspace's key. */
  client: WorkelApiClient;
}

export interface WorkspaceRegistry {
  entries: WorkspaceEntry[];
  /** True when exactly one workspace is configured — the `workspace` argument is then optional. */
  isSingle: boolean;
  /** Every label, in configuration order. The enum offered to callers. */
  labels: string[];
  /** Union of scopes across all keys — what determines whether a tool registers at all. */
  unionScopes: string[];
  /**
   * Resolves a label to its workspace. With one workspace configured, an
   * omitted label resolves to it. With several, an omitted or unknown label
   * throws a message naming the valid choices — the model can correct itself
   * from that without a round trip to a human.
   */
  resolve(label: string | undefined): WorkspaceEntry;
}

export interface ProbedWorkspace {
  id: string;
  name: string;
  keyName: string;
  scopes: string[];
  client: WorkelApiClient;
}

/**
 * Two workspaces can legitimately share a display name — different orgs, or
 * the same name reused. Bare names would then be ambiguous, so ONLY the
 * colliding ones get their id appended; unique names stay clean, which is what
 * the overwhelmingly common single-workspace and distinct-name cases deserve.
 */
function assignLabels(probed: ProbedWorkspace[]): string[] {
  const counts = new Map<string, number>();
  for (const w of probed) counts.set(w.name, (counts.get(w.name) ?? 0) + 1);

  return probed.map((w) => ((counts.get(w.name) ?? 0) > 1 ? `${w.name} (${w.id})` : w.name));
}

export function createWorkspaceRegistry(probed: ProbedWorkspace[]): WorkspaceRegistry {
  if (probed.length === 0) {
    throw new Error('At least one workspace is required to build a registry.');
  }

  const labels = assignLabels(probed);
  const entries: WorkspaceEntry[] = probed.map((w, i) => ({
    id: w.id,
    name: w.name,
    label: labels[i],
    keyName: w.keyName,
    scopes: w.scopes,
    client: w.client,
  }));

  const byLabel = new Map(entries.map((e) => [e.label, e]));
  // Ids are always unambiguous, so accept them too — a caller that has an id
  // from a previous response should not have to translate it back to a name.
  const byId = new Map(entries.map((e) => [e.id, e]));

  const unionScopes = Array.from(new Set(entries.flatMap((e) => e.scopes)));
  const isSingle = entries.length === 1;

  return {
    entries,
    isSingle,
    labels: entries.map((e) => e.label),
    unionScopes,
    resolve(label: string | undefined): WorkspaceEntry {
      if (label === undefined || label.trim() === '') {
        if (isSingle) return entries[0];
        throw new Error(
          `This server is connected to ${entries.length} workspaces, so "workspace" is required. ` +
            `Valid values: ${entries.map((e) => `"${e.label}"`).join(', ')}.`
        );
      }

      const trimmed = label.trim();
      const found = byLabel.get(trimmed) ?? byId.get(trimmed);
      if (found) return found;

      throw new Error(
        `Unknown workspace "${trimmed}". This key set reaches: ` +
          `${entries.map((e) => `"${e.label}"`).join(', ')}. ` +
          'A workspace missing from that list needs its own API key added to WORKEL_API_KEYS.'
      );
    },
  };
}

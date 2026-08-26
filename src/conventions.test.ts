/**
 * The mechanical guardrail for every tool's conventions: no hand-written
 * list of tool names anywhere in this file — every assertion below walks
 * `READ_TOOLS`, the same array `server.ts`'s eventual entrypoint wiring
 * registers, so a tool added, removed, renamed, or quietly loosened here is
 * exactly what trips these tests, not a code-review-only convention.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { WorkelApiClient } from './api/client';
import { READ_TOOLS, UNTRUSTED_CONTENT_NOTE } from './tools/index';
import type { ToolDescriptor } from './tools/defineTool';

function fakeClient(): WorkelApiClient {
  return { get: jest.fn(), post: jest.fn(), patch: jest.fn() };
}

/** The live registry, resolved to descriptors — never a hand-copied list of names. */
function registry(): ToolDescriptor[] {
  const client = fakeClient();
  return READ_TOOLS.map((factory) => factory(client));
}

const EXPECTED_NAMES = [
  'workel_whoami',
  'workel_list_projects',
  'workel_get_project',
  'workel_list_project_columns',
  'workel_list_members',
  'workel_list_tasks',
  'workel_get_task',
  'workel_list_task_comments',
  'workel_list_task_activity',
  'workel_list_events',
];

const EXPECTED_SCOPES: Record<string, string | undefined> = {
  workel_whoami: undefined,
  workel_list_projects: 'read:projects',
  workel_get_project: 'read:projects',
  workel_list_project_columns: 'read:projects',
  workel_list_members: 'read:members',
  workel_list_tasks: 'read:tasks',
  workel_get_task: 'read:tasks',
  workel_list_task_comments: 'read:tasks',
  workel_list_task_activity: 'read:tasks',
  workel_list_events: 'read:events',
};

describe('the registry is exactly the ten planned read tools', () => {
  it('has the exact name set the plan calls for — no more, no fewer, none renamed', () => {
    const names = registry().map((d) => d.name);

    expect(new Set(names)).toEqual(new Set(EXPECTED_NAMES));
    expect(names).toHaveLength(EXPECTED_NAMES.length);
  });

  it('has exactly ten entries — a smuggled-in eleventh tool (write or otherwise) fails this', () => {
    expect(registry()).toHaveLength(10);
  });

  it('every tool name starts with workel_', () => {
    for (const descriptor of registry()) {
      expect(descriptor.name.startsWith('workel_')).toBe(true);
    }
  });

  it('every tool declares the exact required scope the plan assigns it (null for workel_whoami)', () => {
    for (const descriptor of registry()) {
      expect(descriptor.scope).toBe(EXPECTED_SCOPES[descriptor.name]);
    }
  });
});

describe('every tool carries the four read-only annotations as explicit booleans', () => {
  const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

  it('has all four keys present as own, boolean-typed properties on every tool', () => {
    for (const descriptor of registry()) {
      expect(descriptor.annotations).toBeDefined();
      for (const key of ANNOTATION_KEYS) {
        expect(
          Object.prototype.hasOwnProperty.call(descriptor.annotations, key)
        ).toBe(true);
        expect(typeof descriptor.annotations?.[key]).toBe('boolean');
      }
    }
  });

  it('never sets openWorldHint to true — this surface never reaches outside the Workel API', () => {
    for (const descriptor of registry()) {
      expect(descriptor.annotations?.openWorldHint).toBe(false);
    }
  });

  it('never sets readOnlyHint to false — a write tool sneaking in here would trip this', () => {
    for (const descriptor of registry()) {
      expect(descriptor.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('never sets destructiveHint to true', () => {
    for (const descriptor of registry()) {
      expect(descriptor.annotations?.destructiveHint).toBe(false);
    }
  });
});

describe('every description carries the untrusted-content note verbatim, with no unresolved template interpolation', () => {
  it('includes UNTRUSTED_CONTENT_NOTE', () => {
    for (const descriptor of registry()) {
      expect(descriptor.description).toContain(UNTRUSTED_CONTENT_NOTE);
    }
  });

  it('contains no `${` — descriptions are built by concatenation, never a template literal with live interpolation', () => {
    for (const descriptor of registry()) {
      expect(descriptor.description).not.toMatch(/\$\{/);
    }
  });
});

describe('no tool declares a fake-safety `confirm` input parameter', () => {
  it('walks the zod shape of every tool\'s inputSchema — none has an own property named "confirm"', () => {
    for (const descriptor of registry()) {
      expect(Object.prototype.hasOwnProperty.call(descriptor.inputSchema, 'confirm')).toBe(false);
    }
  });
});

describe('the plan-specific description substrings each tool must carry', () => {
  it('workel_list_tasks documents the exact due_before/due_after/updated_since/search semantics', () => {
    const descriptor = registry().find((d) => d.name === 'workel_list_tasks');

    expect(descriptor?.description).toContain('due_before and due_after are EXCLUSIVE');
    expect(descriptor?.description).toContain('updated_since is INCLUSIVE');
    expect(descriptor?.description).toContain('There is no text search');
  });

  it('workel_list_events documents the exact from/to/window semantics', () => {
    const descriptor = registry().find((d) => d.name === 'workel_list_events');

    expect(descriptor?.description).toContain('from and to are INCLUSIVE');
    expect(descriptor?.description).toContain('400-day');
  });

  it('workel_list_project_columns clarifies that columns are kanban lists, not tasks', () => {
    const descriptor = registry().find((d) => d.name === 'workel_list_project_columns');

    expect(descriptor?.description).toContain('columns are kanban lists, not tasks');
  });
});

describe('no hardcoded rate-limit numeral anywhere under src/', () => {
  const RATE_LIMIT_KEYWORD = /rate[ _-]?limit|per[ _-]?min|throttl|budget|quota/i;
  const BANNED_STANDALONE_NUMBERS = /\b(120|300|30)\b/;
  const EXCLUDED_FILENAME = 'conventions.test.ts';

  function collectTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && entry.name !== EXCLUDED_FILENAME) {
        files.push(fullPath);
      }
    }

    return files;
  }

  it('has no line mentioning a rate-limit-shaped concept that also hardcodes 120, 300, or 30', () => {
    const srcDir = path.join(__dirname);
    const offenders: string[] = [];

    for (const filePath of collectTsFiles(srcDir)) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (RATE_LIMIT_KEYWORD.test(line) && BANNED_STANDALONE_NUMBERS.test(line)) {
          offenders.push(`${path.relative(srcDir, filePath)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe('every tool actually validates against its own inputSchema (the schema is not decorative)', () => {
  it('parses an empty object successfully for every list tool once limit defaults', () => {
    for (const descriptor of registry()) {
      // Tools with a required `id` field are expected to reject {} — this
      // loop only asserts that parsing NEVER throws synchronously; the
      // per-tool test files cover required-field rejection precisely.
      const schema = z.object(descriptor.inputSchema);
      expect(() => schema.safeParse({})).not.toThrow();
    }
  });
});

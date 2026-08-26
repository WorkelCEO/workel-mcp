import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Reads the package version at module load time. Resolution tries `../package.json`
 * first (correct when running from a built `dist/`) and falls back to
 * `../../package.json` (correct when running from `src/` under ts-jest).
 */
function readPackageVersion(): string {
  const candidates = [join(__dirname, '../package.json'), join(__dirname, '../../package.json')];

  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // try the next candidate
    }
  }

  throw new Error('Unable to resolve package.json to determine the server version.');
}

/**
 * Injected at bundle time by wrangler (`define` in wrangler.jsonc). Declared,
 * never assigned — on Node it simply does not exist, and `typeof` on an
 * undeclared identifier is safe (it yields 'undefined' rather than throwing).
 */
declare const WORKEL_MCP_VERSION: string | undefined;

/**
 * Node reads package.json from disk; Workers cannot — it has no filesystem and
 * no `__dirname`, so the read below throws at MODULE LOAD and the whole Worker
 * fails to boot, not just the version lookup.
 *
 * The bundle-time constant is therefore checked first. This is not a fallback
 * for a failed read: on Workers the read must never be attempted at all.
 *
 * The obvious alternative — `import pkg from '../package.json'` — was rejected
 * because package.json sits outside `rootDir`, so enabling resolveJsonModule
 * drags it into the emitted dist tree and changes the published layout.
 *
 * Drift between the injected value and package.json is prevented by a test
 * (see server.redaction.test.ts), matching how RELEASING.md already pins the
 * version across package.json / manifest.json / server.json.
 */
export const VERSION: string =
  typeof WORKEL_MCP_VERSION !== 'undefined' ? WORKEL_MCP_VERSION : readPackageVersion();

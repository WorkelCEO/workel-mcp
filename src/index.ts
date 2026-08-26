#!/usr/bin/env node
/**
 * The stdio entrypoint. Thin by design: every real decision (config
 * validation, the `/me` probe, scope-gated tool registration, what gets
 * written to stderr) lives in `boot.ts`, which is transport-agnostic and
 * fully unit-tested without ever touching a real process or a real
 * transport. This file's only job is to supply `boot` with the real
 * process — real `process.env`, the real global `fetch`, real
 * stdout/stderr writers, real `process.exit` — and, once `boot` hands back
 * a constructed server, connect it to stdio.
 *
 * `doctor` (T12, `doctor.ts`) is checked BEFORE `boot()` runs and instead of
 * it, not in addition to it: doctor diagnoses a misconfigured setup, so it
 * must not itself depend on boot succeeding, and it never constructs or
 * connects a transport — there is no protocol stream to corrupt when the
 * process is about to exit right after printing its report.
 *
 * `main` takes `argv`/`deps` as explicit parameters (rather than reading
 * `process.argv`/`process.env`/etc. directly) purely so it is callable from
 * a test with no real process involved — the bottom-of-file call below is
 * the only place that supplies the real ones.
 *
 * The bottom-of-file call is guarded by `require.main === module` — the
 * standard CommonJS idiom for "only run this when the file is executed
 * directly, not when it's `require()`d". Without it, `doctor.test.ts`
 * importing `main` from this file for the argv-dispatch tests would ALSO
 * re-run the real entrypoint against the real `process.env`/`process.exit`
 * as an import-time side effect — in a test environment with no
 * `WORKEL_API_KEY` set, that calls the real `process.exit`, killing the
 * Jest worker. The guard changes nothing about how `node dist/index.js` (or
 * the `workel-mcp` bin) behaves: `require.main === module` is true on that
 * path, exactly as it always was.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { boot, type BootDeps } from './boot';
import { runDoctor } from './doctor';
import { installCrashHandlers } from './api/redact';

export async function main(argv: string[], deps: BootDeps): Promise<void> {
  if (argv[2] === 'doctor') {
    const code = await runDoctor(deps);
    deps.exit(code);
    return;
  }

  const result = await boot(deps);

  if (result === undefined) return;

  const transport = new StdioServerTransport();
  await result.server.connect(transport);
}

if (require.main === module) {
  void main(process.argv, {
    env: process.env,
    fetch,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    exit: (code) => process.exit(code),
    // Supplies the exit policy installCrashHandlers deliberately leaves to
    // its caller: an uncaught exception must end the process, not leave a
    // half-dead server attached to a live stdio transport.
    installCrashHandlers: (write) => installCrashHandlers(write, (code) => process.exit(code)),
  });
}

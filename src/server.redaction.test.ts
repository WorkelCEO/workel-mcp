import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer } from './server';
import { defineTool, type ToolFactory } from './tools/defineTool';
import { registerSecret, clearSecrets, PLACEHOLDER } from './api/redact';
import type { WorkelApiClient } from './api/client';

/**
 * These pin the tool-boundary redaction backstop added in 0.1.1.
 *
 * Before it, the ONLY redacted error path was WorkelApiError (scrubbed in
 * client.ts). Anything else a handler threw was handed to the MCP SDK, which
 * puts `error.message` verbatim into a text content block — and undici embeds
 * the entire Authorization header value in a TypeError when the header value is
 * illegal. A key containing an embedded control character therefore reached the
 * model in plaintext, and from there the provider's logs and any exported
 * transcript.
 */

function fakeClient(): WorkelApiClient {
  return { get: jest.fn(), post: jest.fn(), patch: jest.fn() } as unknown as WorkelApiClient;
}

/** Registers one tool whose handler throws `err`, then invokes it the way the SDK does. */
async function callThrowingTool(err: unknown) {
  const factory: ToolFactory = () =>
    defineTool({
      name: 'boom',
      description: 'a tool that throws',
      inputSchema: {},
      handler: async () => {
        throw err;
      },
    });

  const server = buildServer(fakeClient(), { scopes: [] }, [factory]);
  const registered = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools['boom'];

  return (await registered.handler({}, {})) as { isError?: boolean; content: { text: string }[] };
}

describe('tool-boundary redaction backstop', () => {
  const KEY = 'wk_9001SuperSecretPlaintextTokenValue0123456789';

  afterEach(() => clearSecrets());

  it('redacts a registered secret out of an arbitrary thrown Error before the model sees it', async () => {
    registerSecret(KEY);

    // Exactly the shape undici produces for a header-illegal Authorization value.
    const result = await callThrowingTool(
      new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value.`)
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(KEY);
    expect(result.content[0].text).toContain(PLACEHOLDER);
  });

  it('redacts a wk_-shaped token even when no secret was registered', async () => {
    // The remote transport deliberately does not call registerSecret; the
    // pattern fallback has to carry that path on its own.
    const result = await callThrowingTool(new Error(`upstream rejected ${KEY}`));

    expect(result.content[0].text).not.toContain(KEY);
  });

  it('returns an error result rather than letting the throwable escape buildServer', async () => {
    const result = await callThrowingTool(new Error('plain failure'));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('plain failure');
  });

  it('handles a non-Error throwable without crashing', async () => {
    const result = await callThrowingTool('a bare string');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('a bare string');
  });

  it('leaves a successful tool result untouched', async () => {
    const ok: ToolFactory = () =>
      defineTool({
        name: 'fine',
        description: 'a tool that works',
        inputSchema: {},
        handler: async () => ({ content: [{ type: 'text' as const, text: 'all good' }] }),
      });

    const server = buildServer(fakeClient(), { scopes: [] }, [ok]);
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
      ._registeredTools['fine'];
    const result = (await registered.handler({}, {})) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('all good');
  });
});

/**
 * Counterweight for the mutation the audit found: deleting `registerSecret()`
 * from boot/doctor left all 390 tests green, because every fixture key started
 * with `wk_` and so was caught by the pattern fallback regardless. An opaque key
 * can only be redacted by the registry, so this fails if the registry is bypassed.
 */
describe('the secret registry, not just the wk_ pattern, is doing the work', () => {
  const OPAQUE_KEY = 'opaque-key-not-wk-prefixed-0123456789';

  afterEach(() => clearSecrets());

  it('redacts an opaque key that the pattern fallback provably cannot match', async () => {
    registerSecret(OPAQUE_KEY);

    const result = await callThrowingTool(new Error(`Bearer ${OPAQUE_KEY} rejected`));

    expect(result.content[0].text).not.toContain(OPAQUE_KEY);
    expect(result.content[0].text).toContain(PLACEHOLDER);
  });

  it('leaks that same opaque key once the registry is cleared — proving the registry is load-bearing', async () => {
    clearSecrets();

    const result = await callThrowingTool(new Error(`Bearer ${OPAQUE_KEY} rejected`));

    expect(result.content[0].text).toContain(OPAQUE_KEY);
  });
});

describe('serverInfo.version is derived from package.json, never a literal', () => {
  it('reports the published package version over the protocol', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    ) as { version: string };

    const server = buildServer(fakeClient(), { scopes: [] }, []);
    const info = (server as unknown as { server: { _serverInfo: { version: string } } }).server._serverInfo;

    expect(info.version).toBe(pkg.version);
  });

  it('does not hardcode a version literal in server.ts', () => {
    const source = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');

    // A bare semver literal here is the bug: it silently misreports the build
    // to every connected host on the next release.
    expect(source).not.toMatch(/SERVER_VERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/);
  });
});

describe('the build produces what each transport actually starts', () => {
  const buildConfig = () =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tsconfig.build.json'), 'utf8')) as {
      exclude: string[];
    };

  // Two requirements that look opposed and are not:
  //
  //   - the CONTAINER needs dist/remote.js (its CMD starts it), so remote.ts
  //     must compile;
  //   - the npm TARBALL must not carry the remote transport — npx users can
  //     never reach it, and the CI workflow enforces this independently with
  //     its own `npm pack` check.
  //
  // Excluding remote.ts from the build satisfied only the second and produced
  // the worst outcome for the first: a build that SUCCEEDS and an image that
  // crashloops on a missing file. Building it and excluding it from `files`
  // (`!dist/remote.*` in package.json) satisfies both, so neither guard has to
  // be weakened.
  it('builds src/remote.ts, because the deployed container starts it', () => {
    expect(buildConfig().exclude).not.toContain('src/remote.ts');
  });

  it('keeps the remote transport out of the published tarball', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      files: string[];
    };

    // Mirrors the workflow's own `npm pack` assertion. Having it here too
    // means the conflict is caught by `npm test` rather than only in CI.
    expect(pkg.files).toContain('!dist/remote.*');
  });

  // The original concern this describe block was written for, kept: compiled
  // tests were roughly half the tarball.
  it('still excludes tests from the published build', () => {
    expect(buildConfig().exclude).toContain('**/*.test.ts');
  });

  it('injects the same version into the Worker bundle that package.json declares', () => {
    // Workers has no filesystem, so version.ts cannot read package.json at
    // runtime; wrangler injects it at bundle time instead. That makes a fourth
    // place a version can drift, alongside the three RELEASING.md already
    // pins — so it gets the same treatment.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    const wrangler = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

    const match = wrangler.match(/"WORKEL_MCP_VERSION"\s*:\s*"\\"([^\\]+)\\""/);

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(pkg.version);
  });

  it('starts the container from a file the build actually emits', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

    // Pins the pair that silently broke: whatever CMD names has to be
    // something `npm run build` produces.
    expect(dockerfile).toMatch(/CMD\s*\[\s*"node"\s*,\s*"dist\/remote\.js"\s*\]/);
    expect(buildConfig().exclude).not.toContain('src/remote.ts');
  });
});

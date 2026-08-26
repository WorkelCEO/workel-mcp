import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Pins the release-artifact files this package ships for later publishing
 * (`manifest.json` — the .mcpb bundle manifest — and `server.json` — the MCP
 * registry entry) against `package.json`, and pins that nothing in this
 * working tree looks like an actual publish already happened.
 *
 * This suite proves the *shape* of the artifacts and the *absence* of
 * publish side effects. It does not, and cannot, prove that a publish never
 * ran — see the "leaves no publish artifacts" test names and
 * RELEASING.md for why that distinction matters.
 */

// This file only ever runs under ts-jest from `src/`, never from a built
// `dist/` (there is no compiled test runner), so a single `..` is enough —
// unlike `version.ts`, which has to handle both locations.
const PACKAGE_ROOT = resolve(__dirname, '..');

const MANIFEST_PATH = resolve(PACKAGE_ROOT, 'manifest.json');
const SERVER_JSON_PATH = resolve(PACKAGE_ROOT, 'server.json');
const RELEASING_PATH = resolve(PACKAGE_ROOT, 'RELEASING.md');
const PACKAGE_JSON_PATH = resolve(PACKAGE_ROOT, 'package.json');

/** Reads a required file's raw text. Throws with the resolved path on a miss — never a silent skip. */
function readRequiredFile(absPath: string): string {
  if (!existsSync(absPath)) {
    throw new Error(`Required file is missing: ${absPath}`);
  }
  return readFileSync(absPath, 'utf8');
}

const manifestRaw = readRequiredFile(MANIFEST_PATH);
const serverJsonRaw = readRequiredFile(SERVER_JSON_PATH);
const releasingRaw = readRequiredFile(RELEASING_PATH);
const packageJsonRaw = readRequiredFile(PACKAGE_JSON_PATH);

// package.json is the one ground truth every artifact is pinned against —
// parsed once, unconditionally. If this throws, package.json itself is
// broken, which is a repo-wide problem far outside this suite's scope.
const packageJson = JSON.parse(packageJsonRaw) as {
  version: string;
  scripts?: Record<string, string>;
};

describe('release artifacts parse as valid JSON', () => {
  // Read-as-text-then-JSON.parse, deliberately not reusing any pre-parsed
  // value — a trailing comma or other malformed JSON must fail exactly
  // here, not surface as a confusing downstream property-access error.
  it('manifest.json is well-formed JSON', () => {
    expect(() => JSON.parse(manifestRaw)).not.toThrow();
  });

  it('server.json is well-formed JSON', () => {
    expect(() => JSON.parse(serverJsonRaw)).not.toThrow();
  });
});

// Safe to parse unconditionally below this point — the tests above already
// prove parseability, and a genuine parse failure there fails the suite
// loudly rather than being masked by a try/catch here.
const manifest = JSON.parse(manifestRaw) as {
  version?: string;
  user_config?: {
    workel_api_key?: { sensitive?: boolean; required?: boolean };
  };
  server?: { mcp_config?: { env?: Record<string, string> } };
};

const serverJson = JSON.parse(serverJsonRaw) as {
  version?: string;
  packages?: Array<{ registryType?: string; version?: string }>;
};

describe('version is pinned to package.json across every artifact', () => {
  // Three separate assertions so a partial version bump names exactly
  // which file was missed, rather than one assertion failing generically.
  it('manifest.json version matches package.json version', () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it('server.json top-level version matches package.json version', () => {
    expect(serverJson.version).toBe(packageJson.version);
  });

  it('server.json npm package entry version matches package.json version', () => {
    const npmPackage = (serverJson.packages ?? []).find((pkg) => pkg.registryType === 'npm');
    expect(npmPackage).toBeDefined();
    expect(npmPackage?.version).toBe(packageJson.version);
  });
});

describe('manifest.json wires the API key as required, sensitive user config', () => {
  it('declares workel_api_key as sensitive and required', () => {
    const userConfig = manifest.user_config?.workel_api_key;
    expect(userConfig?.sensitive).toBe(true);
    expect(userConfig?.required).toBe(true);
  });

  it('passes it to the server as WORKEL_API_KEY via the user_config expansion form', () => {
    expect(manifest.server?.mcp_config?.env?.WORKEL_API_KEY).toBe('${user_config.workel_api_key}');
  });
});

describe('no real-looking API key ever appears in a release artifact', () => {
  // A real Workel API key is shaped "wk_...". No file a person or a
  // publish step reads should ever contain that substring — a future edit
  // pasting a real key in to "test the manifest" must fail here.
  const KEY_SHAPE_SUBSTRING = 'wk_';

  it.each([
    ['manifest.json', () => manifestRaw],
    ['server.json', () => serverJsonRaw],
    ['RELEASING.md', () => releasingRaw],
  ])('%s never contains the wk_ key-shape substring', (_label, getText) => {
    expect(getText()).not.toContain(KEY_SHAPE_SUBSTRING);
  });
});

describe('package.json carries no lifecycle script that would run code on install', () => {
  // These are the npm lifecycle hooks that fire on `npm install`/`npm
  // publish` without an explicit invocation — the classic supply-chain
  // vector. None of them belong in this package's scripts. This is
  // deliberately a "did the work go too far" guard: it must fail if a
  // future change (including a well-intentioned build-on-install script)
  // adds one, not just if one happens to already exist.
  //
  // NARROWED after the security audit: the vector is a hook that runs on a
  // CONSUMER's machine at install time. `prepublishOnly` and `prepack` run
  // only on the maintainer's own machine during a release, so banning them
  // bought no safety and cost a real one — with `dist/` gitignored and no
  // build gate, a release cut from a fresh clone ships a tarball with no
  // `dist/` at all, leaving `bin` pointing at a file that does not exist
  // and `npx @workel/mcp` broken for every user.
  const FORBIDDEN_LIFECYCLE_SCRIPTS = [
    'preinstall',
    'install',
    'postinstall',
    // `prepare` reaches the consumer side too when installed from git.
    'prepare',
    'prepublish',
    'postpack',
  ];

  it('has no lifecycle hook that could execute on a consumer machine', () => {
    const scripts = packageJson.scripts ?? {};
    const present = FORBIDDEN_LIFECYCLE_SCRIPTS.filter((name) => name in scripts);
    expect(present).toEqual([]);
  });

  it('gates a release on a build and a green suite', () => {
    // The counterweight to the narrowing above: a release must not be able
    // to ship a tarball whose `bin` target was never compiled.
    const scripts = packageJson.scripts ?? {};
    expect(scripts.prepublishOnly).toBe('npm run build && npm test');
  });
});

describe('leaves no publish artifacts in the working tree', () => {
  // This proves ABSENCE of the byproducts a real `npm publish`/`mcpb
  // pack`/`npm login` would leave behind (a credentials file, a packed
  // bundle) — it is not, and cannot be, proof that no publish ever
  // happened. See RELEASING.md's "Status" section for that distinction.
  it('has no .npmrc file', () => {
    expect(existsSync(resolve(PACKAGE_ROOT, '.npmrc'))).toBe(false);
  });

  it('has no packed .mcpb bundle', () => {
    const entries = readdirSync(PACKAGE_ROOT);
    const mcpbFiles = entries.filter((name) => name.endsWith('.mcpb'));
    expect(mcpbFiles).toEqual([]);
  });
});

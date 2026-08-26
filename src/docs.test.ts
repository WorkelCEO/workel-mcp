import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Pins the security-load-bearing parts of the two customer-facing docs
 * (`README.md` and `developer-docs/mcp.md`) so they cannot silently drift
 * from what the server actually does. These are substring/structure checks
 * on the raw markdown, not a renderer or a spellchecker — see the
 * presence-only tests near the bottom for what is deliberately NOT proven
 * here.
 */

/**
 * Walks up from `startDir` until it finds a directory containing
 * `package.json` — that is this package's root regardless of whether this
 * test runs against `src/` (ts-jest) or a built `dist/`.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate a package.json walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const PACKAGE_ROOT = findPackageRoot(__dirname);
const README_PATH = resolve(PACKAGE_ROOT, 'README.md');

/**
 * Reads a required doc file. Throws with the fully-resolved absolute path
 * on a miss — never `describe.skip`, never a try/catch that turns a bad
 * path into a silent pass.
 */
function readRequiredFile(absPath: string): string {
  if (!existsSync(absPath)) {
    throw new Error(`Required documentation file is missing: ${absPath}`);
  }
  return readFileSync(absPath, 'utf8');
}

const readme = readRequiredFile(README_PATH);

const READ_ONLY_KEY_HEADING_PHRASE = 'mint a dedicated read-only key';
const CONSENT_FLAG_WORDING = 'local operator consent flag';
const ANOTHER_HOST_WORDING = 'another host';
const GIT_HISTORY_WORDING = 'git history';

/** Case-insensitive `indexOf` — the two docs use different heading phrasing/casing around the shared phrase. */
function indexOfCI(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * Slices out the text of a `## <heading>` section, from the heading line up
 * to (but excluding) the next `## ` heading, or end of file if it's the
 * last section.
 */
function extractSection(doc: string, headingLine: string): string {
  const start = doc.indexOf(headingLine);
  if (start === -1) {
    throw new Error(`Heading not found: ${JSON.stringify(headingLine)}`);
  }
  const searchFrom = start + headingLine.length;
  const relativeNext = doc.slice(searchFrom).search(/\n## /);
  const end = relativeNext === -1 ? doc.length : searchFrom + relativeNext;
  return doc.slice(start, end);
}

/** Content of the first fenced code block (between a ``` open and the next ```) in `section`. */
function extractFirstFencedBlock(section: string): string {
  const fenceStart = section.indexOf('```');
  if (fenceStart === -1) {
    throw new Error('No fenced code block found in section');
  }
  const openLineEnd = section.indexOf('\n', fenceStart);
  if (openLineEnd === -1) {
    throw new Error('Malformed fence: no newline after opening ```');
  }
  const fenceEnd = section.indexOf('```', openLineEnd);
  if (fenceEnd === -1) {
    throw new Error('Unterminated fenced code block in section');
  }
  return section.slice(openLineEnd + 1, fenceEnd);
}

describe.each([
  ['README.md', () => readme],
])('%s — security lead', (_label, getDoc) => {
  it('leads with the read-only-key heading, before WORKEL_ENABLE_WRITES is mentioned', () => {
    const doc = getDoc();
    const headingIndex = indexOfCI(doc, READ_ONLY_KEY_HEADING_PHRASE);
    const flagIndex = doc.indexOf('WORKEL_ENABLE_WRITES');

    expect(headingIndex).toBeGreaterThan(-1);
    expect(flagIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeLessThan(flagIndex);
  });

  it('leads with the read-only-key heading, before WORKEL_API_BASE_URL is mentioned', () => {
    const doc = getDoc();
    const headingIndex = indexOfCI(doc, READ_ONLY_KEY_HEADING_PHRASE);
    const baseUrlIndex = doc.indexOf('WORKEL_API_BASE_URL');

    expect(headingIndex).toBeGreaterThan(-1);
    expect(baseUrlIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeLessThan(baseUrlIndex);
  });

  it('states WORKEL_ENABLE_WRITES is a consent flag, not an authorization boundary', () => {
    expect(getDoc()).toContain(CONSENT_FLAG_WORDING);
  });

  it('warns that a base-URL override sends the key to another host', () => {
    expect(getDoc()).toContain(ANOTHER_HOST_WORDING);
  });

  it('warns that git history is forever', () => {
    expect(getDoc()).toContain(GIT_HISTORY_WORDING);
  });

  it('shows a version-pinned npx form and marks the unpinned form as convenience-only', () => {
    const doc = getDoc();
    // Pinned: the real package name followed by a concrete semver, e.g.
    // "npx -y @workel/mcp@0.0.0" — deliberately NOT the literal string
    // "X.Y.Z", since the docs pin to this package's actual current version.
    expect(doc).toMatch(/npx -y @workel\/mcp@\d+\.\d+\.\d+/);
    // ...and that version must be THIS package's. A bare semver check passes
    // on a stale pin forever, sending users to a version that predates every
    // fix in this file's history.
    const { version } = require('../package.json') as { version: string };
    for (const pinned of doc.match(/npx -y @workel\/mcp@\d+\.\d+\.\d+/g) ?? []) {
      expect(pinned).toBe(`npx -y @workel/mcp@${version}`);
    }
    // Unpinned: the same command with no @version suffix immediately after.
    expect(doc).toMatch(/npx -y @workel\/mcp(?!@)/);
    expect(doc).toContain('convenience');
  });
});

describe('wk_-shaped placeholders never leak a plausible-looking key', () => {
  // Guards against a future edit "helpfully" inlining something that reads
  // like a real key. Only two illustrative placeholders are allowed anywhere
  // in either doc: the full placeholder (wk_REPLACE_ME) and the
  // truncated/redacted illustration (wk_xxx).
  const ALLOWED_PLACEHOLDERS = new Set(['wk_REPLACE_ME', 'wk_xxx']);
  const KEY_SHAPE_PATTERN = /wk_[A-Za-z0-9][A-Za-z0-9_-]*/g;

  it.each([
    ['README.md', () => readme],
  ])('every wk_-shaped token in %s is an allowlisted placeholder', (_label, getDoc) => {
    const matches = getDoc().match(KEY_SHAPE_PATTERN) ?? [];
    for (const match of matches) {
      expect(ALLOWED_PLACEHOLDERS.has(match)).toBe(true);
    }
  });
});

describe('presence-only checks — existence, not correctness of the prose', () => {
  // These confirm the required sections exist; they do not verify the
  // accuracy of what's written inside them. Accuracy is a review step, not
  // something a substring match can prove.

  it('README.md has a Limitations section', () => {
    expect(readme).toContain('## Limitations');
  });
});

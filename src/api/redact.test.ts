import {
  PLACEHOLDER,
  registerSecret,
  clearSecrets,
  redact,
  redactDeep,
  formatCrash,
  installCrashHandlers,
} from './redact';

describe('redact', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('replaces every occurrence of a registered secret, including mid-word', () => {
    registerSecret('wk_live_abc123');
    const text = 'first wk_live_abc123 then wk_live_abc123 and prefixwk_live_abc123suffix';
    const result = redact(text);
    expect(result).not.toContain('wk_live_abc123');
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it('replaces an unregistered wk_-shaped token', () => {
    const result = redact('token=wk_live_unregistered999');
    expect(result).toBe(`token=${PLACEHOLDER}`);
  });

  it('leaks no contiguous 4-character slice of the secret', () => {
    registerSecret('wk_live_abcdefgh12345');
    const result = redact(`Bearer wk_live_abcdefgh12345`);
    expect(result).not.toContain('wk_live_abcdefgh12345');
    for (let i = 0; i <= 'wk_live_abcdefgh12345'.length - 4; i++) {
      const slice = 'wk_live_abcdefgh12345'.slice(i, i + 4);
      expect(result).not.toContain(slice);
    }
  });

  it('leaves a string containing no secret byte-for-byte unchanged', () => {
    const text =
      'network_wkflow status: wk enabled, bare wk_ prefix, regex chars .*+?^${}()|[]\\';
    expect(redact(text)).toBe(text);
  });

  it('does not redact a secret shorter than 4 characters', () => {
    registerSecret('abc');
    expect(redact('abc appears here')).toBe('abc appears here');
  });

  it('ignores an empty registered secret without corrupting unrelated text', () => {
    registerSecret('');
    const text = 'nothing special here';
    expect(redact(text)).toBe(text);
  });

  it('matches a secret containing regex metacharacters literally, not as a pattern', () => {
    const secret = 'sk-a+b.c*d';
    registerSecret(secret);

    expect(redact(`key=${secret}`)).toBe(`key=${PLACEHOLDER}`);

    // If the secret were used as an unescaped regex, `a+` (one-or-more 'a'),
    // `.` (any char), and `c*` (zero-or-more 'c') would ALSO match this
    // unrelated string — verified directly against the raw pattern below.
    // Escaped/literal matching must not redact it.
    const probe = 'value=sk-aabXd';
    expect(new RegExp(secret).test(probe)).toBe(true); // sanity: raw pattern DOES match
    expect(redact(probe)).toBe(probe); // literal/escaped matching does NOT
  });

  it('applies extraSecrets in addition to the registry', () => {
    registerSecret('registered-secret-1');
    const result = redact('registered-secret-1 and passed-secret-2', ['passed-secret-2']);
    expect(result).toBe(`${PLACEHOLDER} and ${PLACEHOLDER}`);
  });

  it('prefers the longer of two overlapping secrets so no fragment leaks', () => {
    // Deliberately not wk_-prefixed: the wk_ token pattern is independently
    // greedy and would consume the whole run regardless, which would mask
    // a bug in the longest-first ordering of the registry pattern itself.
    registerSecret('secret-abc');
    registerSecret('secret-abcdef');
    const result = redact('token secret-abcdef here');
    expect(result).toBe(`token ${PLACEHOLDER} here`);
    expect(result).not.toContain('def');
  });
});

describe('redactDeep', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('redacts a wk_ token nested at depth inside an object/array mix, preserving shape', () => {
    const input = {
      error: {
        message: 'invalid token wk_live_abc123',
        details: [{ code: 401, hints: ['check wk_live_abc123', 'retry'] }],
      },
      ok: false,
    };

    const result = redactDeep(input) as typeof input;

    expect(result.error.message).toBe(`invalid token ${PLACEHOLDER}`);
    expect(result.error.details[0].hints[0]).toBe(`check ${PLACEHOLDER}`);
    expect(result.error.details[0].hints[1]).toBe('retry');
    expect(result.error.details[0].code).toBe(401);
    expect(result.ok).toBe(false);
  });

  it('preserves Object.keys order at every level', () => {
    const input = { zeta: 'z', alpha: { delta: 'd', beta: 'b' }, gamma: [1, 2] };
    const result = redactDeep(input) as typeof input;

    expect(Object.keys(result)).toEqual(['zeta', 'alpha', 'gamma']);
    expect(Object.keys(result.alpha)).toEqual(['delta', 'beta']);
  });

  it('leaves non-string primitives identical', () => {
    const input = { n: 42, b: true, nul: null, undef: undefined, big: 9007199254740993n };
    const result = redactDeep(input) as typeof input;

    expect(result.n).toBe(42);
    expect(result.b).toBe(true);
    expect(result.nul).toBeNull();
    expect(result.undef).toBeUndefined();
    expect(result.big).toBe(9007199254740993n);
  });

  it('returns non-plain objects (Date, Map, class instances, functions) unchanged', () => {
    class Widget {
      constructor(public label: string) {}
    }
    const date = new Date('2026-01-01T00:00:00.000Z');
    const map = new Map([['a', 1]]);
    const widget = new Widget('unchanged');
    const fn = (): number => 1;

    const input = { date, map, widget, fn };
    const result = redactDeep(input) as typeof input;

    expect(result.date).toBe(date);
    expect(result.map).toBe(map);
    expect(result.widget).toBe(widget);
    expect(result.fn).toBe(fn);
  });

  it('guards a self-referential cycle instead of recursing forever', () => {
    type Cyclic = { name: string; self?: Cyclic };
    const node: Cyclic = { name: 'root' };
    node.self = node;

    const result = redactDeep(node) as Cyclic;

    expect(result.name).toBe('root');
    expect(result.self).toBe(node); // repeat visit returns the original reference
  });

  it('returns the original reference on a second (non-cyclic) visit to a shared object', () => {
    const shared = { secretish: 'wk_live_shared999' };
    const input = { first: shared, second: shared };

    const result = redactDeep(input) as typeof input;

    expect(result.first).toEqual({ secretish: PLACEHOLDER });
    expect(result.second).toBe(shared); // second reference: original, unprocessed
  });

  it('redacts a top-level string and leaves a top-level number unchanged', () => {
    expect(redactDeep('wk_live_top_level')).toBe(PLACEHOLDER);
    expect(redactDeep(7)).toBe(7);
  });
});

describe('formatCrash', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('redacts a key that appears only in the error message', () => {
    const err = new Error('auth failed: wk_live_message_only_123');
    err.stack = ''; // isolate message from stack for this assertion
    const output = formatCrash('uncaughtException', err);

    expect(output).not.toContain('wk_live_message_only_123');
    expect(output).toContain('auth failed');
  });

  it('redacts a key that appears only in the stack', () => {
    const err = new Error('clean message');
    err.stack = 'Error: clean message\n    at frame (wk_live_stack_only_456:1:1)';
    const output = formatCrash('uncaughtException', err);

    expect(output).not.toContain('wk_live_stack_only_456');
    expect(output).toContain('clean message');
  });

  it('formats a string rejection reason without throwing', () => {
    expect(() => formatCrash('unhandledRejection', 'plain string reason')).not.toThrow();
    expect(formatCrash('unhandledRejection', 'plain string reason')).toContain(
      'plain string reason'
    );
  });

  it('formats a plain-object rejection reason, redacting nested secrets', () => {
    const reason = { error: { message: 'invalid token wk_live_abc123' } };
    const output = formatCrash('unhandledRejection', reason);

    expect(output).not.toContain('wk_live_abc123');
    expect(output).toContain('invalid token');
  });

  it('never throws on exotic rejection reasons (undefined, circular, BigInt)', () => {
    expect(() => formatCrash('unhandledRejection', undefined)).not.toThrow();
    expect(() => formatCrash('unhandledRejection', null)).not.toThrow();
    expect(() => formatCrash('unhandledRejection', 123n)).not.toThrow();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatCrash('unhandledRejection', circular)).not.toThrow();
  });

  it('redacts the whole formatted output as a final pass regardless of shape', () => {
    registerSecret('registry-secret-999');
    const output = formatCrash('uncaughtException', 'saw registry-secret-999 in the wild');
    expect(output).not.toContain('registry-secret-999');
  });
});

describe('installCrashHandlers', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('reports an uncaughtException through write, redacted, without throwing or exiting', () => {
    registerSecret('wk_live_handler_test_123');
    const written: string[] = [];
    const dispose = installCrashHandlers((text) => written.push(text));

    try {
      const handlers = process.listeners('uncaughtException');
      const installed = handlers[handlers.length - 1] as (err: unknown) => void;

      expect(() =>
        installed(new Error('crash carrying wk_live_handler_test_123'))
      ).not.toThrow();

      expect(written).toHaveLength(1);
      expect(written[0]).not.toContain('wk_live_handler_test_123');
      expect(written[0]).toContain('uncaughtException');
    } finally {
      dispose();
    }
  });

  it('reports an unhandledRejection through write for a non-Error reason', () => {
    const written: string[] = [];
    const dispose = installCrashHandlers((text) => written.push(text));

    try {
      const handlers = process.listeners('unhandledRejection');
      const installed = handlers[handlers.length - 1] as (reason: unknown) => void;

      expect(() => installed({ message: 'wk_live_rejection_test_456' })).not.toThrow();

      expect(written).toHaveLength(1);
      expect(written[0]).not.toContain('wk_live_rejection_test_456');
      expect(written[0]).toContain('unhandledRejection');
    } finally {
      dispose();
    }
  });

  it('falls back to a fixed constant string if formatting itself throws', () => {
    const written: string[] = [];
    const dispose = installCrashHandlers((text) => written.push(text));

    try {
      const handlers = process.listeners('uncaughtException');
      const installed = handlers[handlers.length - 1] as (err: unknown) => void;

      // A real Error whose .stack getter has been redefined to throw. Node
      // gives every Error its own lazy own-property "stack" accessor at
      // construction time (shadowing any prototype getter), so the only way
      // to make access genuinely throw is to redefine that own property —
      // verified directly against V8 before relying on it here. formatCrash
      // has no internal try/catch around the Error branch, so this reaches
      // installCrashHandlers's own try/catch and must not escape it.
      const hostile = new Error('clean message');
      Object.defineProperty(hostile, 'stack', {
        get(): string {
          throw new Error('boom');
        },
        configurable: true,
      });

      expect(() => installed(hostile)).not.toThrow();
      expect(written).toHaveLength(1);
      expect(written[0]).toBe('[crash handler failed to format the error]');
    } finally {
      dispose();
    }
  });

  it('removes exactly the two listeners it installed, restoring the prior count', () => {
    const baselineUncaught = process.listeners('uncaughtException').length;
    const baselineRejection = process.listeners('unhandledRejection').length;

    const dispose = installCrashHandlers(() => {});

    expect(process.listeners('uncaughtException').length).toBe(baselineUncaught + 1);
    expect(process.listeners('unhandledRejection').length).toBe(baselineRejection + 1);

    dispose();

    expect(process.listeners('uncaughtException').length).toBe(baselineUncaught);
    expect(process.listeners('unhandledRejection').length).toBe(baselineRejection);
  });

  it('never exits the process itself — it delegates to the caller instead', () => {
    // installCrashHandlers must not exit the process on its own; exit policy
    // belongs to the entrypoint (index.ts passes one). A real invocation
    // reaching the real exit would kill the test worker, so this asserts
    // behaviorally with a spy rather than by matching source text — the old
    // substring check also flagged the word appearing in a comment.
    const written: string[] = [];
    const onFatal = jest.fn();
    const dispose = installCrashHandlers((text) => written.push(text), onFatal);

    try {
      const handler = process.listeners('uncaughtException').at(-1) as (err: unknown) => void;
      handler(new Error('boom'));

      // It reports, then hands the decision to the caller — never taking it.
      expect(written.join('')).toContain('uncaughtException');
      expect(onFatal).toHaveBeenCalledWith(1);
    } finally {
      dispose();
    }
  });

  it('is safe when the caller supplies no exit policy (optional param)', () => {
    const written: string[] = [];
    const dispose = installCrashHandlers((text) => written.push(text));

    try {
      const handler = process.listeners('uncaughtException').at(-1) as (err: unknown) => void;
      expect(() => handler(new Error('boom'))).not.toThrow();
      expect(written.join('')).toContain('uncaughtException');
    } finally {
      dispose();
    }
  });
});

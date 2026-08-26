import { readFileSync } from 'fs';
import path from 'path';
import { loadConfig, DEFAULT_API_BASE_URL } from './config';

describe('loadConfig', () => {
  it('throws when WORKEL_API_KEY is missing', () => {
    expect(() => loadConfig({})).toThrow(/WORKEL_API_KEY/);
    expect(() => loadConfig({})).toThrow(/Developers/);
  });

  it('throws when WORKEL_API_KEY is empty or whitespace-only', () => {
    expect(() => loadConfig({ WORKEL_API_KEY: '' })).toThrow(/WORKEL_API_KEY/);
    expect(() => loadConfig({ WORKEL_API_KEY: '   ' })).toThrow(/WORKEL_API_KEY/);
  });

  it('does not leak unrelated env values in the missing-key error message', () => {
    const env = { SECRET_UNRELATED: 'do-not-leak' };
    let message = '';
    try {
      loadConfig(env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/WORKEL_API_KEY/);
    expect(message).not.toContain('do-not-leak');
  });

  it('returns sane defaults when only the API key is set', () => {
    const config = loadConfig({ WORKEL_API_KEY: 'wk_test' });
    expect(config.apiKey).toBe('wk_test');
    expect(config.baseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(config.isCustomBaseUrl).toBe(false);
    expect(config.enableWrites).toBe(false);
    expect(config.skipStartupCheck).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  describe('WORKEL_ENABLE_WRITES parsing', () => {
    it.each(['true', 'TRUE', 'True'])('parses %s as true', (value) => {
      const config = loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_ENABLE_WRITES: value });
      expect(config.enableWrites).toBe(true);
    });

    it.each(['1', 'yes', 'TRUE ', '', 'false'])('parses %j as false', (value) => {
      const config = loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_ENABLE_WRITES: value });
      expect(config.enableWrites).toBe(false);
    });
  });

  describe('WORKEL_SKIP_STARTUP_CHECK parsing', () => {
    it.each(['true', 'TRUE', 'True'])('parses %s as true', (value) => {
      const config = loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_SKIP_STARTUP_CHECK: value });
      expect(config.skipStartupCheck).toBe(true);
    });

    it.each(['1', 'yes', 'TRUE ', '', 'false'])('parses %j as false', (value) => {
      const config = loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_SKIP_STARTUP_CHECK: value });
      expect(config.skipStartupCheck).toBe(false);
    });
  });

  describe('WORKEL_API_BASE_URL', () => {
    it('rejects a plain http:// URL pointed at a non-loopback host', () => {
      expect(() =>
        loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_API_BASE_URL: 'http://evil.example.com' })
      ).toThrow(/only point at this machine/);
    });

    it('rejects an http hostname that merely contains "localhost" as a subdomain trick', () => {
      expect(() =>
        loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_API_BASE_URL: 'http://localhost.evil.com' })
      ).toThrow(/only point at this machine/);
    });

    it('accepts http://localhost', () => {
      const config = loadConfig({
        WORKEL_API_KEY: 'wk_test',
        WORKEL_API_BASE_URL: 'http://localhost:8000',
      });
      expect(config.baseUrl).toBe('http://localhost:8000');
      expect(config.isCustomBaseUrl).toBe(true);
    });

    it('accepts http://127.0.0.1', () => {
      const config = loadConfig({
        WORKEL_API_KEY: 'wk_test',
        WORKEL_API_BASE_URL: 'http://127.0.0.1:8000',
      });
      expect(config.baseUrl).toBe('http://127.0.0.1:8000');
      expect(config.isCustomBaseUrl).toBe(true);
    });

    it('refuses an https override aimed at a non-loopback host', () => {
      // Previously accepted. `https:` never made this safe — it only required
      // the receiving host to hold a certificate, while still receiving a live
      // workspace key on every request.
      expect(() =>
        loadConfig({
          WORKEL_API_KEY: 'wk_test',
          WORKEL_API_BASE_URL: 'https://staging.workel.com/api/public/v1',
        })
      ).toThrow(/only point at this machine/);
    });

    it('refuses an https override even when the host looks like Workel', () => {
      // The rule is loopback, not "hostname resembles ours" — a lookalike
      // domain is exactly how this would be socially engineered.
      expect(() =>
        loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_API_BASE_URL: 'https://api.workel.com.evil.io' })
      ).toThrow(/only point at this machine/);
    });

    it('accepts an http loopback override and marks it custom', () => {
      const config = loadConfig({
        WORKEL_API_KEY: 'wk_test',
        WORKEL_API_BASE_URL: 'http://localhost:8000/api/public/v1',
      });
      expect(config.baseUrl).toBe('http://localhost:8000/api/public/v1');
      expect(config.isCustomBaseUrl).toBe(true);
    });

    it('accepts an https loopback override — a local backend may terminate TLS', () => {
      const config = loadConfig({
        WORKEL_API_KEY: 'wk_test',
        WORKEL_API_BASE_URL: 'https://127.0.0.1:8443/api/public/v1',
      });
      expect(config.baseUrl).toBe('https://127.0.0.1:8443/api/public/v1');
    });

    it('accepts the production default pinned explicitly', () => {
      // Being explicit about the default is caution, not attack.
      const config = loadConfig({
        WORKEL_API_KEY: 'wk_test',
        WORKEL_API_BASE_URL: 'https://api.workel.com/api/public/v1',
      });
      expect(config.isCustomBaseUrl).toBe(false);
    });

    it('strips trailing slashes and treats a slash-only variant of the default as non-custom', () => {
      const config = loadConfig({
        WORKEL_API_KEY: 'wk_test',
        WORKEL_API_BASE_URL: `${DEFAULT_API_BASE_URL}/`,
      });
      expect(config.baseUrl).toBe(DEFAULT_API_BASE_URL);
      expect(config.isCustomBaseUrl).toBe(false);
    });

    it('throws a clear error for an unparseable URL', () => {
      expect(() =>
        loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_API_BASE_URL: 'not a url' })
      ).toThrow(/WORKEL_API_BASE_URL/);
    });
  });

  describe('WORKEL_LOG_LEVEL', () => {
    it.each(['debug', 'info', 'warn', 'error'])('accepts %s', (level) => {
      const config = loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_LOG_LEVEL: level });
      expect(config.logLevel).toBe(level);
    });

    it('is case-insensitive', () => {
      const config = loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_LOG_LEVEL: 'DEBUG' });
      expect(config.logLevel).toBe('debug');
    });

    it('falls back to info instead of throwing on an unrecognised value', () => {
      const config = loadConfig({ WORKEL_API_KEY: 'wk_test', WORKEL_LOG_LEVEL: 'verbose' });
      expect(config.logLevel).toBe('info');
    });
  });

  it('never reads from process.argv', () => {
    const source = readFileSync(path.join(__dirname, 'config.ts'), 'utf8');
    expect(source).not.toMatch(/argv/);
  });
});

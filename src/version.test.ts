import { readFileSync } from 'fs';
import path from 'path';
import { VERSION } from './version';

describe('VERSION', () => {
  it('matches the version field in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, '../package.json'), 'utf8')
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

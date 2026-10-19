import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (name: string) => readFileSync(ROOT + name, 'utf8');

describe('package name', () => {
  it('is @decisionnode/sdk in package.json and its lock file', () => {
    expect(JSON.parse(read('package.json')).name).toBe('@decisionnode/sdk');
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.name).toBe('@decisionnode/sdk');
    expect(lock.packages[''].name).toBe('@decisionnode/sdk');
  });

  it('is the one the README installs and imports', () => {
    const readme = read('README.md');
    expect(readme).toContain('npm install @decisionnode/sdk\n');
    expect(readme).not.toContain('Not on npm yet');
    const imports = [...readme.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(new Set(imports)).toEqual(new Set(['@decisionnode/sdk']));
  });
});

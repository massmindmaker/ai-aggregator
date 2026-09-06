import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

const testConfig = config.test ?? {};

describe('root Vitest discovery contract', () => {
  it('excludes generated and vendored trees at every nesting depth', () => {
    expect(testConfig.exclude).toEqual(
      expect.arrayContaining([
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        'docs/superpowers/recovered/**',
        'e2e/**',
        'tests/fixtures/**',
      ]),
    );
  });

  it('uses Node by default and jsdom only for web tests', () => {
    expect(testConfig.environment).toBe('node');
    expect(testConfig.environmentMatchGlobs).toEqual([
      ['apps/web/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', 'jsdom'],
    ]);
  });
});

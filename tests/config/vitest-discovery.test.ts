import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

const testConfig = config.test ?? {};
const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;

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

  it('excludes private agent scratch from test discovery and coverage', () => {
    expect(testConfig.exclude).toContain('**/.superpowers/**');
    expect(testConfig.coverage?.exclude).toContain('**/.superpowers/**');
  });

  it('provides a focused contract gate without implicit migrations or browser tests', () => {
    expect(scripts['test:catalog-contract']).toContain('--no-file-parallelism');
    expect(scripts['test:catalog-contract']).toContain('catalog-producer-consumer.http.test.ts');
    expect(scripts['test:catalog-contract']).not.toMatch(/migrat|playwright|bootstrap/);
  });

  it('names native evidence as a guarded smoke gate rather than full acceptance', () => {
    expect(scripts['test:catalog-native-smoke']).toContain('RUN_NATIVE_DB_INTEGRATION=1');
    expect(scripts['test:catalog-native-smoke']).toContain('catalog-pagination.native.integration.test.ts');
    expect(scripts['test:catalog-native-smoke']).not.toMatch(/migrat|bootstrap/);
  });

  it('uses Node by default and jsdom only for web tests', () => {
    expect(testConfig.environment).toBe('node');
    expect(testConfig.environmentMatchGlobs).toEqual([
      ['apps/web/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', 'jsdom'],
    ]);
  });
});

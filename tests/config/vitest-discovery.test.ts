import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

const testConfig = config.test ?? {};
const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;
const workerIndex = readFileSync(new URL('../../apps/worker/src/index.ts', import.meta.url), 'utf8');

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
    expect(scripts['test:catalog-native-smoke']).toContain('catalog-mounted.native.integration.test.ts');
    expect(scripts['test:catalog-native-smoke']).not.toMatch(/migrat|bootstrap/);
  });

  it('registers mounted BYOK acceptance in the mandatory database baseline', () => {
    const baseline = scripts['test:database-baseline'];
    expect(baseline).toContain('stored-chat-byok-mounted.native.integration.test.ts');
    expect(baseline.indexOf('stored-chat-byok-mounted.native.integration.test.ts')).toBeLessThan(
      baseline.indexOf('&& bun run test:ton-core-native'),
    );
  });

  it('registers durable async media acceptance in the mandatory database baseline', () => {
    const baseline = scripts['test:database-baseline'];
    for (const file of [
      'gateway-media-jobs.native.integration.test.ts',
      'gateway-media-quota.native.integration.test.ts',
      'stored-media-mounted.native.integration.test.ts',
      'upstream-poll-db.native.integration.test.ts',
    ]) {
      expect(baseline).toContain(file);
      expect(baseline.indexOf(file)).toBeLessThan(baseline.indexOf('&& bun run test:ton-core-native'));
    }
  });

  it('registers durable batch storage and mounted recovery in the mandatory database baseline', () => {
    const baseline = scripts['test:database-baseline'];
    for (const file of [
      'gateway-durable-batches.native.integration.test.ts',
      'stored-batch-storage.native.integration.test.ts',
      'stored-batches-mounted.native.integration.test.ts',
    ]) {
      expect(baseline).toContain(file);
      expect(baseline.indexOf(file)).toBeLessThan(baseline.indexOf('&& bun run test:ton-core-native'));
    }
  });

  it('keeps durable media worker polling behind the tested Kie bootstrap helper', () => {
    expect(workerIndex).toContain("createMediaKieAdapter(process.env)");
  });

  it('uses Node by default and jsdom only for web tests', () => {
    expect(testConfig.environment).toBe('node');
    // Root include would concatenate with the Web project and collect every test twice.
    expect(testConfig.include).toBeUndefined();
    const projects = testConfig.projects as Array<{ test?: { name?: string; environment?: string; include?: string[]; exclude?: string[] } }>;
    expect(projects).toHaveLength(2);
    expect(projects[0].test).toMatchObject({ name: 'node', environment: 'node' });
    expect(projects[0].test?.exclude).toContain('apps/web/**');
    expect(projects[1].test).toMatchObject({ name: 'web', environment: 'jsdom' });
    expect(projects[1].test?.include).toEqual(['apps/web/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}']);
  });
});

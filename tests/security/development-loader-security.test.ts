import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const loaderRequire = createRequire(require.resolve('@esbuild-kit/core-utils'));
const utils = require('@esbuild-kit/core-utils') as {
  transformSync: (source: string, path: string) => { code: string };
  transform: (source: string, path: string) => Promise<{ code: string }>;
};
describe('Drizzle development loader security compatibility', () => {
  it('resolves a patched esbuild inside the legacy loader dependency', () => {
    const version = loaderRequire('esbuild/package.json').version as string;
    expect(Number(version.split('.')[1])).toBeGreaterThanOrEqual(25);
  });
  it('preserves synchronous and asynchronous TypeScript transformation', async () => {
    const source = 'export const answer: number = 42;';
    const path = resolve('.superpowers/synthetic-schema.ts');
    for (const result of [utils.transformSync(source, path), await utils.transform(source, path)]) {
      expect(result.code).toContain('42');
      expect(result.code).not.toContain(': number');
    }
  });
});

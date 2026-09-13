import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/schema/index.ts',
    'src/ton-reconciliation-internal.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});

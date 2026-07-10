import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/validation.ts', 'src/client.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});

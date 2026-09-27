import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/server-node.ts', 'src/batch-runtime.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // bullmq + ioredis MUST stay external: bundling BullMQ's ESM inlines an
  // `import … from 'ioredis/built/utils'` (a directory import) which Node's ESM
  // loader rejects with ERR_UNSUPPORTED_DIR_IMPORT → gateway crash-loop. Leaving
  // them external lets the Redis stack resolve from node_modules at runtime.
  external: ['@aiag/database', 'bullmq', 'ioredis'],
});

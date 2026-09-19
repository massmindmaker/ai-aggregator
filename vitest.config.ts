import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['apps/web/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', 'jsdom'],
    ],
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.superpowers/**',
      'docs/superpowers/recovered/**',
      'e2e/**',
      'tests/fixtures/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/.superpowers/**',
        'docs/superpowers/recovered/**',
        'tests/fixtures/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**',
      ],
      thresholds: {
        global: {
          branches: 50,
          functions: 50,
          lines: 50,
          statements: 50,
        },
      },
    },
  },
  resolve: {
    dedupe: ['next', 'react', 'react-dom'],
    alias: {
      next: path.resolve(__dirname, './node_modules/next'),
      '@': path.resolve(__dirname, './apps/web/src'),
      '@aiag/database': path.resolve(__dirname, './packages/database/src'),
      '@aiag/shared': path.resolve(__dirname, './packages/shared/src'),
      '@aiag/tinkoff': path.resolve(__dirname, './packages/tinkoff/src'),
      '@aiag/yookassa': path.resolve(__dirname, './packages/yookassa/src'),
      '@aiag/upstream-adapters': path.resolve(__dirname, './packages/upstream-adapters/src'),
    },
  },
});

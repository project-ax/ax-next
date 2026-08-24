import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'mock/**/*.test.ts'],
    // Some of this package's suites spin up a real Postgres testcontainer.
    // Bare hooks otherwise inherit vitest's 10s default hookTimeout, which
    // container boot routinely blows past under CI/monorepo-wide load. Set
    // to this package's own largest declared hook-timeout argument so a
    // bare afterAll is never budgeted below its own file's beforeAll. See
    // TASK-323.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

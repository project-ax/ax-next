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
    // `@testing-library/jest-dom/vitest` registers its matchers with
    // `expect.extend()` on whatever `vitest` its own bare import resolves to.
    // pnpm installs jest-dom unspecialized (its `vitest` peer is optional), so
    // Node resolves that import by walking up to the workspace root copy —
    // which is a *different* vitest instance than the one running this project
    // (we pin vite 6 for the SPA build, the root is on vite 8, and vitest is
    // keyed by its vite peer). Both instances then patch the single hoisted
    // chai, so under vitest 5 `.rejects` and `.toThrow` come from different
    // copies and the rejected error never crosses between them: every
    // `.rejects.toThrow(msg)` sees an empty error. Inlining forces Vite to
    // transform jest-dom, so its `vitest` import goes through Vite's resolver
    // and lands on ours. `resolve.dedupe` does NOT help — externalized deps
    // never reach Vite's resolver in the first place.
    server: { deps: { inline: ['@testing-library/jest-dom'] } },
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

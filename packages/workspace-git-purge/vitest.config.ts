import { defineConfig } from 'vitest/config';

// Every test here builds real bare repositories and shells out to the real
// `git` binary (fast-export / fast-import / gc), many times per case. 30s / 60s
// matches the repo's other subprocess-touching suites rather than inventing a
// new number.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

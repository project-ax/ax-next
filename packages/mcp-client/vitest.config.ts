import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Scaffold-only: no test files land until Task 8. Mirrors the credentials
    // scaffold state between Task 1 and Task 2, but keeps `pnpm test` green
    // so parallel task verification doesn't trip on a no-files exit code.
    passWithNoTests: true,
  },
});

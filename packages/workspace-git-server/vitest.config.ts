import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    passWithNoTests: true,
    // This package does real-`git` bundle/clone work in its server +
    // client tests; under the full-suite parallel load the 5 s vitest
    // default flakes (the #146 / TASK-73 class — a fast-solo test breaches
    // only when the runner is saturated). 30 s gives ample headroom
    // without masking a genuinely hung fast test.
    testTimeout: 30_000,
  },
});

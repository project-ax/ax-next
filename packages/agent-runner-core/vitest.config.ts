import { defineConfig } from 'vitest/config';

// Until TASK-400 the package config said nothing, so every case and hook ran on
// vitest's 5s/10s defaults while the real-subprocess suites here asked for 30s
// case by case. 30s is the figure those suites settled on; `hookTimeout` is
// double, so a bare teardown never gets less room than the case it is cleaning
// up after. (The suite that motivated it, the runner's real-`git` workspace
// tests, went with the workspace tier in TASK-995; the values stay as the
// package's floor for its filesystem and child-process tests.)
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

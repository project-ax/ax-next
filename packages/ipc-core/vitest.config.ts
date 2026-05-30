import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Several handler tests (workspace-commit-notify, workspace-export-baseline-bundle)
    // shell out to the real `git` binary to build/verify/unpack multi-MiB bundles.
    // Solo they run in ~1s, but under the full parallel `pnpm test` gate
    // (~59 packages saturate CPU/fds) the cumulative subprocess wall-time
    // intermittently breaches vitest's 5s default and times out — the same
    // load-induced flake mode that reds the main-CI backstop (TASK-73; the
    // "does NOT base64-inflate a large bundle" test built a 5 MiB random bundle
    // and timed out at 5068ms). 30s is generous headroom while still catching a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

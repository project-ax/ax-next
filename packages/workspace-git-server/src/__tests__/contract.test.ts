// I1 contract proof for @ax/workspace-git-server.
//
// The same `runWorkspaceContract` test suite that passes against
// @ax/workspace-git (in-process) and @ax/workspace-git-http MUST pass
// here against BOTH host-side plugin variants:
//
//   1. `createTestOnlyGitServerPlugin` — Phase 1's adapter that pins one
//      workspaceId per plugin instance via `boot()`. Used by other
//      integration tests (multi-replica-concurrency, empty-repo-
//      materialize) where a stable workspaceId is convenient.
//
//   2. `createWorkspaceGitServerPlugin` — the production factory that
//      derives workspaceId from `ctx` per-call. This is the plugin a real
//      host pod loads. Running the contract against it proves the
//      production wiring (workspaceId derivation + 4 hook handlers + retry
//      wrapping + token-leak scrubbing) honors the same surface as the
//      test-only adapter.
//
// If a single contract assertion fails for EITHER factory, the abstraction
// is leaking somewhere in the new wire shape.
//
// Server cleanup: each test-only scenario boots its own server (we track
// them and close them in `afterAll`). The production run uses ONE shared
// server (booted at module load via top-level await) and gives each
// scenario a fresh `workspaceId` via the override — that keeps the
// production factory's contract clean (no test-only `boot()` seam) while
// still isolating histories per scenario.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { runWorkspaceContract } from '@ax/test-harness';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../server/index.js';
import { createTestOnlyGitServerPlugin } from '../client/plugin-test-only.js';
import { createWorkspaceGitServerPlugin } from '../client/plugin.js';

// ---------------------------------------------------------------------------
// Shared bookkeeping for both runs
// ---------------------------------------------------------------------------

let scenarioCount = 0;
const bootedServers: WorkspaceGitServer[] = [];
const cacheRoots: string[] = [];

afterAll(async () => {
  await Promise.allSettled(bootedServers.map((s) => s.close()));
  bootedServers.length = 0;
  // Best-effort cleanup of cache tempdirs from the production run. Plugin
  // shutdown already removes them, but if a scenario crashes before
  // teardown they'd linger.
  await Promise.allSettled(
    cacheRoots.map(async (r) => {
      const { rm } = await import('node:fs/promises');
      await rm(r, { recursive: true, force: true });
    }),
  );
  cacheRoots.length = 0;
});

// ---------------------------------------------------------------------------
// Run 1: test-only factory (per-scenario server)
// ---------------------------------------------------------------------------

runWorkspaceContract('@ax/workspace-git-server (test-only)', () =>
  createTestOnlyGitServerPlugin({
    boot: async () => {
      const server = await createWorkspaceGitServer({
        repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-server-contract-')),
        host: '127.0.0.1',
        port: 0,
        token: 'secret',
      });
      bootedServers.push(server);
      const workspaceId = `wstest${++scenarioCount}`;
      return {
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'secret',
        workspaceId,
      };
    },
  }),
);

// ---------------------------------------------------------------------------
// Run 2: production factory (one shared server, fresh workspaceId per scenario)
// ---------------------------------------------------------------------------
//
// The production factory takes `{baseUrl, token}` synchronously, so we boot
// the storage tier once at module load (top-level await) and reuse it across
// every scenario. Each scenario gets a unique `workspaceId` via the
// `workspaceIdFor` override — different IDs map to different bare repos on
// the same server, so version histories don't bleed.

const sharedRepoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-server-prod-contract-'));
const sharedServer = await createWorkspaceGitServer({
  repoRoot: sharedRepoRoot,
  host: '127.0.0.1',
  port: 0,
  token: 'secret',
});
bootedServers.push(sharedServer);
const sharedBaseUrl = `http://127.0.0.1:${sharedServer.port}`;

runWorkspaceContract('@ax/workspace-git-server (production)', () => {
  // Fresh workspaceId per scenario — randomUUID().slice(0, 8) is cheap and
  // collision-free for the handful of scenarios this suite runs.
  const workspaceId = `wsprod${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const cacheRoot = mkdtempSync(join(tmpdir(), 'ax-ws-server-prod-contract-cache-'));
  cacheRoots.push(cacheRoot);
  return createWorkspaceGitServerPlugin({
    baseUrl: sharedBaseUrl,
    token: 'secret',
    cacheRoot,
    // Ignore ctx; pin to the per-scenario id so the contract's history
    // doesn't see writes from other scenarios.
    workspaceIdFor: () => workspaceId,
  });
});

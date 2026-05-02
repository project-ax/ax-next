// ---------------------------------------------------------------------------
// Test-only host-side Plugin for @ax/workspace-git-server.
//
// Role (unchanged from Phase 1): bridge between the contract-test harness and
// the storage tier. The harness boots a fresh server per scenario and hands
// us a `(baseUrl, token, workspaceId)` triple via `boot()`; we register the
// four `workspace:*` hooks against that fixed workspaceId so the harness can
// exercise apply/read/list/diff without knowing anything about git wire
// formats, mirror caches, or repo lifecycle REST.
//
// What changed in Phase 2: this plugin no longer carries its own copy of the
// git-engine helpers (runGit, fetchMirror, buildScratch, buildDelta, …). It
// composes the shared `GitEngine` from `git-engine.ts` with a per-instance
// `MirrorCache` and `RepoLifecycleClient`, and threads the fixed workspaceId
// from `boot()` through every call. The factory signature, manifest, and
// `CreateTestOnlyGitServerPluginOptions` shape are deliberately preserved so
// the contract test, the multi-replica integration test, and the empty-repo
// integration test all keep passing unchanged.
//
// Why we keep this plugin alongside `createWorkspaceGitServerPlugin`: the
// contract test wants ONE workspaceId per plugin instance (so each scenario
// gets a clean version history). The production plugin derives workspaceId
// from `ctx` (a per-call userId/agentId) — that's correct for production
// where many agents share a single host pod, but wrong for the harness which
// has no real ctx. Keeping a thin test-only adapter avoids contorting the
// production factory's contract for test purposes.
//
// NOT exported from `index.ts`. NOT registered by any preset.
// ---------------------------------------------------------------------------

import type {
  Plugin,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceDiffInput,
  WorkspaceDiffOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { createGitEngine, type GitEngine } from './git-engine.js';
import { createMirrorCache, type MirrorCache } from './mirror-cache.js';
import {
  createRepoLifecycleClient,
  type RepoLifecycleClient,
} from './repo-lifecycle.js';

const PLUGIN_NAME = '@ax/workspace-git-server-test-only';

export interface CreateTestOnlyGitServerPluginOptions {
  /**
   * Boots a fresh server (or reuses one) and returns the connection info +
   * a workspaceId for this plugin instance to operate on. Called once per
   * `init()`.
   */
  boot: () => Promise<{
    baseUrl: string;
    token: string;
    workspaceId: string;
  }>;
}

interface PluginState {
  mirrorCache: MirrorCache;
  engine: GitEngine;
  workspaceId: string;
}

/**
 * Best-effort eager repo creation. The engine creates the repo lazily on the
 * first `apply()` for a workspaceId, but the contract test exercises
 * `workspace:read` against a fresh workspace BEFORE any apply — and the
 * engine's first step is `git fetch`, which 404s against a server repo that
 * doesn't exist yet. Phase 1's plugin-test-only sidestepped this by calling
 * `createRepo` in `init()`. We preserve that behavior here so the contract
 * test sees the same surface.
 *
 * 409 (repo already exists) is fine — multi-replica scenarios share one repo
 * across plugins, so racing creates are expected.
 */
async function ensureRepoExists(
  client: RepoLifecycleClient,
  workspaceId: string,
): Promise<void> {
  try {
    await client.createRepo(workspaceId);
  } catch (err) {
    if ((err as Error).message !== 'repo already exists') throw err;
  }
}

export function createTestOnlyGitServerPlugin(
  opts: CreateTestOnlyGitServerPluginOptions,
): Plugin {
  // Closure-scoped state, populated by init(); guarded with `null` so a
  // shutdown call before init (or after a failed init) is a safe no-op.
  let state: PluginState | null = null;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },

    async init({ bus }) {
      const { baseUrl, token, workspaceId } = await opts.boot();
      const mirrorCache = createMirrorCache();
      const lifecycleClient = createRepoLifecycleClient({ baseUrl, token });
      const engine = createGitEngine({
        baseUrl,
        token,
        mirrorCache,
        lifecycleClient,
      });
      // Pre-create the repo so a `workspace:read` before any `apply` doesn't
      // 404 on the server. See ensureRepoExists() for the why.
      await ensureRepoExists(lifecycleClient, workspaceId);
      state = { mirrorCache, engine, workspaceId };

      // Each hook delegates to the engine with the FIXED workspaceId from
      // boot() — production callers derive workspaceId from ctx, but this
      // adapter pins one workspace per plugin instance so the contract test
      // gets a clean version history per scenario.
      bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        PLUGIN_NAME,
        (_ctx, input) => engine.apply(workspaceId, input),
      );

      bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        PLUGIN_NAME,
        (_ctx, input) => engine.read(workspaceId, input),
      );

      bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        PLUGIN_NAME,
        (_ctx, input) => engine.list(workspaceId, input),
      );

      bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        PLUGIN_NAME,
        (_ctx, input) => engine.diff(workspaceId, input),
      );
    },

    async shutdown() {
      if (state === null) return;
      const { engine, mirrorCache } = state;
      state = null;
      // Engine first — drains in-flight queues so any active mirror handles
      // settle before we rm the dirs underneath them.
      await engine.shutdown();
      await mirrorCache.shutdown();
    },
  };
}

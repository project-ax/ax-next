// ---------------------------------------------------------------------------
// Test-only host-side Plugin for @ax/workspace-git-server.
//
// Role (unchanged from Phase 1): bridge between the contract-test harness and
// the storage tier. The harness boots a fresh server per scenario and hands
// us a `(baseUrl, token, workspaceId)` triple via `boot()`; we register the
// five `workspace:*` hooks against that server so the harness can exercise
// apply/read/list/diff without knowing anything about git wire formats,
// mirror caches, or repo lifecycle REST.
//
// What changed in Phase 2: this plugin no longer carries its own copy of the
// git-engine helpers (runGit, fetchMirror, buildScratch, buildDelta, …). It
// composes the shared `GitEngine` from `git-engine.ts` with a per-instance
// `MirrorCache` and `RepoLifecycleClient`. The factory signature, manifest,
// and `CreateTestOnlyGitServerPluginOptions` shape are unchanged.
//
// Why we keep this plugin alongside `createWorkspaceGitServerPlugin`: the
// production factory takes its server connection synchronously, while these
// tests want to boot a server first and hand the connection over
// asynchronously. This adapter is that `boot()` seam and nothing more.
//
// ⚠ It used to be more than that. It pinned ONE workspaceId per plugin
// instance and ignored `ctx` on every hook, so every caller — every agent,
// every user — shared one tree. That made it the one thing the shared
// contract could not be allowed to accept, because a backend that ignores
// ctx is exactly the #583 bug. TASK-413 gave `runWorkspaceContract` an
// isolation property, and this adapter now partitions like the production
// one: the boot-supplied workspaceId is a NAMESPACE, and each caller's
// `agentId` selects a repo inside it.
//
// Why namespace rather than call `workspaceIdFor` straight: a test fixture
// picks its own `boot()` workspaceId precisely so two fixtures sharing one
// server don't collide. Hashing agentId alone would throw that away — every
// fixture using the harness's default agent would land on one repo.
//
// NOT exported from `index.ts`. NOT registered by any preset.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { registerWorkspaceApplyFacade } from '@ax/core';
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
   * the workspaceId NAMESPACE this plugin instance operates under. Called
   * once per `init()`. The repo a given call actually reaches is
   * `namespacedWorkspaceId(workspaceId, ctx.agentId)`; a fixture that needs
   * to address that repo server-side (a `createRepo`, a `git log` on the bare
   * repo) must derive it the same way.
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
  namespace: string;
}

/**
 * `<boot workspaceId>-<first 12 hex of sha256([agentId])>`.
 *
 * Same partition policy as production (`workspaceIdFor`): `agentId` ALONE,
 * never `userId` and never the pair. Two users of one agent land on one
 * repo; two agents never do. The digest keeps the result inside
 * `WORKSPACE_ID_REGEX` no matter what an agentId contains.
 */
export function namespacedWorkspaceId(namespace: string, agentId: string): string {
  const h = createHash('sha256').update(JSON.stringify([agentId])).digest('hex');
  return `${namespace}-${h.slice(0, 12)}`;
}

/**
 * Best-effort eager repo creation. The engine creates the repo lazily on the
 * first `apply()` for a workspaceId, but the contract test exercises
 * `workspace:read` against a fresh workspace BEFORE any apply — and the
 * engine's first step is `git fetch`, which 404s against a server repo that
 * doesn't exist yet. Phase 1's plugin-test-only sidestepped this by calling
 * `createRepo` once in `init()`; since the repo is now chosen per caller we
 * do it on first touch instead, which keeps that surface.
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
        'workspace:apply-internal',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },

    async init({ bus }) {
      const { baseUrl, token, workspaceId: namespace } = await opts.boot();
      const mirrorCache = createMirrorCache();
      const lifecycleClient = createRepoLifecycleClient({ baseUrl, token });
      const engine = createGitEngine({
        baseUrl,
        token,
        mirrorCache,
        lifecycleClient,
      });
      state = { mirrorCache, engine, namespace };

      // Per-agent repos are created on first touch rather than once in
      // init(), because we no longer know at init() which agents will call.
      // Memoized so a read-heavy scenario doesn't re-POST per call.
      const ensured = new Map<string, Promise<void>>();
      const repoFor = async (ctx: { agentId: string }): Promise<string> => {
        const id = namespacedWorkspaceId(namespace, ctx.agentId);
        let pending = ensured.get(id);
        if (pending === undefined) {
          // Pre-create so a `workspace:read` before any `apply` doesn't 404
          // on the server. See ensureRepoExists() for the why.
          pending = ensureRepoExists(lifecycleClient, id);
          ensured.set(id, pending);
        }
        try {
          await pending;
        } catch (err) {
          // Don't cache a failure — a transient 500 would otherwise poison
          // this workspaceId for the rest of the run.
          ensured.delete(id);
          throw err;
        }
        return id;
      };

      // The PUBLIC `workspace:apply` is the @ax/core facade (pre-apply +
      // applied around the raw impl); we register the raw impl as
      // `workspace:apply-internal`.
      registerWorkspaceApplyFacade(bus, PLUGIN_NAME);

      // Every hook derives its repo from `ctx.agentId`. Read/list/diff take
      // ctx for exactly this reason — a backend that drops ctx on the read
      // paths is the #583 shape, and the shared contract now rejects it.
      bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply-internal',
        PLUGIN_NAME,
        async (ctx, input) =>
          engine.apply(await repoFor(ctx), input, {
            agentId: ctx.agentId,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
          }),
      );

      bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        PLUGIN_NAME,
        async (ctx, input) => engine.read(await repoFor(ctx), input),
      );

      bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        PLUGIN_NAME,
        async (ctx, input) => engine.list(await repoFor(ctx), input),
      );

      bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        PLUGIN_NAME,
        async (ctx, input) => engine.diff(await repoFor(ctx), input),
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

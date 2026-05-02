// ---------------------------------------------------------------------------
// Production host-side plugin factory for @ax/workspace-git-server.
//
// Role: this is the registered plugin a host pod loads at boot to talk to the
// new sharded git-server storage tier (sharding deferred per Phase 2 plan
// Q5; for now one `baseUrl` per plugin instance — one tier endpoint, one
// host pod, one plugin). The plugin is a thin wrapper around the ownership
// triple it manages:
//
//   - one `MirrorCache` (per-workspace bare-repo mirrors on local disk),
//   - one `RepoLifecycleClient` (REST CRUD against the storage tier, retry-
//     wrapped so transient connection blips don't immediately fail an apply),
//   - one `GitEngine` (the multiplexed apply/read/list/diff implementation
//     that owns its own per-workspace serialization queues).
//
// The triple is owned BY this plugin instance because each plugin instance
// represents one host pod's view of one storage-tier endpoint. If we ever
// shard across multiple endpoints, we'll instantiate this factory once per
// shard and let workspaceIdFor/lookups choose the shard at the call site.
//
// `workspaceIdFor` is overridable so tests can collide ids deliberately
// (e.g., multi-replica concurrency tests where two host plugins must operate
// on the SAME workspaceId from different ctxs). Production callers always
// leave it unset and let the deterministic sha256(userId/agentId)
// derivation pick the id.
//
// Token discipline (belt-and-suspenders): the lifecycle client and the git
// binary already shouldn't leak the bearer token in their error messages.
// `repo-lifecycle.ts` deliberately omits the token from `opError`; the git
// binary passes the token via `http.extraHeader` and never echoes it in
// stderr. But errors travel through hook handlers, into the kernel, into
// operator-visible logs — and "we audited every error path once in 2026"
// is a thin guarantee. So every error escaping a hook handler here gets
// passed through `sanitizeTokenLeak`, which scrubs the token from the
// message and stack if (against expectation) it shows up. One pass, no
// recursion, no clever wrapping. If a future code path leaks the token
// through some unforeseen channel — JSON-stringified body in a 5xx
// response, a verbose retry log, an unsanitized child-process echo — the
// scrubber catches it before it reaches the kernel's error logger.
// ---------------------------------------------------------------------------

import type { Plugin } from '@ax/core';
import type {
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
import {
  createMirrorCache,
  type MirrorCache,
} from './mirror-cache.js';
import {
  createRepoLifecycleClient,
  type RepoLifecycleClient,
} from './repo-lifecycle.js';
import { withRetry, type RetryOptions } from './retry.js';
import { workspaceIdFor as defaultWorkspaceIdFor } from './workspace-id.js';

const PLUGIN_NAME = '@ax/workspace-git-server';

export interface CreateWorkspaceGitServerPluginOptions {
  /** Cluster-internal base URL of the storage tier. */
  baseUrl: string;
  /** Bearer token for REST + git smart-HTTP auth. Never logged. */
  token: string;
  /** Optional override for the local mirror cache root. Default: tempdir-scoped. */
  cacheRoot?: string;
  /** Optional max cached mirrors (LRU eviction). Default 64. */
  cacheMaxEntries?: number;
  /** Optional retry tuning for REST calls. Default attempts=5, backoffBaseMs=100. */
  retry?: RetryOptions;
  /** Optional injection point for tests. Production callers leave unset. */
  workspaceIdFor?: (ctx: { userId: string; agentId: string }) => string;
}

interface PluginState {
  mirrorCache: MirrorCache;
  lifecycleClient: RepoLifecycleClient;
  engine: GitEngine;
}

/**
 * Wraps every `RepoLifecycleClient` method in `withRetry` so transient REST
 * failures (`ECONNRESET`, `ETIMEDOUT`, etc.) don't immediately fail an apply.
 * `PluginError` subclasses still bypass retry — the retry helper checks
 * `isTransientConnectionError` which excludes them. Result: the engine sees
 * the same client interface but with backoff baked in.
 */
function withRetryClient(
  client: RepoLifecycleClient,
  retry?: RetryOptions,
): RepoLifecycleClient {
  return {
    createRepo: (id) => withRetry(() => client.createRepo(id), retry),
    getRepo: (id) => withRetry(() => client.getRepo(id), retry),
    deleteRepo: (id) => withRetry(() => client.deleteRepo(id), retry),
    isHealthy: () => withRetry(() => client.isHealthy(), retry),
  };
}

/**
 * Replaces every occurrence of `token` in the error's `message` and `stack`
 * with `<redacted>`. Preserves the error's prototype (so `instanceof
 * PluginError` still works in subscribers) by mutating in place rather than
 * cloning. Returns the err unchanged when no token text is present.
 *
 * Why mutation over a wrapper: a thrown `PluginError` carries `code`,
 * `plugin`, `hookName`, `cause` — all of which subscribers may inspect.
 * Wrapping in a fresh `Error` would erase that structure. Mutating message
 * + stack is the smallest change that scrubs the leak while preserving
 * everything callers might key off of.
 *
 * If `err` is not an Error (someone threw a string or a plain object),
 * return it unchanged. The hook layer will surface it as-is and the
 * harness's onError sink will stringify it; we don't try to scrub
 * arbitrary thrown values.
 */
function sanitizeTokenLeak(err: unknown, token: string): unknown {
  if (!(err instanceof Error)) return err;
  if (token.length === 0) return err;
  const placeholder = '<redacted>';
  let mutated = false;
  if (typeof err.message === 'string' && err.message.includes(token)) {
    err.message = err.message.split(token).join(placeholder);
    mutated = true;
  }
  if (typeof err.stack === 'string' && err.stack.includes(token)) {
    err.stack = err.stack.split(token).join(placeholder);
    mutated = true;
  }
  void mutated; // local sentinel; future code may want to log the scrub
  return err;
}

/**
 * Builds the registered host-side plugin for `@ax/workspace-git-server`.
 *
 * Each plugin instance owns one `(MirrorCache, RepoLifecycleClient,
 * GitEngine)` triple, shut down in that-reverse order on `shutdown()`:
 * engine first (drains queues), then cache (rm's the mirror tempdirs).
 * The lifecycle client is stateless — no shutdown call needed.
 */
export function createWorkspaceGitServerPlugin(
  opts: CreateWorkspaceGitServerPluginOptions,
): Plugin {
  // Closure-scoped state; populated in init(), consumed by hooks + shutdown.
  // Guarded with `null` so a shutdown call before init (or after a failed
  // init) is a safe no-op.
  let state: PluginState | null = null;

  const resolveWorkspaceId = (ctx: {
    userId: string;
    agentId: string;
  }): string => {
    const fn = opts.workspaceIdFor ?? defaultWorkspaceIdFor;
    return fn(ctx);
  };

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

    init({ bus }) {
      // Build the triple. If any constructor throws, we propagate (the
      // kernel surfaces this as `init-failed`). We don't try to keep
      // partial state — half-built plugin is no plugin.
      const mirrorCacheOpts: Parameters<typeof createMirrorCache>[0] = {};
      if (opts.cacheRoot !== undefined) {
        mirrorCacheOpts.cacheRoot = opts.cacheRoot;
      }
      if (opts.cacheMaxEntries !== undefined) {
        mirrorCacheOpts.cacheMaxEntries = opts.cacheMaxEntries;
      }
      const mirrorCache = createMirrorCache(mirrorCacheOpts);

      const rawLifecycleClient = createRepoLifecycleClient({
        baseUrl: opts.baseUrl,
        token: opts.token,
      });
      const lifecycleClient = withRetryClient(rawLifecycleClient, opts.retry);

      const engine = createGitEngine({
        baseUrl: opts.baseUrl,
        token: opts.token,
        mirrorCache,
        lifecycleClient,
      });

      state = { mirrorCache, lifecycleClient, engine };

      // Register the four hooks. Each derives `workspaceId` from ctx via
      // the (possibly-overridden) `workspaceIdFor`, then delegates to the
      // engine. Errors get scrubbed for token leaks before re-throwing.
      bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        PLUGIN_NAME,
        async (ctx, input) => {
          const workspaceId = resolveWorkspaceId(ctx);
          try {
            return await engine.apply(workspaceId, input);
          } catch (err) {
            throw sanitizeTokenLeak(err, opts.token);
          }
        },
      );

      bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        PLUGIN_NAME,
        async (ctx, input) => {
          const workspaceId = resolveWorkspaceId(ctx);
          try {
            return await engine.read(workspaceId, input);
          } catch (err) {
            throw sanitizeTokenLeak(err, opts.token);
          }
        },
      );

      bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        PLUGIN_NAME,
        async (ctx, input) => {
          const workspaceId = resolveWorkspaceId(ctx);
          try {
            return await engine.list(workspaceId, input);
          } catch (err) {
            throw sanitizeTokenLeak(err, opts.token);
          }
        },
      );

      bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        PLUGIN_NAME,
        async (ctx, input) => {
          const workspaceId = resolveWorkspaceId(ctx);
          try {
            return await engine.diff(workspaceId, input);
          } catch (err) {
            throw sanitizeTokenLeak(err, opts.token);
          }
        },
      );
    },

    async shutdown() {
      // Defensive against a shutdown call without a successful init: the
      // kernel may still call shutdown for plugins that failed init,
      // depending on how partial state propagates.
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

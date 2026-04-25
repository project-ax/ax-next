// ---------------------------------------------------------------------------
// Host-side plugin for @ax/workspace-git-http.
//
// Registers the four `workspace:*` service hooks against an HTTP client
// pointed at the git-server pod. Single responsibility: marshal hook calls
// onto the wire, hydrate wire responses back into the lazy WorkspaceDelta
// shape that subscribers expect from the in-process backend.
//
// Two factories:
//   - createWorkspaceGitHttpPlugin({baseUrl, token}) — production. Builds
//     the HTTP client synchronously inside init().
//   - createWorkspaceGitHttpPluginAsync({boot}) — TEST-ONLY. The boot
//     callback runs once inside init() and yields {baseUrl, token}. Used by
//     the contract test harness so each test scenario can spin up a fresh
//     in-process server.
//
// Invariant I2 (no cross-plugin imports): the host plugin imports from
// @ax/core and @ax/workspace-protocol only. Server-side bits (and their
// dependency on @ax/workspace-git-core) are isolated to ./server/*.
// ---------------------------------------------------------------------------

import {
  asWorkspaceVersion,
  type Bytes,
  type HookBus,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceChange,
  type WorkspaceDelta,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { base64ToBytes, bytesToBase64 } from '@ax/workspace-protocol';
import {
  createWorkspaceGitHttpClient,
  type WorkspaceGitHttpClient,
} from './client.js';

const PLUGIN_NAME = '@ax/workspace-git-http';

export interface CreateWorkspaceGitHttpPluginOptions {
  baseUrl: string;
  token: string;
}

/**
 * Multi-replica workspace plugin: forwards every `workspace:*` hook to the
 * shared git-server pod over HTTP. Use this when the deployment runs more
 * than one host replica that needs to share workspace state. Single-replica
 * deployments use `@ax/workspace-git` instead.
 */
export function createWorkspaceGitHttpPlugin(
  opts: CreateWorkspaceGitHttpPluginOptions,
): Plugin {
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
      const client = createWorkspaceGitHttpClient({
        baseUrl: opts.baseUrl,
        token: opts.token,
      });
      registerHostHooks(bus, client);
    },
  };
}

/**
 * @internal Test-only async variant. The `boot` callback runs once per
 * `init()` call (i.e., once per harness instance) and yields the connection
 * info. The contract test uses this to spin up a fresh in-process server
 * per scenario without leaking cross-test version history.
 *
 * Production callers should use `createWorkspaceGitHttpPlugin` with a
 * static baseUrl from config.
 */
export interface CreateWorkspaceGitHttpPluginAsyncOptions {
  boot: () => Promise<{ baseUrl: string; token: string }>;
}

export function createWorkspaceGitHttpPluginAsync(
  opts: CreateWorkspaceGitHttpPluginAsyncOptions,
): Plugin {
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
      const { baseUrl, token } = await opts.boot();
      const client = createWorkspaceGitHttpClient({ baseUrl, token });
      registerHostHooks(bus, client);
    },
  };
}

// ---------------------------------------------------------------------------
// Hook registration (shared between the sync and async factories).
// ---------------------------------------------------------------------------
function registerHostHooks(bus: HookBus, client: WorkspaceGitHttpClient): void {
  bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    PLUGIN_NAME,
    async (_ctx, input) => {
      // No host-side empty-turn short-circuit, deliberately. The in-process
      // backend can short-circuit safely because it knows the current ref
      // (impl.ts:394-403). We don't — the canonical version lives on the
      // git-server pod, and another replica may have advanced HEAD between
      // our last response and this call. Short-circuiting here would
      // (a) skip the parent-CAS check the contract requires (see the
      // "parent mismatch raises PluginError" assertion) and (b) hand the
      // caller a stale `before === after` against a parent that no longer
      // matches the server. The server's own short-circuit kicks in once
      // we get there, so the only cost we pay is one round-trip.
      const wireRes = await client.apply({
        changes: input.changes.map((c) =>
          c.kind === 'put'
            ? {
                path: c.path,
                kind: 'put' as const,
                contentBase64: bytesToBase64(c.content),
              }
            : { path: c.path, kind: 'delete' as const },
        ),
        parent: input.parent === null ? null : (input.parent as string),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });

      return {
        version: asWorkspaceVersion(wireRes.version),
        delta: hydrateDelta(wireRes.delta),
      };
    },
  );

  bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    PLUGIN_NAME,
    async (_ctx, input) => {
      const r = await client.read({
        path: input.path,
        ...(input.version !== undefined
          ? { version: input.version as string }
          : {}),
      });
      if (r.found) return { found: true, bytes: base64ToBytes(r.bytesBase64) };
      return { found: false };
    },
  );

  bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    PLUGIN_NAME,
    async (_ctx, input) => {
      const r = await client.list({
        ...(input.pathGlob !== undefined ? { pathGlob: input.pathGlob } : {}),
        ...(input.version !== undefined
          ? { version: input.version as string }
          : {}),
      });
      return { paths: r.paths };
    },
  );

  bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
    'workspace:diff',
    PLUGIN_NAME,
    async (_ctx, input) => {
      const r = await client.diff({
        from: input.from === null ? null : (input.from as string),
        to: input.to as string,
      });
      return { delta: hydrateDelta(r.delta) };
    },
  );
}

// ---------------------------------------------------------------------------
// Wire-shape -> WorkspaceDelta hydration.
//
// Bytes are already in memory once we receive the response (HTTP isn't lazy),
// so the closures we wrap them in are trivial Promise.resolve() returns.
// The point of laziness here is shape parity with the in-process backend so
// subscribers see the same shape regardless of transport — they MUST call
// contentBefore()/contentAfter() to get bytes, regardless of which backend
// served the hook.
// ---------------------------------------------------------------------------

// Type alias inferred from the client surface — keeps us in sync with the
// wire schema without re-stating it. (Identical structure on apply.delta and
// diff.delta since both reuse WireDeltaSchema in @ax/workspace-protocol.)
type WireDelta = Awaited<ReturnType<WorkspaceGitHttpClient['apply']>>['delta'];

function hydrateDelta(d: WireDelta): WorkspaceDelta {
  const changes: WorkspaceChange[] = d.changes.map((c) => {
    if (c.kind === 'added') {
      const bytes: Bytes = base64ToBytes(c.contentAfterBase64);
      return {
        path: c.path,
        kind: 'added',
        contentAfter: () => Promise.resolve(bytes),
      };
    }
    if (c.kind === 'modified') {
      const before: Bytes = base64ToBytes(c.contentBeforeBase64);
      const after: Bytes = base64ToBytes(c.contentAfterBase64);
      return {
        path: c.path,
        kind: 'modified',
        contentBefore: () => Promise.resolve(before),
        contentAfter: () => Promise.resolve(after),
      };
    }
    // c.kind === 'deleted'
    const before: Bytes = base64ToBytes(c.contentBeforeBase64);
    return {
      path: c.path,
      kind: 'deleted',
      contentBefore: () => Promise.resolve(before),
    };
  });

  const out: WorkspaceDelta = {
    before: d.before === null ? null : asWorkspaceVersion(d.before),
    after: asWorkspaceVersion(d.after),
    changes,
  };
  if (d.reason !== undefined) out.reason = d.reason;
  if (d.author !== undefined) out.author = d.author;
  return out;
}

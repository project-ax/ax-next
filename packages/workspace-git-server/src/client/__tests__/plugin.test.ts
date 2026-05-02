// ---------------------------------------------------------------------------
// Spec for the production host-side plugin factory
// `createWorkspaceGitServerPlugin` (Tasks 10/11 of Phase 2 workspace redesign).
//
// What this exercises that git-engine.test.ts cannot:
//
//   1. Manifest shape — pinned exactly so subscribers + boundary review tools
//      can rely on it.
//   2. End-to-end through the hook bus + a real `bootstrap()` from `@ax/core`,
//      i.e. the same shape the production kernel uses. The git-engine smoke
//      tests bypass the bus.
//   3. workspaceId derivation: the plugin computes an id per-call from
//      `ctx`, so two ctxs (different userId/agentId) yield two distinct
//      bare repos under the storage tier's repoRoot. Filesystem inspection
//      proves the derivation is wired through the hook handlers.
//   4. workspaceIdFor injection — production callers leave it unset, but
//      tests need to collide ids deliberately.
//   5. Kernel-shutdown semantics: `harness.close()` -> plugin.shutdown ->
//      engine.shutdown -> mirrorCache.shutdown. The cache's tempdirs are
//      removed; the engine's queue map drains.
//   6. Token-leak prevention: a known token NEVER appears in any error
//      message thrown out of any of the four hooks. Belt-and-suspenders
//      over the lifecycle client + git binary's own discipline.
// ---------------------------------------------------------------------------

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PluginError,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../../server/index.js';
import {
  _sanitizeTokenLeak,
  createWorkspaceGitServerPlugin,
} from '../plugin.js';

const TOKEN = 'super-secret-test-token-do-not-leak';

interface BootedServer {
  server: WorkspaceGitServer;
  baseUrl: string;
  repoRoot: string;
}

const bootedServers: BootedServer[] = [];
const cacheRoots: string[] = [];

async function bootServer(): Promise<BootedServer> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-plugin-test-repos-'));
  const server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  const booted: BootedServer = {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    repoRoot,
  };
  bootedServers.push(booted);
  return booted;
}

function freshCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ax-plugin-test-cache-'));
  cacheRoots.push(root);
  return root;
}

afterEach(async () => {
  // Close any servers + clean up temp dirs left over from a test that
  // didn't tear them down explicitly.
  await Promise.allSettled(bootedServers.map((b) => b.server.close()));
  await Promise.allSettled(
    bootedServers.map((b) => rm(b.repoRoot, { recursive: true, force: true })),
  );
  bootedServers.length = 0;
  await Promise.allSettled(
    cacheRoots.map((r) => rm(r, { recursive: true, force: true })),
  );
  cacheRoots.length = 0;
});

// ---------------------------------------------------------------------------
// 1. Manifest shape
// ---------------------------------------------------------------------------

describe('createWorkspaceGitServerPlugin — manifest', () => {
  it('exposes the four workspace hooks, no calls, no subscribes', () => {
    const plugin = createWorkspaceGitServerPlugin({
      baseUrl: 'http://127.0.0.1:0',
      token: TOKEN,
    });
    expect(plugin.manifest.name).toBe('@ax/workspace-git-server');
    expect(plugin.manifest.registers).toEqual([
      'workspace:apply',
      'workspace:read',
      'workspace:list',
      'workspace:diff',
    ]);
    expect(plugin.manifest.calls).toEqual([]);
    expect(plugin.manifest.subscribes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end apply through the hook bus
// ---------------------------------------------------------------------------

describe('createWorkspaceGitServerPlugin — end-to-end apply', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  it('apply succeeds and returns a version + delta', async () => {
    const booted = await bootServer();
    harness = await createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: booted.baseUrl,
          token: TOKEN,
          cacheRoot: freshCacheRoot(),
        }),
      ],
    });

    const result = await harness.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', harness.ctx(), {
      changes: [
        {
          path: 'README.md',
          kind: 'put',
          content: new TextEncoder().encode('hello plugin'),
        },
      ],
      parent: null,
      reason: 'initial',
    });

    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);
    expect(result.delta.before).toBeNull();
    expect(result.delta.after).toBe(result.version);
    expect(result.delta.reason).toBe('initial');
    expect(result.delta.changes).toHaveLength(1);
    const [change] = result.delta.changes;
    expect(change?.path).toBe('README.md');
    expect(change?.kind).toBe('added');
  });
});

// ---------------------------------------------------------------------------
// 3. workspaceIdFor derives different IDs for different ctxs -> distinct repos
// ---------------------------------------------------------------------------

describe('createWorkspaceGitServerPlugin — distinct ctxs isolate to distinct workspaces', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  it('two ctxs (different userId/agentId) yield two bare repos under repoRoot', async () => {
    const booted = await bootServer();
    harness = await createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: booted.baseUrl,
          token: TOKEN,
          cacheRoot: freshCacheRoot(),
        }),
      ],
    });

    const ctxA = harness.ctx({ userId: 'alice', agentId: 'agent-1' });
    const ctxB = harness.ctx({ userId: 'bob', agentId: 'agent-2' });

    await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctxA,
      {
        changes: [
          {
            path: 'a.txt',
            kind: 'put',
            content: new TextEncoder().encode('A'),
          },
        ],
        parent: null,
      },
    );
    await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctxB,
      {
        changes: [
          {
            path: 'b.txt',
            kind: 'put',
            content: new TextEncoder().encode('B'),
          },
        ],
        parent: null,
      },
    );

    // Two distinct bare repos exist under repoRoot, named after the
    // workspaceIdFor-derived ids.
    const entries = readdirSync(booted.repoRoot).filter((e) => e.endsWith('.git'));
    expect(entries.length).toBe(2);
    // And both start with the `ws-` prefix the derivation enforces.
    for (const name of entries) {
      expect(name).toMatch(/^ws-[a-f0-9]{16}\.git$/);
    }

    // Cross-check: reading from ctxA finds 'a.txt' but not 'b.txt'.
    const readA = await harness.bus.call<
      WorkspaceReadInput,
      WorkspaceReadOutput
    >('workspace:read', ctxA, { path: 'a.txt' });
    expect(readA.found).toBe(true);
    const missingFromA = await harness.bus.call<
      WorkspaceReadInput,
      WorkspaceReadOutput
    >('workspace:read', ctxA, { path: 'b.txt' });
    expect(missingFromA.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Custom workspaceIdFor injection
// ---------------------------------------------------------------------------

describe('createWorkspaceGitServerPlugin — custom workspaceIdFor', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  it('uses the injected workspaceIdFor regardless of ctx', async () => {
    const booted = await bootServer();
    harness = await createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: booted.baseUrl,
          token: TOKEN,
          cacheRoot: freshCacheRoot(),
          workspaceIdFor: () => 'ws-fixed-test',
        }),
      ],
    });

    const ctxA = harness.ctx({ userId: 'alice', agentId: 'agent-1' });
    const ctxB = harness.ctx({ userId: 'bob', agentId: 'agent-2' });

    const seed = await harness.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', ctxA, {
      changes: [
        {
          path: 'shared.txt',
          kind: 'put',
          content: new TextEncoder().encode('seed'),
        },
      ],
      parent: null,
    });

    // ctxB should land on the SAME workspace (fixed id), so a parent: null
    // call would parent-mismatch — but a call using `seed.version` as parent
    // must succeed if and only if both ctxs route to the same repo.
    const second = await harness.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', ctxB, {
      changes: [
        {
          path: 'also-shared.txt',
          kind: 'put',
          content: new TextEncoder().encode('B'),
        },
      ],
      parent: seed.version,
    });
    expect(second.delta.before).toBe(seed.version);

    const entries = readdirSync(booted.repoRoot).filter((e) => e.endsWith('.git'));
    expect(entries).toEqual(['ws-fixed-test.git']);
  });
});

// ---------------------------------------------------------------------------
// 5. Shutdown drains queues + removes mirror dirs
// ---------------------------------------------------------------------------

describe('createWorkspaceGitServerPlugin — shutdown', () => {
  // Track the harness across the test body so afterEach can drain it on
  // failure paths. If an assertion throws BEFORE the explicit `harness.close()`
  // below, the plugin's mirror cache + engine queue would otherwise leak into
  // later tests.
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  it('harness.close() removes the cache root tempdirs and drains the engine queue', async () => {
    const booted = await bootServer();
    const cacheRoot = freshCacheRoot();
    harness = await createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: booted.baseUrl,
          token: TOKEN,
          cacheRoot,
        }),
      ],
    });

    await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      harness.ctx(),
      {
        changes: [
          {
            path: 'x.txt',
            kind: 'put',
            content: new TextEncoder().encode('x'),
          },
        ],
        parent: null,
      },
    );

    // Pre-shutdown sanity: the cache root has at least one dir entry
    // (the bare mirror init'd by the engine via the cache).
    expect(existsSync(cacheRoot)).toBe(true);
    const before = readdirSync(cacheRoot);
    expect(before.length).toBeGreaterThan(0);

    await harness.close();
    // The successful-path close happened — clear the outer ref so afterEach
    // doesn't try to close a drained harness a second time.
    harness = null;

    // Post-shutdown: the cache's mirror dirs are gone. The cache root itself
    // may persist (the cache only rm's the mirror subdirs it created), so we
    // assert on its CONTENTS being empty.
    if (existsSync(cacheRoot)) {
      expect(readdirSync(cacheRoot)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Token never appears in any thrown error message
// ---------------------------------------------------------------------------

describe('createWorkspaceGitServerPlugin — token never leaks in errors', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  // Pick a baseUrl that points at a port that refuses connections so each
  // hook hits a hard failure path. 127.0.0.1:1 is a privileged-port
  // ECONNREFUSED on every reasonable test machine. We don't bother running
  // a real server — the failure happens before any network round-trip
  // succeeds, which is the point: the failure path is what we're vetting.
  const FAKE_BASE_URL = 'http://127.0.0.1:1';

  async function bootBrokenHarness(): Promise<TestHarness> {
    return createTestHarness({
      plugins: [
        createWorkspaceGitServerPlugin({
          baseUrl: FAKE_BASE_URL,
          token: TOKEN,
          cacheRoot: freshCacheRoot(),
          // Keep retries small to fail fast.
          retry: { maxAttempts: 0 },
        }),
      ],
    });
  }

  function assertNoTokenLeak(err: unknown): void {
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    // Both message AND stack must NOT mention the token.
    expect(e.message).not.toContain(TOKEN);
    if (typeof e.stack === 'string') {
      expect(e.stack).not.toContain(TOKEN);
    }
  }

  it('apply error never contains the token', async () => {
    harness = await bootBrokenHarness();
    let captured: unknown;
    try {
      await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        harness.ctx(),
        {
          changes: [
            {
              path: 'x',
              kind: 'put',
              content: new TextEncoder().encode('x'),
            },
          ],
          parent: null,
        },
      );
    } catch (err) {
      captured = err;
    }
    assertNoTokenLeak(captured);
  });

  it('read error never contains the token', async () => {
    harness = await bootBrokenHarness();
    let captured: unknown;
    try {
      await harness.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        harness.ctx(),
        { path: 'whatever' },
      );
    } catch (err) {
      captured = err;
    }
    assertNoTokenLeak(captured);
  });

  it('list error never contains the token', async () => {
    harness = await bootBrokenHarness();
    let captured: unknown;
    try {
      await harness.bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        harness.ctx(),
        {},
      );
    } catch (err) {
      captured = err;
    }
    assertNoTokenLeak(captured);
  });

  it('diff error never contains the token', async () => {
    harness = await bootBrokenHarness();
    let captured: unknown;
    try {
      await harness.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        harness.ctx(),
        {
          from: null,
          // A bogus oid; we never actually reach the comparison because the
          // earlier fetch fails. The point is to exercise the diff hook
          // handler's catch.
          to: '0'.repeat(40) as unknown as WorkspaceDiffInput['to'],
        },
      );
    } catch (err) {
      captured = err;
    }
    assertNoTokenLeak(captured);
  });
});

// ---------------------------------------------------------------------------
// 7. _sanitizeTokenLeak unit tests — pin each documented behavior directly.
//
// The end-to-end token-leak tests above intentionally hit a closed port. The
// resulting Node fetch error is wrapped by `repo-lifecycle.ts:opError`, which
// already omits the token. So the scrubber runs against an error that was
// already clean — the tests pass whether the scrubber exists or not. They're
// still useful (they document that the fast-fail belt doesn't hang under
// retry), but they don't pin scrubber behavior.
//
// These unit tests pin scrubber behavior directly by feeding it inputs that
// DO contain the token.
// ---------------------------------------------------------------------------

describe('_sanitizeTokenLeak (internal)', () => {
  it('scrubs the token from a plain Error message', () => {
    const err = new Error(`POST /repos failed: token=${TOKEN}`);
    const result = _sanitizeTokenLeak(err, TOKEN);
    expect(result).toBe(err); // mutates in place
    expect((result as Error).message).not.toContain(TOKEN);
    expect((result as Error).message).toContain('<redacted>');
  });

  it('preserves PluginError code + instanceof while scrubbing', () => {
    const err = new PluginError({
      code: 'parent-mismatch',
      plugin: '@ax/workspace-git-server',
      message: `token=${TOKEN} mismatch`,
    });
    const result = _sanitizeTokenLeak(err, TOKEN);
    expect(result).toBeInstanceOf(PluginError);
    expect((result as PluginError).code).toBe('parent-mismatch');
    expect((result as PluginError).message).not.toContain(TOKEN);
    expect((result as PluginError).message).toContain('<redacted>');
  });

  it('passes non-Error values through unchanged', () => {
    const stringErr = `token=${TOKEN}`;
    const result = _sanitizeTokenLeak(stringErr, TOKEN);
    // Strings (and other non-Error values) we deliberately don't touch — the
    // contract is that we scrub Error message/stack only. Pass-through means
    // the caller still sees whatever they threw, including the token.
    expect(result).toBe(stringErr);
  });

  it('is a no-op when the token is empty (guard against false positives)', () => {
    const err = new Error('some unrelated message with <> chars');
    const before = err.message;
    const result = _sanitizeTokenLeak(err, '');
    expect(result).toBe(err);
    expect((result as Error).message).toBe(before);
  });

  it('scrubs the stack as well as the message', () => {
    const err = new Error('clean message');
    // Force a stack containing the token, even though the message doesn't.
    err.stack = `Error: clean message\n    at someFn (file.ts:1:1)\n    token=${TOKEN}`;
    const result = _sanitizeTokenLeak(err, TOKEN);
    expect((result as Error).message).not.toContain(TOKEN);
    expect((result as Error).stack).not.toContain(TOKEN);
    expect((result as Error).stack).toContain('<redacted>');
  });
});

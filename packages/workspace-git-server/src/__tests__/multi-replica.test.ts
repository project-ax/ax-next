// Bonus I1 proof for `@ax/workspace-git-server`'s production plugin:
// multi-replica concurrency without a host-side mutex.
//
// Three host plugins (separate buses + harnesses) all talk to ONE in-process
// git-server, all derive the SAME `workspaceId` (via the test override), and
// each fires a concurrent apply against the same seed parent. Exactly one
// wins per round; the losers receive `parent-mismatch` PluginError with
// `cause.actualParent` set to the server's current head; a retry loop using
// `cause.actualParent` succeeds; the final list shows linear history with
// all replica writes.
//
// This is the production-plugin counterpart of
// `packages/workspace-git-http/src/__tests__/multi-replica.test.ts`. The
// shape is intentionally parallel — the assertion that subscribers can rely
// on `cause.actualParent` to retry is a CONTRACT, not an implementation
// detail of one host plugin.

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestHarness,
  type TestHarness,
} from '@ax/test-harness';
import {
  PluginError,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceVersion,
} from '@ax/core';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../server/index.js';
import { createWorkspaceGitServerPlugin } from '../client/plugin.js';

const TOKEN = 'secret';
const SHARED_WORKSPACE_ID = 'ws-multi-test';

describe('multi-replica concurrent applies (production plugin)', () => {
  let server: WorkspaceGitServer | null = null;
  let repoRoot: string | null = null;
  const cacheRoots: string[] = [];
  let harnesses: TestHarness[] = [];

  afterEach(async () => {
    // Tear down harnesses BEFORE the server so any in-flight host-side
    // requests get a chance to settle against a still-listening server.
    // harness.close() drives plugin.shutdown() which drains the engine's
    // queues + clears the mirror-cache tempdirs.
    await Promise.all(harnesses.map((h) => h.close()));
    harnesses = [];
    if (server) await server.close();
    server = null;
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true });
      repoRoot = null;
    }
    await Promise.allSettled(
      cacheRoots.map((r) => rm(r, { recursive: true, force: true })),
    );
    cacheRoots.length = 0;
  });

  it('three host replicas fire concurrent applies; exactly one wins per round; retries via cause.actualParent produce a linear history with all changes', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-server-multi-'));
    server = await createWorkspaceGitServer({
      repoRoot,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // Three independent host replicas — separate harnesses + buses + plugins,
    // each with its own mirror-cache tempdir (so the replicas don't share a
    // mirror — they're truly separate "host pods" pointing at the same
    // storage tier). The `workspaceIdFor` override pins them all to the same
    // workspaceId so they collide at the storage tier.
    harnesses = await Promise.all(
      [0, 1, 2].map(async () => {
        const cacheRoot = mkdtempSync(join(tmpdir(), 'ax-ws-server-multi-cache-'));
        cacheRoots.push(cacheRoot);
        return createTestHarness({
          plugins: [
            createWorkspaceGitServerPlugin({
              baseUrl,
              token: TOKEN,
              cacheRoot,
              workspaceIdFor: () => SHARED_WORKSPACE_ID,
            }),
          ],
        });
      }),
    );

    // Initial seed: replica 0 commits with parent: null so all three replicas
    // share the same starting version. Subsequent applies on replicas 1 and 2
    // will fetch the mirror and discover this seed during their first
    // operation.
    const enc = new TextEncoder();
    const seed = await harnesses[0]!.bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', harnesses[0]!.ctx(), {
      changes: [{ path: 'seed', kind: 'put', content: enc.encode('s') }],
      parent: null,
    });

    // Each replica wants to add its own file from the same seed parent.
    // Fire all three concurrently. Exactly one wins on the first attempt;
    // the other two get parent-mismatch with cause.actualParent set to the
    // server's current head — they read it and retry.
    async function applyWithRetry(
      idx: number,
      currentParent: WorkspaceVersion,
    ): Promise<{ version: WorkspaceVersion; retries: number }> {
      let attempt = 0;
      let p: WorkspaceVersion = currentParent;
      while (true) {
        try {
          const r = await harnesses[idx]!.bus.call<
            WorkspaceApplyInput,
            WorkspaceApplyOutput
          >('workspace:apply', harnesses[idx]!.ctx(), {
            changes: [
              {
                path: `replica-${idx}.txt`,
                kind: 'put',
                content: enc.encode(`r${idx}`),
              },
            ],
            parent: p,
          });
          return { version: r.version, retries: attempt };
        } catch (err) {
          if (err instanceof PluginError && err.code === 'parent-mismatch') {
            attempt++;
            if (attempt > 5) {
              throw new Error(
                `replica ${idx} exhausted retries (last err: ${err.message})`,
              );
            }
            const cause = err.cause as
              | { actualParent?: WorkspaceVersion | null }
              | undefined;
            const actual = cause?.actualParent;
            if (actual === undefined || actual === null) {
              throw new Error(
                `replica ${idx} got parent-mismatch without cause.actualParent`,
              );
            }
            p = actual;
          } else {
            throw err;
          }
        }
      }
    }

    const outcomes = await Promise.all(
      [0, 1, 2].map((i) => applyWithRetry(i, seed.version)),
    );
    const results = outcomes.map((o) => o.version);
    const totalRetries = outcomes.reduce((acc, o) => acc + o.retries, 0);

    // Three distinct successful versions — proves a linear history with
    // three commits past the seed.
    expect(new Set(results).size).toBe(3);

    // Assert the retry path was actually exercised. With three concurrent
    // applies racing the same parent, exactly one wins on attempt 0; the
    // other two get parent-mismatch and retry. The minimum total-retries
    // across replicas is therefore N-1 = 2 (well-behaved retry fans out
    // perfectly) and could be higher if the second-place replica also
    // collides with the third on its retry. If totalRetries is 0, either
    // the test is no longer racing the storage tier (e.g. someone added a
    // host-side serializing lock) or the parent-mismatch → retry path
    // regressed. Either way we want the failure here, not as a silent
    // pass that proves nothing.
    expect(totalRetries).toBeGreaterThanOrEqual(2);

    // Final list (from any replica) shows seed + all three replica files.
    const finalList = await harnesses[0]!.bus.call<
      WorkspaceListInput,
      WorkspaceListOutput
    >('workspace:list', harnesses[0]!.ctx(), {});
    expect([...finalList.paths].sort()).toEqual([
      'replica-0.txt',
      'replica-1.txt',
      'replica-2.txt',
      'seed',
    ]);
  });
});

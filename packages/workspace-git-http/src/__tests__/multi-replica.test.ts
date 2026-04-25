// Bonus I1 proof for @ax/workspace-git-http: multi-replica concurrency.
//
// Three host plugins (separate buses + harnesses) all talk to ONE in-process
// git-server. Each fires a concurrent apply against the same seed parent.
// Exactly one wins per round; the losers receive `parent-mismatch`
// PluginError with `cause.actualParent` set to the server's current head;
// a retry loop using `cause.actualParent` succeeds; the final list shows
// linear history with all replica writes.
//
// This proves the multi-replica story works without serializing through a
// single in-process mutex on the host side — the mutex lives on the
// git-server pod (which is `replicas: 1` by chart design).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../server/index.js';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createWorkspaceGitHttpPlugin } from '../plugin.js';
import {
  PluginError,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceVersion,
} from '@ax/core';

describe('multi-replica concurrent applies', () => {
  let server: WorkspaceGitServer | null = null;
  let harnesses: TestHarness[] = [];

  afterEach(async () => {
    // Tear down harnesses BEFORE the server so any in-flight host-side
    // requests get a chance to settle against a still-listening server.
    // close() drains each plugin's optional shutdown() — host-side
    // workspace-git-http doesn't currently implement one, so this is
    // a no-op today, but the pattern is correct for when it does.
    await Promise.all(harnesses.map((h) => h.close()));
    harnesses = [];
    if (server) await server.close();
    server = null;
  });

  it('three host replicas fire concurrent applies; exactly one wins per round; retries via cause.actualParent produce a linear history with all changes', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-multi-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // Three independent host replicas — separate buses + harnesses + plugins.
    // They share the same baseUrl + token (they're "replicas" of the same
    // logical host, talking to the same git-server pod).
    harnesses = await Promise.all(
      [0, 1, 2].map(async () =>
        createTestHarness({
          plugins: [createWorkspaceGitHttpPlugin({ baseUrl, token: 'secret' })],
        }),
      ),
    );

    // Initial seed: replica 0 commits parent: null so all three replicas
    // share the same starting version.
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
    // the test is no longer racing the mutex (e.g. someone added a
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

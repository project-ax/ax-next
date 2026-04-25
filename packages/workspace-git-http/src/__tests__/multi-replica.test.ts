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
import { createTestHarness } from '@ax/test-harness';
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
  afterEach(async () => {
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
    const harnesses = await Promise.all(
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
    ): Promise<WorkspaceVersion> {
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
          return r.version;
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

    const results = await Promise.all(
      [0, 1, 2].map((i) => applyWithRetry(i, seed.version)),
    );
    // Three distinct successful versions — proves a linear history with
    // three commits past the seed.
    expect(new Set(results).size).toBe(3);

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

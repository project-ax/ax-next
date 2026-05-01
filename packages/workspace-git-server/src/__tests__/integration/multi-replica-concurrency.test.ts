// Multi-replica concurrency: two host plugins point at the same workspace
// on the same server and apply different changes in parallel. The CAS
// (--force-with-lease) discipline in the test-only plugin must guarantee
// that exactly one apply wins, the other surfaces as parent-mismatch, and
// the loser can retry against the new head to land its change.
//
// This is the integration-level proof of open question Q#1 in the Phase 1
// plan: a single server replica per shard is acceptable because parent-
// CAS rejects the loser cleanly without corrupting either side's view.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, HookBus, makeAgentContext, asWorkspaceVersion } from '@ax/core';
import type {
  Plugin,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceVersion,
} from '@ax/core';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../../server/index.js';
import { createTestOnlyGitServerPlugin } from '../../client/plugin-test-only.js';
import { createRepoLifecycleClient } from '../../client/repo-lifecycle.js';

const TOKEN = 'secret';
const enc = new TextEncoder();

interface BootedPlugin {
  plugin: Plugin;
  bus: HookBus;
}

async function bootPlugin(
  baseUrl: string,
  workspaceId: string,
): Promise<BootedPlugin> {
  const plugin = createTestOnlyGitServerPlugin({
    boot: async () => ({ baseUrl, token: TOKEN, workspaceId }),
  });
  const bus = new HookBus();
  await bootstrap({ bus, plugins: [plugin], config: {} });
  return { plugin, bus };
}

async function shutdown(p: BootedPlugin): Promise<void> {
  if (typeof p.plugin.shutdown === 'function') {
    await p.plugin.shutdown();
  }
}

function ctx() {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
  });
}

describe('multi-replica concurrency', () => {
  let server: WorkspaceGitServer;
  let repoRoot: string;
  const workspaceId = 'multireplica1';

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-server-multi-'));
    server = await createWorkspaceGitServer({
      repoRoot,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('two plugins racing parent: v0 — exactly one wins, loser retries on v1', async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // 1. Create the workspace once via REST.
    const lifecycle = createRepoLifecycleClient({ baseUrl, token: TOKEN });
    await lifecycle.createRepo(workspaceId);

    // 2. Boot a "seed" plugin that lays down the initial commit.
    const seed = await bootPlugin(baseUrl, workspaceId);
    const v0Result = await seed.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx(),
      {
        changes: [{ path: 'init', kind: 'put', content: enc.encode('i') }],
        parent: null,
        reason: 'seed',
      },
    );
    const v0 = v0Result.version;
    expect(typeof v0).toBe('string');
    await shutdown(seed);

    // 3. Two independent plugins, each with its own mirror tempdir.
    const a = await bootPlugin(baseUrl, workspaceId);
    const b = await bootPlugin(baseUrl, workspaceId);

    // 4. Both apply concurrently with parent: v0.
    const applyA = a.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx(),
      {
        changes: [{ path: 'a.txt', kind: 'put', content: enc.encode('A') }],
        parent: v0,
        reason: 'apply-A',
      },
    );
    const applyB = b.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx(),
      {
        changes: [{ path: 'b.txt', kind: 'put', content: enc.encode('B') }],
        parent: v0,
        reason: 'apply-B',
      },
    );
    const results = await Promise.allSettled([applyA, applyB]);

    // Exactly one fulfilled, exactly one rejected with parent-mismatch.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const winner = fulfilled[0]! as PromiseFulfilledResult<WorkspaceApplyOutput>;
    const loser = rejected[0]! as PromiseRejectedResult;

    expect(loser.reason).toMatchObject({ code: 'parent-mismatch' });

    const v1 = winner.value.version;
    expect(v1).not.toBe(v0);

    // 5. Identify which plugin won so we know which one needs to retry.
    // Check both mirror states by issuing read on each — the winner already
    // saw its change, the loser did not.
    const aHasA = await readExists(a.bus, 'a.txt');
    const aHasB = await readExists(a.bus, 'b.txt');
    const bHasA = await readExists(b.bus, 'a.txt');
    const bHasB = await readExists(b.bus, 'b.txt');

    // After the race, every plugin's read does its own fetchMirror, so both
    // plugins should see the winner's change at v1. Exactly one of {a,b}
    // landed; the other (the loser's) did NOT.
    expect(aHasA).toBe(bHasA);
    expect(aHasB).toBe(bHasB);
    const aLanded = aHasA;
    const bLanded = aHasB;
    expect(aLanded !== bLanded).toBe(true);

    // 6. Identify the loser plugin (the one whose change is NOT on the remote).
    let loserPlugin: BootedPlugin;
    let loserChange: { path: string; content: Uint8Array };
    if (aLanded) {
      // A's change landed; B lost.
      loserPlugin = b;
      loserChange = { path: 'b.txt', content: enc.encode('B') };
    } else {
      // B's change landed; A lost.
      loserPlugin = a;
      loserChange = { path: 'a.txt', content: enc.encode('A') };
    }

    // 7. Loser retries with parent: v1 — succeeds, returns v2.
    const retry = await loserPlugin.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx(),
      {
        changes: [{ path: loserChange.path, kind: 'put', content: loserChange.content }],
        parent: v1,
        reason: 'retry-loser',
      },
    );
    const v2 = retry.version;
    expect(v2).not.toBe(v1);
    expect(v2).not.toBe(v0);

    // 8. Final state: log on the bare repo shows exactly three commits.
    const repoPath = join(repoRoot, `${workspaceId}.git`);
    const log = await runGitCapture([
      '-C',
      repoPath,
      'log',
      '--oneline',
      'refs/heads/main',
    ]);
    const lines = log.stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(3);

    // Verify both files present at v2 in either plugin (both will see v2
    // after the retry's fetch).
    const finalA = await readExists(loserPlugin.bus, 'a.txt');
    const finalB = await readExists(loserPlugin.bus, 'b.txt');
    expect(finalA).toBe(true);
    expect(finalB).toBe(true);

    // Cleanup
    await shutdown(a);
    await shutdown(b);

    // suppress unused-variable warnings on intermediate checks.
    void asWorkspaceVersion;
  });
});

// --- Helpers --------------------------------------------------------------

async function readExists(bus: HookBus, path: string): Promise<boolean> {
  const r = await bus.call('workspace:read', ctx(), { path });
  return (r as { found: boolean }).found;
}

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGitCapture(args: readonly string[]): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

// Suppress unused-import warning — `WorkspaceVersion` is referenced via the
// generic argument and via implicit type inference in the apply calls above,
// but TS's "unused import" rule doesn't always pick that up.
type _Unused = WorkspaceVersion;

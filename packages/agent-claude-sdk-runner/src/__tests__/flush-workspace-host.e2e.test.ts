import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { IpcClient } from '@ax/ipc-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHostToolEntries } from '../host-mcp-server.js';
import { commitNotifyWithResync, flushWorkspaceToHost } from '../commit-notify-resync.js';
import { commitTurnAndBundle } from '../git-workspace.js';

// ---------------------------------------------------------------------------
// BUG-W2 real-path regression: a host tool that declares
// `flushWorkspaceBeforeCall` reads a file the agent wrote earlier in the SAME
// turn. Without the flush the host reads the committed + pushed workspace
// mirror, which lags the runner's live tree until a turn-boundary commit — so
// the read misses the just-written file.
//
// The existing host-side canaries MOCK workspace:list/read, so the
// committed-vs-live divergence never appears and the bug slips through. This
// test uses a REAL git workspace (runner side) AND a REAL bare mirror (host
// side), wired through the REAL host-tool forwarder + flush helper, so the
// divergence is genuine:
//
//   - write .ax/scratch/foo.txt to the runner's live tree (uncommitted)
//   - WITHOUT the flush, the host read of the mirror finds nothing (the bug)
//   - WITH the pre-forward flush, the runner commits + pushes the live tree to
//     the mirror first, so the host read finds the just-written file (the fix)
// ---------------------------------------------------------------------------

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function git(args: readonly string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function expectOk(r: GitResult, label: string): Promise<void> {
  if (r.code !== 0) throw new Error(`${label} failed (${r.code}): ${r.stderr}`);
}

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(tmpdir(), 'ax-flush-e2e-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/**
 * Stand up a real bare "host mirror" seeded with an empty-tree baseline, plus a
 * runner working clone with refs/heads/baseline pinned to it (the shape
 * materializeWorkspace produces). Returns both dirs; runner.baseline ==
 * runner.main == mirror.main == the baseline OID, so the runner's thin
 * `baseline..main` bundle applies cleanly to the mirror.
 */
async function setupWorkspace(): Promise<{
  runnerRoot: string;
  mirrorDir: string;
  baselineOid: string;
}> {
  const seedDir = path.join(scratch, 'seed');
  const mirrorDir = path.join(scratch, 'mirror.git');
  const runnerRoot = path.join(scratch, 'runner');

  await expectOk(await git(['init', '-b', 'main', seedDir]), 'seed init');
  await expectOk(await git(['-C', seedDir, 'config', 'user.email', 't@e.x']), 'seed cfg email');
  await expectOk(await git(['-C', seedDir, 'config', 'user.name', 't']), 'seed cfg name');
  await expectOk(
    await git(['-C', seedDir, 'commit', '--allow-empty', '-m', 'baseline']),
    'seed commit',
  );

  await expectOk(await git(['init', '--bare', '-b', 'main', mirrorDir]), 'mirror init');
  await expectOk(
    await git(['-C', seedDir, 'push', mirrorDir, 'main:refs/heads/main']),
    'seed push',
  );

  await expectOk(await git(['clone', mirrorDir, runnerRoot]), 'runner clone');
  await expectOk(
    await git(['-C', runnerRoot, 'update-ref', 'refs/heads/baseline', 'HEAD']),
    'runner baseline ref',
  );
  await expectOk(await git(['-C', runnerRoot, 'config', 'user.email', 't@e.x']), 'runner cfg email');
  await expectOk(await git(['-C', runnerRoot, 'config', 'user.name', 't']), 'runner cfg name');

  const rev = await git(['-C', runnerRoot, 'rev-parse', 'refs/heads/baseline']);
  await expectOk(rev, 'runner rev-parse baseline');
  return { runnerRoot, mirrorDir, baselineOid: rev.stdout.trim() };
}

/** Current refs/heads/main of the bare mirror, or null when it has no commits. */
async function mirrorMain(mirrorDir: string): Promise<string | null> {
  const r = await git(['-C', mirrorDir, 'rev-parse', '--quiet', '--verify', 'refs/heads/main']);
  return r.code === 0 && r.stdout.trim().length > 0 ? r.stdout.trim() : null;
}

/** Fetch a base64 thin bundle into the bare mirror, advancing refs/heads/main. */
async function fetchBundleAdvance(mirrorDir: string, bundleB64: string): Promise<string> {
  const bundleFile = path.join(scratch, `in-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
  await fs.writeFile(bundleFile, Buffer.from(bundleB64, 'base64'));
  try {
    await expectOk(
      await git(['-C', mirrorDir, 'fetch', bundleFile, '+refs/heads/main:refs/heads/main']),
      'mirror fetch bundle',
    );
    return (await mirrorMain(mirrorDir))!;
  } finally {
    await fs.rm(bundleFile, { force: true });
  }
}

/** Full bundle of the mirror's current main (the host's resync baselineBundleBytes). */
/**
 * Bundle the mirror's `main` to a temp file and return its PATH — matching how
 * the runner now receives the baseline bundle on the re-sync path: the IPC
 * client's `callBinary('workspace.export-baseline-bundle')` streams the host's
 * raw octet-stream body straight to a temp file (NO base64-in-JSON). The runner
 * (resyncBaselineAndReplay) takes ownership of the file and deletes it, so we
 * place it OUTSIDE the per-test `scratch` dir (in tmpdir) to avoid double-free.
 */
async function bundleMirrorMainToFile(
  mirrorDir: string,
): Promise<{ path: string; bytes: number }> {
  const f = path.join(
    tmpdir(),
    `ax-e2e-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`,
  );
  await expectOk(
    await git(['-C', mirrorDir, 'bundle', 'create', f, 'main']),
    'mirror bundle main',
  );
  const stat = await fs.stat(f);
  return { path: f, bytes: stat.size };
}

/** Simulate the host-side retire (workspace:apply delete) by committing a deletion onto the mirror's main. */
async function hostRetire(mirrorDir: string, relPath: string): Promise<string> {
  const wt = path.join(scratch, `host-retire-${Date.now()}`);
  await expectOk(await git(['clone', mirrorDir, wt]), 'host-retire clone');
  await expectOk(await git(['-C', wt, 'config', 'user.email', 'h@e.x']), 'host-retire cfg email');
  await expectOk(await git(['-C', wt, 'config', 'user.name', 'host']), 'host-retire cfg name');
  await fs.rm(path.join(wt, relPath), { force: true });
  await expectOk(await git(['-C', wt, 'add', '-A']), 'host-retire add');
  await expectOk(await git(['-C', wt, 'commit', '-m', 'retire draft']), 'host-retire commit');
  await expectOk(await git(['-C', wt, 'push', mirrorDir, 'HEAD:refs/heads/main']), 'host-retire push');
  return (await mirrorMain(mirrorDir))!;
}

/**
 * A real-git IpcClient stand-in. `workspace.commit-notify` is parent-aware
 * (what the real git-server does): it applies the thin bundle only when the
 * caller's parent matches the mirror head, otherwise it returns the
 * concurrent-writer signal (`accepted:false` + `actualParent`, head only — the
 * baseline bundle is fetched out-of-band) so the runner's resync path engages.
 * The runner then calls `callBinary('workspace.export-baseline-bundle', {version})`
 * to stream the baseline bundle to a temp file. `tool.execute-host` reads the
 * mirror for the just-written file. No mocking of the workspace layer — both
 * sides are real git.
 */
function makeHostClient(mirrorDir: string): IpcClient {
  const norm = (h: string | null | undefined): string | null => (h && h.length ? h : null);
  return {
    call: async (action: string, payload: unknown) => {
      if (action === 'workspace.commit-notify') {
        const { parentVersion, bundleBytes } = payload as {
          parentVersion: string | null;
          bundleBytes: string;
        };
        const head = await mirrorMain(mirrorDir);
        if (norm(parentVersion) === norm(head)) {
          const version = await fetchBundleAdvance(mirrorDir, bundleBytes);
          return { accepted: true, version };
        }
        return {
          accepted: false,
          actualParent: head,
          reason: 'parent-mismatch',
        };
      }
      if (action === 'tool.execute-host') {
        const found =
          (
            await git([
              '-C',
              mirrorDir,
              'cat-file',
              '-e',
              'refs/heads/main:.ax/scratch/foo.txt',
            ])
          ).code === 0;
        return { output: { found } };
      }
      throw new Error(`unexpected IPC action: ${action}`);
    },
    callGet: async () => {
      throw new Error('callGet not expected');
    },
    callBinary: async (action: string, payload: unknown) => {
      // The re-sync path fetches the baseline bundle out-of-band as a binary
      // octet-stream (NOT inline in the commit-notify JSON response). Stream the
      // mirror's main bundle to a temp file and hand back its path, exactly as
      // the real host-side workspace.export-baseline-bundle handler does.
      if (action === 'workspace.export-baseline-bundle') {
        const { version } = payload as { version: string };
        expect(version).toBe(await mirrorMain(mirrorDir));
        return bundleMirrorMainToFile(mirrorDir);
      }
      throw new Error(`unexpected binary IPC action: ${action}`);
    },
    event: async () => {
      throw new Error('event not expected');
    },
    close: async () => {
      /* no-op */
    },
  };
}

const SCRATCH_BODY = 'a file the agent just wrote this turn\n';

// TASK-123 / TASK-5 / #146 load class: each test in this suite sequentially
// spawns ~25–30 real `git` subprocesses (setup + flush + host-retire + resync +
// verify). Under the full `pnpm -r test` fan-out (every package's vitest pool +
// sibling testcontainer suites all competing for CPU), git process startup
// latency balloons ~10×, breaching vitest's default 5000 ms per-test budget and
// flaking the push-to-main backstop — even though the bodies run in ~0.5 s
// isolated. Give the real-git e2e tests a 30 s budget, matching every other
// real-git package (workspace-git*, ipc-core). Applied per-`it()` (not a
// package-wide vitest.config override) so the package's ~28 fast unit test files
// keep the tight 5 s early-hang signal (cf. sandbox-k8s keeping testTimeout: 5_000).
const E2E_TIMEOUT_MS = 30_000;

const FLUSH_TOOL = {
  name: 'host_reads_workspace',
  description: 'a host tool that reads files the agent just wrote',
  inputSchema: { type: 'object' as const },
  executesIn: 'host' as const,
  flushWorkspaceBeforeCall: true,
};

type ToolEntry = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

function hostFound(result: unknown): boolean {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? '';
  return (JSON.parse(text) as { found?: boolean }).found === true;
}

describe('flushWorkspaceBeforeCall host tool (BUG-W2 real path)', () => {
  it('WITHOUT the flush, the host read of the mirror misses the live file (the bug)', async () => {
    const { runnerRoot, mirrorDir } = await setupWorkspace();
    // Agent writes the file into the live tree, uncommitted (mid-turn write).
    await fs.mkdir(path.join(runnerRoot, '.ax', 'scratch'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.ax', 'scratch', 'foo.txt'), SCRATCH_BODY);

    const client = makeHostClient(mirrorDir);
    // No flushWorkspace wired — the pre-fix behavior. The forward goes straight
    // to the host, which reads the stale mirror.
    const entries = buildHostToolEntries(client, [FLUSH_TOOL], () => 'id-1');
    const result = await (entries[0] as ToolEntry).handler({ path: 'foo.txt' }, {});

    expect(hostFound(result)).toBe(false);
  }, E2E_TIMEOUT_MS);

  it('WITH the pre-forward flush, the host read finds the just-written file (the fix)', async () => {
    const { runnerRoot, mirrorDir, baselineOid } = await setupWorkspace();
    await fs.mkdir(path.join(runnerRoot, '.ax', 'scratch'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.ax', 'scratch', 'foo.txt'), SCRATCH_BODY);

    const client = makeHostClient(mirrorDir);
    let parentVersion: string | null = baselineOid;
    const flushWorkspace = async () => {
      const r = await flushWorkspaceToHost({
        client,
        root: runnerRoot,
        parentVersion,
        reason: 'turn',
      });
      parentVersion = r.parentVersion;
      return r.outcome;
    };
    const entries = buildHostToolEntries(client, [FLUSH_TOOL], () => 'id-1', flushWorkspace);
    const result = await (entries[0] as ToolEntry).handler({ path: 'foo.txt' }, {});

    expect(hostFound(result)).toBe(true);
    // The flush advanced the chained version off the baseline (so the turn-end
    // commit chains from the pushed state, not the stale baseline).
    expect(parentVersion).not.toBeNull();
    expect(parentVersion).not.toBe(baselineOid);
  }, E2E_TIMEOUT_MS);

  // Codex review SHOULD-FIX: a host-side delete (e.g. workspace:apply after the
  // tool runs) must not be undone by the next runner commit, and must not wedge
  // the turn. Exercises the full real-git sequence:
  // flush -> host delete -> next runner turn commit -> concurrent-writer resync.
  it('host-side delete after the flush sticks and the next runner commit resyncs cleanly', async () => {
    const { runnerRoot, mirrorDir, baselineOid } = await setupWorkspace();
    await fs.mkdir(path.join(runnerRoot, '.ax', 'scratch'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.ax', 'scratch', 'foo.txt'), SCRATCH_BODY);

    const client = makeHostClient(mirrorDir);
    let parentVersion: string | null = baselineOid;
    const flushWorkspace = async () => {
      const r = await flushWorkspaceToHost({ client, root: runnerRoot, parentVersion, reason: 'turn' });
      parentVersion = r.parentVersion;
      return r.outcome;
    };
    const entries = buildHostToolEntries(client, [FLUSH_TOOL], () => 'id-1', flushWorkspace);

    // 1. Write + read: flush pushes the file, host reads it.
    const r1 = await (entries[0] as ToolEntry).handler({ path: 'foo.txt' }, {});
    expect(hostFound(r1)).toBe(true);

    // 2. Host deletes the file on the mirror (advances the mirror head).
    await hostRetire(mirrorDir, '.ax/scratch/foo.txt');

    // 3. Next runner turn writes a normal file (disjoint path) and commits.
    //    The runner's baseline is the pre-retire tip, so commit-notify hits a
    //    concurrent-writer mismatch and must resync onto the retire commit.
    await fs.mkdir(path.join(runnerRoot, '.claude', 'projects'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.claude', 'projects', 'sess.jsonl'), '{"turn":1}\n');
    const bundle = await commitTurnAndBundle({ root: runnerRoot, reason: 'turn' });
    expect(bundle).not.toBeNull();
    const res = await commitNotifyWithResync({
      client,
      root: runnerRoot,
      bundleBytes: bundle!,
      parentVersion,
      reason: 'turn',
    });
    // No wedge: the resync rebased the turn onto the retire commit and landed.
    expect(res.outcome).toBe('accepted');

    // 4a. Delete stuck: the file is gone from the mirror...
    const fileInMirror =
      (await git(['-C', mirrorDir, 'cat-file', '-e', 'refs/heads/main:.ax/scratch/foo.txt'])).code === 0;
    expect(fileInMirror).toBe(false);
    // 4b. ...the turn's file survived...
    const jsonlInMirror =
      (await git(['-C', mirrorDir, 'cat-file', '-e', 'refs/heads/main:.claude/projects/sess.jsonl'])).code === 0;
    expect(jsonlInMirror).toBe(true);
    // 4c. ...and the runner's live tree no longer carries the deleted file.
    const fileInRunnerTree = await fs
      .access(path.join(runnerRoot, '.ax', 'scratch', 'foo.txt'))
      .then(() => true, () => false);
    expect(fileInRunnerTree).toBe(false);
  }, E2E_TIMEOUT_MS);
});

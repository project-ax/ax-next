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

function gitOnce(args: readonly string[], cwd?: string): Promise<GitResult> {
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

// ---------------------------------------------------------------------------
// TASK-137 — de-flake the BUG-W2 resync assertion.
//
// This file's helper mock (`makeHostClient`) runs REAL git subprocesses INSIDE
// its IPC handlers (commit-notify → rev-parse + fetch; export-baseline-bundle →
// bundle create), and the assertions run git too (cat-file -e). Under the full
// push-to-main suite's multi-package + testcontainer starvation, a single git
// fork can transiently fail — spawn EAGAIN ("Resource temporarily unavailable"
// / "cannot fork"), or a starved ref/index lock ("Unable to create
// '.../index.lock'" / "cannot lock ref"). Production `commitNotifyWithResync`
// then CORRECTLY degrades that one hiccup to `kept`/`rolled-back`, and the test's
// `expect(outcome).toBe('accepted')` reds — an assertion flake, not a timeout.
//
// The git LOGIC is deterministic; only the subprocess scheduling under
// starvation is not. So we make the TEST's git invocations settle: retry ONLY
// genuine transient INFRASTRUCTURE failures to completion, never a legitimate
// non-zero exit a caller interprets via `.code` (e.g. `cat-file -e` → 1 means
// "absent"; `diff --cached --quiet` → 1 means "dirty"). A real result is
// returned on the first non-transient close.
// ---------------------------------------------------------------------------

const GIT_RETRY_ATTEMPTS = 5;
const GIT_RETRY_BACKOFF_MS = 10;

// Transient infrastructure failure signatures (NOT a meaningful `.code`):
// fork/spawn exhaustion and ref/index lock contention under load. A non-zero
// exit whose stderr matches one of these is the starved-infra class we retry.
const TRANSIENT_GIT_STDERR =
  /resource temporarily unavailable|cannot fork|unable to fork|unable to create '[^']*\.lock'|cannot lock ref|index\.lock|file exists.*\.lock/i;

function isTransientSpawnError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  // EAGAIN: fork()/posix_spawn ran out of process slots under starvation.
  // ENOMEM: out of memory mid-spawn. Both are retryable infra hiccups, not a
  // wrong git invocation.
  return code === 'EAGAIN' || code === 'ENOMEM';
}

type GitRunner = (args: readonly string[], cwd?: string) => Promise<GitResult>;

/**
 * Bounded retry around a single git invocation. The public `git` (below) pins
 * `gitOnce` as the runner; the injectable `runner` param exists so the
 * regression test can feed a controlled transient-then-success sequence and
 * prove the seam deterministically (no flaky real-git lock race).
 */
async function gitWithRetry(
  runner: GitRunner,
  args: readonly string[],
  cwd?: string,
): Promise<GitResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < GIT_RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await runner(args, cwd);
      // A clean exit, or a non-zero exit that is NOT a transient-infra
      // signature, is an authoritative result — return it as-is so callers
      // keep interpreting `.code` (e.g. cat-file -e absent → 1).
      if (r.code === 0 || !TRANSIENT_GIT_STDERR.test(r.stderr)) return r;
      lastErr = new Error(`transient git failure (code=${r.code}): ${r.stderr}`);
    } catch (err) {
      // A spawn 'error' (fork failed). Retry only the transient-infra class;
      // a genuinely broken invocation (e.g. ENOENT for git) rethrows below.
      if (!isTransientSpawnError(err)) throw err;
      lastErr = err;
    }
    // Settle: brief backoff, then re-attempt the same git op to completion.
    await new Promise((res) => setTimeout(res, GIT_RETRY_BACKOFF_MS * (attempt + 1)));
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`git failed after ${GIT_RETRY_ATTEMPTS} attempts: ${String(lastErr)}`);
}

function git(args: readonly string[], cwd?: string): Promise<GitResult> {
  return gitWithRetry(gitOnce, args, cwd);
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

// ---------------------------------------------------------------------------
// TASK-137 regression — the BUG-W2 resync assertion above flaked NOT because the
// git logic is racy (it is deterministic) but because the test's `makeHostClient`
// mock runs REAL git subprocesses inside its IPC handlers, and under the full
// push-to-main suite's starvation a single git fork could transiently fail (spawn
// EAGAIN / ref-lock contention). Production `commitNotifyWithResync` then
// correctly degraded that hiccup to `kept`/`rolled-back`, and `expect(outcome)
// .toBe('accepted')` red. These tests pin the `gitWithRetry` settle seam that
// fixes it: a transient infra failure is retried to completion, so the resync
// still lands `accepted`; a legitimate non-zero exit is NOT retried.
// ---------------------------------------------------------------------------
describe('TASK-137 — gitWithRetry settle seam (transient-git resilience)', () => {
  const transient = (msg: string): GitResult => ({ code: 128, stdout: '', stderr: msg });
  const okResult = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });

  it('retries a transient ref/index-lock failure to a clean success', async () => {
    let calls = 0;
    const runner: GitRunner = async () => {
      calls++;
      // First two attempts hit a starved lock; the third succeeds.
      if (calls < 3) return transient(`fatal: Unable to create '/x/.git/index.lock': File exists`);
      return okResult('deadbeef\n');
    };
    const r = await gitWithRetry(runner, ['-C', '/x', 'rev-parse', 'HEAD']);
    expect(calls).toBe(3);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('deadbeef\n');
  });

  it('retries a spawn EAGAIN (fork failed) to success', async () => {
    let calls = 0;
    const runner: GitRunner = async () => {
      calls++;
      if (calls < 2) {
        const err = new Error('spawn git EAGAIN') as NodeJS.ErrnoException;
        err.code = 'EAGAIN';
        throw err;
      }
      return okResult('ok\n');
    };
    const r = await gitWithRetry(runner, ['status']);
    expect(calls).toBe(2);
    expect(r.code).toBe(0);
  });

  it('does NOT retry a legitimate non-zero exit (e.g. cat-file -e absent → 1)', async () => {
    let calls = 0;
    const runner: GitRunner = async () => {
      calls++;
      // `git cat-file -e <missing>` exits 1 with empty/non-transient stderr —
      // that is the authoritative "absent" answer, not an infra hiccup.
      return { code: 1, stdout: '', stderr: '' };
    };
    const r = await gitWithRetry(runner, ['cat-file', '-e', 'main:nope']);
    expect(calls).toBe(1);
    expect(r.code).toBe(1);
  });

  it('rethrows a non-transient spawn error without retrying (e.g. git not found)', async () => {
    let calls = 0;
    const runner: GitRunner = async () => {
      calls++;
      const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    await expect(gitWithRetry(runner, ['version'])).rejects.toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });

  it('gives up after the bounded attempt budget on a persistent transient failure', async () => {
    let calls = 0;
    const runner: GitRunner = async () => {
      calls++;
      return transient('fatal: cannot fork: Resource temporarily unavailable');
    };
    await expect(gitWithRetry(runner, ['gc'])).rejects.toThrow(/transient git failure/);
    expect(calls).toBe(GIT_RETRY_ATTEMPTS);
  });

  // The integration proof: drive the FULL host-delete → flush → runner-commit →
  // resync sequence through a host client whose commit-notify git ops transiently
  // fail on their first attempt. WITHOUT the seam, the first failed `mirrorMain`
  // rev-parse (null head) makes the mock omit `actualParent` → resync can't engage
  // → `rolled-back`; or a thrown fetch → `kept`. WITH the seam, the transient
  // failure is retried to completion and the resync lands `accepted`.
  it('the BUG-W2 resync still lands accepted when commit-notify git transiently fails first try', async () => {
    const { runnerRoot, mirrorDir, baselineOid } = await setupWorkspace();
    await fs.mkdir(path.join(runnerRoot, '.ax', 'scratch'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.ax', 'scratch', 'foo.txt'), SCRATCH_BODY);

    // A git runner that injects ONE transient lock failure on the first invocation
    // of each distinct git verb, then delegates to the real spawn. This mimics a
    // starvation hiccup hitting whichever git op happens to run first.
    const seenVerb = new Set<string>();
    const flakyRunner: GitRunner = async (args, cwd) => {
      const verb = args[args.indexOf('-C') >= 0 ? args.indexOf('-C') + 2 : 0] ?? '';
      if (!seenVerb.has(verb)) {
        seenVerb.add(verb);
        return { code: 128, stdout: '', stderr: `fatal: Unable to create '${cwd}/.git/index.lock': File exists` };
      }
      return gitOnce(args, cwd);
    };
    const flakyGit: GitRunner = (args, cwd) => gitWithRetry(flakyRunner, args, cwd);

    // Same shape as makeHostClient, but its internal git goes through flakyGit so
    // the seam is exercised on the commit-notify path that flaked.
    const norm = (h: string | null | undefined): string | null => (h && h.length ? h : null);
    const flakyMirrorMain = async (): Promise<string | null> => {
      const r = await flakyGit(['-C', mirrorDir, 'rev-parse', '--quiet', '--verify', 'refs/heads/main']);
      return r.code === 0 && r.stdout.trim().length > 0 ? r.stdout.trim() : null;
    };
    const client: IpcClient = {
      call: async (action: string, payload: unknown) => {
        if (action === 'workspace.commit-notify') {
          const { parentVersion, bundleBytes } = payload as { parentVersion: string | null; bundleBytes: string };
          const head = await flakyMirrorMain();
          if (norm(parentVersion) === norm(head)) {
            const bundleFile = path.join(scratch, `in-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
            await fs.writeFile(bundleFile, Buffer.from(bundleBytes, 'base64'));
            try {
              await expectOk(
                await flakyGit(['-C', mirrorDir, 'fetch', bundleFile, '+refs/heads/main:refs/heads/main']),
                'mirror fetch bundle',
              );
              return { accepted: true, version: (await flakyMirrorMain())! };
            } finally {
              await fs.rm(bundleFile, { force: true });
            }
          }
          return { accepted: false, actualParent: head, reason: 'parent-mismatch' };
        }
        if (action === 'tool.execute-host') {
          const found = (await flakyGit(['-C', mirrorDir, 'cat-file', '-e', 'refs/heads/main:.ax/scratch/foo.txt'])).code === 0;
          return { output: { found } };
        }
        throw new Error(`unexpected IPC action: ${action}`);
      },
      callGet: async () => {
        throw new Error('callGet not expected');
      },
      callBinary: async (action: string, payload: unknown) => {
        if (action === 'workspace.export-baseline-bundle') {
          const { version } = payload as { version: string };
          expect(version).toBe(await flakyMirrorMain());
          const f = path.join(tmpdir(), `ax-e2e-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
          await expectOk(await flakyGit(['-C', mirrorDir, 'bundle', 'create', f, 'main']), 'mirror bundle main');
          const stat = await fs.stat(f);
          return { path: f, bytes: stat.size };
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

    let parentVersion: string | null = baselineOid;
    const flushWorkspace = async () => {
      const r = await flushWorkspaceToHost({ client, root: runnerRoot, parentVersion, reason: 'turn' });
      parentVersion = r.parentVersion;
      return r.outcome;
    };
    const entries = buildHostToolEntries(client, [FLUSH_TOOL], () => 'id-1', flushWorkspace);

    const r1 = await (entries[0] as ToolEntry).handler({ path: 'foo.txt' }, {});
    expect(hostFound(r1)).toBe(true);

    await hostRetire(mirrorDir, '.ax/scratch/foo.txt');

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
    // The transient git failures were retried to completion — the resync landed.
    expect(res.outcome).toBe('accepted');
    const fileInMirror =
      (await git(['-C', mirrorDir, 'cat-file', '-e', 'refs/heads/main:.ax/scratch/foo.txt'])).code === 0;
    expect(fileInMirror).toBe(false);
    const jsonlInMirror =
      (await git(['-C', mirrorDir, 'cat-file', '-e', 'refs/heads/main:.claude/projects/sess.jsonl'])).code === 0;
    expect(jsonlInMirror).toBe(true);
  }, E2E_TIMEOUT_MS);
});

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
// BUG-W2 real-path regression: install_authored_skill returns
// "authored-skill-not-found" because the host reads the committed + pushed
// workspace mirror, which lags the runner's live tree until a turn-boundary
// commit — and the agent writes .ax/skills/<id>/SKILL.md and calls the tool in
// the SAME turn.
//
// The existing host-side canaries MOCK workspace:list/read, so the
// committed-vs-live divergence never appears and the bug slips through. This
// test uses a REAL git workspace (runner side) AND a REAL bare mirror (host
// side), wired through the REAL host-tool forwarder + flush helper, so the
// divergence is genuine:
//
//   - write .ax/skills/foo/SKILL.md to the runner's live tree (uncommitted)
//   - WITHOUT the flush, the host read of the mirror finds nothing (the bug)
//   - WITH the pre-forward flush, the runner commits + pushes the live tree to
//     the mirror first, so the host read finds the just-authored file (the fix)
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
async function bundleMirrorMain(mirrorDir: string): Promise<string> {
  const f = path.join(scratch, `base-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
  await expectOk(await git(['-C', mirrorDir, 'bundle', 'create', f, 'main']), 'mirror bundle main');
  try {
    return (await fs.readFile(f)).toString('base64');
  } finally {
    await fs.rm(f, { force: true });
  }
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
 * concurrent-writer envelope (`accepted:false` + `actualParent` +
 * `baselineBundleBytes`) so the runner's resync path engages. `tool.execute-host`
 * for install_authored_skill reads the mirror for the authored file. No mocking
 * of the workspace layer — both sides are real git.
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
          baselineBundleBytes: await bundleMirrorMain(mirrorDir),
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
              'refs/heads/main:.ax/skills/foo/SKILL.md',
            ])
          ).code === 0;
        return { output: { found } };
      }
      throw new Error(`unexpected IPC action: ${action}`);
    },
    callGet: async () => {
      throw new Error('callGet not expected');
    },
    callBinary: async () => {
      throw new Error('callBinary not expected');
    },
    event: async () => {
      throw new Error('event not expected');
    },
    close: async () => {
      /* no-op */
    },
  };
}

const SKILL_MD = '---\nname: foo\ndescription: a foo skill\n---\n\nDo foo things.\n';

const INSTALL_TOOL = {
  name: 'install_authored_skill',
  description: 'install an authored skill',
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

describe('install_authored_skill flush (BUG-W2 real path)', () => {
  it('WITHOUT the flush, the host read of the mirror misses the live file (the bug)', async () => {
    const { runnerRoot, mirrorDir } = await setupWorkspace();
    // Agent authors the skill into the live tree, uncommitted (mid-turn write).
    await fs.mkdir(path.join(runnerRoot, '.ax', 'skills', 'foo'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.ax', 'skills', 'foo', 'SKILL.md'), SKILL_MD);

    const client = makeHostClient(mirrorDir);
    // No flushWorkspace wired — the pre-fix behavior. The forward goes straight
    // to the host, which reads the stale mirror.
    const entries = buildHostToolEntries(client, [INSTALL_TOOL], () => 'id-1');
    const result = await (entries[0] as ToolEntry).handler({ skillId: 'foo' }, {});

    expect(hostFound(result)).toBe(false);
  });

  it('WITH the pre-forward flush, the host read finds the just-authored file (the fix)', async () => {
    const { runnerRoot, mirrorDir, baselineOid } = await setupWorkspace();
    await fs.mkdir(path.join(runnerRoot, '.ax', 'skills', 'foo'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.ax', 'skills', 'foo', 'SKILL.md'), SKILL_MD);

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
    const entries = buildHostToolEntries(client, [INSTALL_TOOL], () => 'id-1', flushWorkspace);
    const result = await (entries[0] as ToolEntry).handler({ skillId: 'foo' }, {});

    expect(hostFound(result)).toBe(true);
    // The flush advanced the chained version off the baseline (so the turn-end
    // commit chains from the pushed state, not the stale baseline).
    expect(parentVersion).not.toBeNull();
    expect(parentVersion).not.toBe(baselineOid);
  });

  // Codex review SHOULD-FIX: the host-side retire (delete the draft via
  // workspace:apply after upsert) must not be undone by the next runner commit,
  // and must not wedge the turn. Exercises the full real-git sequence:
  // flush -> host retire -> next runner turn commit -> concurrent-writer resync.
  it('host-side retire after the flush sticks and the next runner commit resyncs cleanly', async () => {
    const { runnerRoot, mirrorDir, baselineOid } = await setupWorkspace();
    await fs.mkdir(path.join(runnerRoot, '.ax', 'skills', 'foo'), { recursive: true });
    await fs.writeFile(path.join(runnerRoot, '.ax', 'skills', 'foo', 'SKILL.md'), SKILL_MD);

    const client = makeHostClient(mirrorDir);
    let parentVersion: string | null = baselineOid;
    const flushWorkspace = async () => {
      const r = await flushWorkspaceToHost({ client, root: runnerRoot, parentVersion, reason: 'turn' });
      parentVersion = r.parentVersion;
      return r.outcome;
    };
    const entries = buildHostToolEntries(client, [INSTALL_TOOL], () => 'id-1', flushWorkspace);

    // 1. Author + install: flush pushes the draft, host reads it.
    const r1 = await (entries[0] as ToolEntry).handler({ skillId: 'foo' }, {});
    expect(hostFound(r1)).toBe(true);

    // 2. Host retires the draft on the mirror (advances the mirror head).
    await hostRetire(mirrorDir, '.ax/skills/foo/SKILL.md');

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

    // 4a. Retire stuck: the draft is gone from the mirror...
    const skillInMirror =
      (await git(['-C', mirrorDir, 'cat-file', '-e', 'refs/heads/main:.ax/skills/foo/SKILL.md'])).code === 0;
    expect(skillInMirror).toBe(false);
    // 4b. ...the turn's file survived...
    const jsonlInMirror =
      (await git(['-C', mirrorDir, 'cat-file', '-e', 'refs/heads/main:.claude/projects/sess.jsonl'])).code === 0;
    expect(jsonlInMirror).toBe(true);
    // 4c. ...and the runner's live tree no longer carries the retired draft.
    const skillInRunnerTree = await fs
      .access(path.join(runnerRoot, '.ax', 'skills', 'foo', 'SKILL.md'))
      .then(() => true, () => false);
    expect(skillInRunnerTree).toBe(false);
  });
});

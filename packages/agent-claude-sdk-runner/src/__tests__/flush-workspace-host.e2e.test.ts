import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { IpcClient } from '@ax/ipc-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHostToolEntries } from '../host-mcp-server.js';
import { flushWorkspaceToHost } from '../commit-notify-resync.js';

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

/** Apply a base64 thin bundle to the bare mirror (the host's commit-notify). */
async function applyBundleToMirror(
  mirrorDir: string,
  bundleB64: string,
): Promise<string> {
  const bundleFile = path.join(scratch, `in-${Date.now()}.bundle`);
  await fs.writeFile(bundleFile, Buffer.from(bundleB64, 'base64'));
  try {
    await expectOk(
      await git(['-C', mirrorDir, 'fetch', bundleFile, '+refs/heads/main:refs/heads/main']),
      'mirror fetch bundle',
    );
    const head = await git(['-C', mirrorDir, 'rev-parse', 'refs/heads/main']);
    await expectOk(head, 'mirror rev-parse main');
    return head.stdout.trim();
  } finally {
    await fs.rm(bundleFile, { force: true });
  }
}

/**
 * A real-git IpcClient stand-in: `workspace.commit-notify` applies the thin
 * bundle to the bare mirror (what the host does); `tool.execute-host` for
 * install_authored_skill reads the just-pushed mirror for the authored file
 * (what readAuthoredBundle ultimately resolves to over the git-protocol
 * backend). No mocking of the workspace layer — both sides are real git.
 */
function makeHostClient(mirrorDir: string): IpcClient {
  return {
    call: async (action: string, payload: unknown) => {
      if (action === 'workspace.commit-notify') {
        const { bundleBytes } = payload as { bundleBytes: string };
        const version = await applyBundleToMirror(mirrorDir, bundleBytes);
        return { accepted: true, version };
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
    const flushWorkspace = async (): Promise<void> => {
      const r = await flushWorkspaceToHost({
        client,
        root: runnerRoot,
        parentVersion,
        reason: 'turn',
      });
      parentVersion = r.parentVersion;
    };
    const entries = buildHostToolEntries(client, [INSTALL_TOOL], () => 'id-1', flushWorkspace);
    const result = await (entries[0] as ToolEntry).handler({ skillId: 'foo' }, {});

    expect(hostFound(result)).toBe(true);
    // The flush advanced the chained version off the baseline (so the turn-end
    // commit chains from the pushed state, not the stale baseline).
    expect(parentVersion).not.toBeNull();
    expect(parentVersion).not.toBe(baselineOid);
  });
});

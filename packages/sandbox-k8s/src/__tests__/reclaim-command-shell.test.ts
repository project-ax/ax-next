import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCleanupCommand } from '../user-files-ops.js';

// ---------------------------------------------------------------------------
// TASK-718 — the reclaim pod's SCRIPT, run through a real POSIX shell against a
// real directory tree.
//
// Why this exists. The prod walk (TASK-346 W8) deleted one agent and found the
// reclaim pod exiting 1 with the agent's `/user-files/<agentId>/` directory
// left behind, empty. Every test that existed for `cleanupUserFiles` checked
// the pod MANIFEST (labels, env, security context) and the exit-code handling
// with a stubbed pod. None of them ran a line of the script, so nothing could
// notice that the script did not do what its name says.
//
// Two things a shell test cannot prove, stated plainly so nobody reads more
// into a green run than is in it:
//   1. It cannot prove the pod is ALLOWED to unlink an entry from the
//      root-owned export root. That is a property of the pod's uid and
//      capabilities, which `user-files-ops.test.ts` pins on the manifest and
//      which was measured with the prod image (see the PR).
//   2. Run as a normal user, the parent-not-writable case below is the SAME
//      failure the prod pod hit (EACCES on the final unlink), not the fix.
//
// The script hard-codes `/export`, which we cannot create on a dev machine, so
// the mount path is textually rewritten to a temp dir. That is the ONLY edit.
// ---------------------------------------------------------------------------

const EXPORT_MOUNT = '/export';
const SUBPATH = 'agt_Reclaim1';
const SHELLS = ['/bin/sh'];
if (spawnSync('/bin/dash', ['-c', ':']).status === 0) SHELLS.push('/bin/dash');

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let root: string;
let shimDir: string;

beforeEach(async () => {
  // realpath: macOS hands out /var/... which is a symlink to /private/var.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-reclaim-')));
  shimDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-reclaim-shim-')));
  // The script sleeps between attempts. A shim keeps the suite fast; the retry
  // COUNT is what the tests assert, not the wall clock.
  await writeShim('sleep', 'exit 0');
});

afterEach(async () => {
  // A test may have left the export non-writable on purpose.
  await fs.chmod(root, 0o755).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(shimDir, { recursive: true, force: true }).catch(() => undefined);
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the shipped script with `/export` rewritten to `root`. */
function reclaim(
  env: Record<string, string | undefined>,
  options: { shell?: string } = {},
): RunResult {
  const script = buildCleanupCommand().split(EXPORT_MOUNT).join(root);
  const r = spawnSync(options.shell ?? '/bin/sh', ['-c', script], {
    env: {
      // shimDir first: `sleep` is always shimmed, `rm` only where a test writes one.
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)),
    } as Record<string, string>,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** A shim on PATH ahead of the real binary. */
async function writeShim(name: string, body: string): Promise<void> {
  const file = path.join(shimDir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Absolute path of the real `rm`, resolved before any shim is on PATH. */
function realRm(): string {
  const r = spawnSync('/bin/sh', ['-c', 'command -v rm'], { encoding: 'utf-8' });
  return r.stdout.trim();
}

describe.each(SHELLS)('the reclaim script, through a real shell (%s)', (shell) => {
  it('removes the agent subtree AND the directory entry itself, dotfiles included', async () => {
    const agentDir = path.join(root, SUBPATH);
    await fs.mkdir(path.join(agentDir, 'docs', 'nested'), { recursive: true });
    await fs.writeFile(path.join(agentDir, 'docs', 'nested', 'a.txt'), 'hi');
    await fs.writeFile(path.join(agentDir, '.hidden'), 'hi');

    const r = reclaim({ SUBPATH }, { shell });

    expect(r.code).toBe(0);
    // The prod pod removed the contents and left THIS behind.
    expect(await exists(agentDir)).toBe(false);
  });

  it('CROSS-TENANT: a sibling agent subtree is untouched', async () => {
    const mine = path.join(root, SUBPATH);
    const sibling = path.join(root, 'agt_Sibling');
    await fs.mkdir(mine, { recursive: true });
    await fs.mkdir(path.join(sibling, 'docs'), { recursive: true });
    await fs.writeFile(path.join(sibling, 'docs', 'keep.txt'), 'keep');

    const r = reclaim({ SUBPATH }, { shell });

    expect(r.code).toBe(0);
    expect(await exists(mine)).toBe(false);
    expect(await fs.readFile(path.join(sibling, 'docs', 'keep.txt'), 'utf-8')).toBe('keep');
  });

  it('CROSS-TENANT: a symlink planted inside the subtree is removed, never followed', async () => {
    /*
      The agent owns this tree and can plant `escape -> ../agt_Sibling`. `rm -rf`
      unlinks the link itself; the sibling's data must survive.
    */
    const mine = path.join(root, SUBPATH);
    const sibling = path.join(root, 'agt_Sibling');
    await fs.mkdir(mine, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'keep.txt'), 'keep');
    await fs.symlink(sibling, path.join(mine, 'escape'));

    const r = reclaim({ SUBPATH }, { shell });

    expect(r.code).toBe(0);
    expect(await exists(mine)).toBe(false);
    expect(await fs.readFile(path.join(sibling, 'keep.txt'), 'utf-8')).toBe('keep');
  });

  it('an agent that never wrote anything is a successful no-op', async () => {
    const r = reclaim({ SUBPATH: 'agt_NeverRan' }, { shell });
    expect(r.code).toBe(0);
  });

  it('REFUSES an empty SUBPATH and leaves every tenant alone', async () => {
    /*
      `rm -rf -- "/export/"` would empty the WHOLE export — every tenant. The host
      validates the segment before it builds the pod, so this is the second lock on
      the same door: a pod that somehow starts with `SUBPATH=` must do nothing.
    */
    const other = path.join(root, 'agt_Other');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'keep.txt'), 'keep');

    const r = reclaim({ SUBPATH: '' }, { shell });

    expect(r.code).not.toBe(0);
    expect(await fs.readFile(path.join(other, 'keep.txt'), 'utf-8')).toBe('keep');
  });

  it('REFUSES an unset SUBPATH and leaves every tenant alone', async () => {
    const other = path.join(root, 'agt_Other');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'keep.txt'), 'keep');

    const r = reclaim({}, { shell });

    expect(r.code).not.toBe(0);
    expect(await fs.readFile(path.join(other, 'keep.txt'), 'utf-8')).toBe('keep');
  });

  it.skipIf(IS_ROOT)(
    'REGRESSION (TASK-718): when the export root will not let us unlink the entry, it FAILS LOUDLY with the reason',
    async () => {
      /*
        This is the prod failure shape: the contents go, the final unlink of
        `/export/<agentId>` is refused because the export root is not writable by
        the pod's user. The original script printed rm's message and exited 1 with
        no context; the point of THIS assertion is that the directory is reported
        as still present, on stderr, so the pod's termination message (and so the
        operator's log line) names the path that was left behind.
      */
      const agentDir = path.join(root, SUBPATH);
      await fs.mkdir(path.join(agentDir, 'docs'), { recursive: true });
      await fs.writeFile(path.join(agentDir, 'docs', 'a.txt'), 'hi');
      await fs.chmod(root, 0o555);

      const r = reclaim({ SUBPATH }, { shell });

      expect(r.code).toBe(1);
      expect(await exists(agentDir)).toBe(true);
      expect(r.stderr).toContain(`${root}/${SUBPATH}`);
      expect(r.stderr).toMatch(/still exists|could not remove/);
    },
  );

  it('retries a racing writer: fails twice, succeeds on the third attempt', async () => {
    /*
      A warm runner can still be writing into its mount while the reclaim pod runs,
      and `rm -rf` then loses the race with "Directory not empty". The shim fails
      the first two calls; a script with no retry exits 1 on the first.
    */
    const agentDir = path.join(root, SUBPATH);
    await fs.mkdir(agentDir, { recursive: true });
    const counter = path.join(shimDir, 'count');
    await fs.writeFile(counter, '0');
    await writeShim(
      'rm',
      [
        `n=$(cat "${counter}")`,
        'n=$((n + 1))',
        `echo "$n" > "${counter}"`,
        'if [ "$n" -lt 3 ]; then echo "rm: cannot remove: Directory not empty" >&2; exit 1; fi',
        `exec "${realRm()}" "$@"`,
      ].join('\n'),
    );

    const r = reclaim({ SUBPATH }, { shell });

    expect(r.code).toBe(0);
    expect(await fs.readFile(counter, 'utf-8')).toBe('3\n');
    expect(await exists(agentDir)).toBe(false);
  });

  it('gives up after a bounded number of attempts and reports the path', async () => {
    const agentDir = path.join(root, SUBPATH);
    await fs.mkdir(agentDir, { recursive: true });
    const counter = path.join(shimDir, 'count');
    await fs.writeFile(counter, '0');
    await writeShim(
      'rm',
      [
        `n=$(cat "${counter}")`,
        `echo "$((n + 1))" > "${counter}"`,
        'echo "rm: cannot remove: Directory not empty" >&2',
        'exit 1',
      ].join('\n'),
    );

    const r = reclaim({ SUBPATH }, { shell });

    expect(r.code).toBe(1);
    expect(Number((await fs.readFile(counter, 'utf-8')).trim())).toBe(3);
    expect(r.stderr).toContain(`${root}/${SUBPATH}`);
  });

  it('a rm that reports success while the directory is still there is a FAILURE', async () => {
    /*
      The post-condition, independent of rm's exit status: the whole point of the
      card is that "the reclaim ran" and "the directory is gone" were two different
      facts. The shim exits 0 without removing anything.
    */
    const agentDir = path.join(root, SUBPATH);
    await fs.mkdir(agentDir, { recursive: true });
    await writeShim('rm', 'exit 0');

    const r = reclaim({ SUBPATH }, { shell });

    expect(r.code).toBe(1);
    expect(await exists(agentDir)).toBe(true);
    expect(r.stderr).toContain('still exists');
  });
});

// Regression: the bundle round-trip read path MUST NOT route object reads
// through isomorphic-git.
//
// isomorphic-git@1.37.5's FileSystem.read() adapter swallows EVERY read error
// — ENOENT, EAGAIN, EMFILE, partial reads — into `null`. Its loadPackIndex
// then does `new BufferCursor(idx).slice(4)` on that null, throwing the
// unhelpful "Cannot read properties of null (reading 'slice')". Under CI load
// (~59 packages' suites in parallel saturate fds/CPU) a transient `.idx` read
// returns null and the bundle-hooks round-trip test flakes ~1/4 (TASK-73).
//
// `readSnapshotAt` was already moved to real `git` for exactly this reason
// (impl.ts). This test pins the remaining object-read hot path —
// `workspace:read` and `workspace:list` — to the same guarantee: a transient
// `node:fs` read failure on the pack index does NOT break the hook, because
// the read happens in a real `git` child process (separate fd table), not via
// isomorphic-git's null-coalescing adapter.
//
// Mechanism: we inject a one-shot `EAGAIN` on the first `.idx` read seen by
// the PARENT process's `node:fs`. Before the fix, `workspace:read` /
// `workspace:list` call `git.readBlob` / `git.listFiles`, which read the
// `.idx` through this very `node:fs` → null → throw. After the fix they shell
// out to `git cat-file` / `git ls-tree`, whose reads happen in the child and
// are untouched by the parent-side fault → they succeed.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type HookBus,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { registerWorkspaceGitHooks } from '../impl.js';

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

function run(args: readonly string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const c = spawn('git', [...args], { env: ENV });
    c.once('error', reject);
    c.once('close', (code) => resolve(code));
  });
}

function forEachRef(bare: string, pattern: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(
      'git',
      ['-C', bare, 'for-each-ref', '--format=%(objectname)', pattern],
      { env: ENV },
    );
    let out = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.once('error', reject);
    c.once('close', () => resolve(out.trim()));
  });
}

/**
 * Build a bare repo whose committed objects live in a PACKFILE (not loose) —
 * the exact layout `workspace:apply-bundle` produces: seed a loose baseline,
 * then `git fetch` a bundle which lands the turn's objects as a pack. Returns
 * the bare gitdir and the HEAD commit oid.
 */
async function buildPackedBare(repoRoot: string): Promise<{ head: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-null-slice-src-'));
  try {
    const wt = join(scratch, 'wt');
    await run(['init', '-q', '-b', 'main', wt]);
    await run(['-C', wt, 'config', 'core.fileMode', 'false']);
    await fsp.writeFile(join(wt, 'test1.txt'), 'hello-permanent');
    await fsp.writeFile(join(wt, 'test2.txt'), 'hello-permanent-2');
    await run(['-C', wt, 'add', '-A']);
    await run(['-C', wt, 'commit', '-q', '-m', 'turn']);
    const bundlePath = join(scratch, 'turn.bundle');
    await run(['-C', wt, 'bundle', 'create', '-q', bundlePath, 'main']);

    const bare = join(repoRoot, 'repo.git');
    await run(['init', '-q', '--bare', '-b', 'main', bare]);
    // fetch the bundle: lands objects as a packfile under objects/pack/.
    await run([
      '-C',
      bare,
      'fetch',
      '-q',
      bundlePath,
      'refs/heads/*:refs/bundle/*',
    ]);
    const head = await forEachRef(bare, 'refs/bundle/');
    await run(['-C', bare, 'update-ref', 'refs/heads/main', head]);
    return { head };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('@ax/workspace-git-core null-slice race (TASK-73)', () => {
  let repoRoot: string;
  let h: TestHarness;
  let bus: HookBus;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-null-slice-'));
    await buildPackedBare(repoRoot);
    h = await createTestHarness({
      plugins: [
        {
          manifest: {
            name: '@ax/workspace-git-core-null-slice-shim',
            version: '0.0.0',
            registers: [
              'workspace:apply',
              'workspace:apply-internal',
              'workspace:read',
              'workspace:list',
              'workspace:diff',
            ],
            calls: [],
            subscribes: [],
          },
          init({ bus: b }) {
            registerWorkspaceGitHooks(b, { repoRoot });
          },
        },
      ],
    });
    bus = h.bus;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Inject a one-shot transient EAGAIN on the first `.idx` read the PARENT
  // process performs — the precise failure isomorphic-git's adapter swallows
  // to null. A read path that goes through iso-git throws the null-slice
  // TypeError; a path that shells out to real `git` is immune (child-process
  // reads use a separate fd table).
  function armIdxReadFault(): void {
    const realReadFile = nodeFs.promises.readFile.bind(nodeFs.promises);
    let tripped = false;
    vi.spyOn(nodeFs.promises, 'readFile').mockImplementation(
      (async (p: Parameters<typeof realReadFile>[0], ...rest: unknown[]) => {
        if (!tripped && typeof p === 'string' && p.endsWith('.idx')) {
          tripped = true;
          const e = new Error('EAGAIN: resource temporarily unavailable') as NodeJS.ErrnoException;
          e.code = 'EAGAIN';
          throw e;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return realReadFile(p, ...(rest as any));
      }) as typeof nodeFs.promises.readFile,
    );
  }

  it('workspace:read survives a transient .idx read fault (no null-slice)', async () => {
    armIdxReadFault();
    const read = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      h.ctx(),
      { path: 'test1.txt' },
    );
    expect(read).toMatchObject({
      found: true,
      bytes: new TextEncoder().encode('hello-permanent'),
    });
  });

  it('workspace:list survives a transient .idx read fault (no null-slice)', async () => {
    armIdxReadFault();
    const list = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
      'workspace:list',
      h.ctx(),
      {},
    );
    expect([...list.paths].sort()).toEqual(['test1.txt', 'test2.txt']);
  });
});

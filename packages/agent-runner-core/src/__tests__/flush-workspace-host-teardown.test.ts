import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmScratch } from './rm-scratch.js';

// ---------------------------------------------------------------------------
// TASK-145 — Harden flush-workspace-host.e2e teardown vs the ENOTEMPTY rmdir
// `mirror.git/info` race.
//
// The e2e suite stands up a REAL bare git mirror (`mirror.git`) under a per-test
// scratch dir and `fs.rm`s the whole tree in `afterEach`. Each test runs ~25-30
// real `git` subprocesses against that bare mirror. git's `gc.autoDetach`
// defaults to TRUE, so a push/fetch/receive-pack can spawn a `git gc --auto`
// that DETACHES into a background process and keeps writing into `mirror.git/`
// — including `info/` (`update-server-info` writes `info/refs`, gc packs refs)
// — AFTER the foreground git command the test awaited has already exited. When
// teardown's `fs.rm` walks the tree and `rmdir`s `mirror.git/info` while that
// detached writer is mid-write, the directory is momentarily non-empty →
// `ENOTEMPTY`.
//
// `fs.rm({ force: true })` does NOT retry ENOTEMPTY/EBUSY — `force` only
// suppresses "path does not exist". Only `maxRetries` + `retryDelay` enable
// Node's documented backoff-retry loop. `rmScratch` adds them.
//
// This is a HARNESS-ONLY race: production never `fs.rm`s a live workspace mirror
// (the host mirror lives in long-lived storage; the runner's commit-notify
// paths are all awaited, no fire-and-forget). So the fix is test-teardown only.
//
// This regression test reproduces the race mechanism WITHOUT git: a background
// writer churns files into an `info/` dir while we remove the tree. It proves
// the hardened `rmScratch` is throw-free across many trials under an active
// writer — the property the real teardown needs. It would have gone red against
// a teardown that lacks the retry options.
// ---------------------------------------------------------------------------

let roots: string[] = [];

afterEach(async () => {
  // Clean up any trees a trial left behind (force + retry so this teardown
  // itself can't flake on the same race).
  for (const r of roots) {
    await fs.rm(r, { recursive: true, force: true, maxRetries: 50, retryDelay: 5 }).catch(() => {});
  }
  roots = [];
});

/**
 * Stand up a scratch tree shaped like the e2e mirror dir: a `mirror.git/info`
 * subdir plus a spread of sibling files so the recursive walk takes long enough
 * for a concurrent writer to collide with the `info/` rmdir.
 */
async function makeMirrorishTree(): Promise<{ root: string; info: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ax-flush-e2e-teardown-'));
  roots.push(root);
  const info = path.join(root, 'mirror.git', 'info');
  await fs.mkdir(info, { recursive: true });
  for (let i = 0; i < 30; i++) {
    await fs.writeFile(path.join(root, 'mirror.git', `obj${i}`), 'x'.repeat(256));
  }
  await fs.writeFile(path.join(info, 'refs'), 'seed');
  return { root, info };
}

/**
 * Mimic the detached `git gc`/`update-server-info` that keeps writing into
 * `mirror.git/info` after the foreground git exits: churn files into `info/`
 * until told to stop (or the dir vanishes because the rm won the race).
 */
function startInfoChurn(info: string): { stop: () => void; done: Promise<void> } {
  let stop = false;
  const done = (async () => {
    let n = 0;
    while (!stop) {
      try {
        await fs.writeFile(path.join(info, `tmp_${n % 5}`), String(n));
        n++;
      } catch {
        // The dir was removed mid-write — the rm won this file's race. Stop.
        return;
      }
    }
  })();
  return {
    stop: () => {
      stop = true;
    },
    done,
  };
}

describe('TASK-145 — flush-e2e teardown survives the detached-git rmdir race', () => {
  // The load-bearing property: the hardened removal NEVER throws even while a
  // writer is actively churning `mirror.git/info`, across many trials. (The
  // unhardened `{recursive,force}` form throws ENOTEMPTY/EBUSY here intermittently
  // — that is the flake we are fixing — but asserting it ALWAYS throws would be
  // timing-dependent and itself flaky, so we assert only the property we need.)
  it('rmScratch removes a tree with an actively-written info/ dir without throwing', async () => {
    const TRIALS = 40;
    for (let t = 0; t < TRIALS; t++) {
      const { root, info } = await makeMirrorishTree();
      const churn = startInfoChurn(info);
      // Give the churn a head start so it's actively writing when rm reaches info/.
      await new Promise((r) => setTimeout(r, 3));
      // Must not throw, even under the concurrent writer.
      await rmScratch(root);
      churn.stop();
      await churn.done;
      // Tree is gone.
      const gone = await fs.access(root).then(
        () => false,
        () => true,
      );
      expect(gone).toBe(true);
    }
  }, 30_000);

  it('rmScratch is a no-op on a missing path (force semantics preserved)', async () => {
    const missing = path.join(tmpdir(), `ax-flush-e2e-teardown-missing-${Date.now()}`);
    await expect(rmScratch(missing)).resolves.toBeUndefined();
  });
});

import * as childProcess from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMirrorCache, type MirrorHandle } from '../mirror-cache.js';

// --------------------------------------------------------------------------
// Test scaffolding: each test gets its own cacheRoot so we don't pollute the
// global tmpdir and so we can verify on-disk presence/absence directly.
// --------------------------------------------------------------------------

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'ax-mirror-cache-test-'));
});

afterEach(() => {
  // Best-effort clean. Tests that exercise shutdown will already have removed
  // the dirs; this just ensures a leak in one test doesn't affect the next.
  rmSync(cacheRoot, { recursive: true, force: true });
});

function isBareRepo(dir: string): boolean {
  // `git init --bare` creates HEAD, config, refs/, objects/, hooks/, etc.
  return (
    existsSync(dir) &&
    statSync(dir).isDirectory() &&
    existsSync(join(dir, 'HEAD')) &&
    existsSync(join(dir, 'config')) &&
    existsSync(join(dir, 'refs')) &&
    existsSync(join(dir, 'objects'))
  );
}

// --------------------------------------------------------------------------
// 1. acquire creates a tempdir + git init --bare
// --------------------------------------------------------------------------

describe('mirror-cache — acquire creates a bare repo', () => {
  it('returns a handle whose dir contains the bare-repo layout', async () => {
    const cache = createMirrorCache({ cacheRoot });
    try {
      const handle = await cache.acquire('ws-aaaaaaaaaaaaaaaa');
      expect(handle.workspaceId).toBe('ws-aaaaaaaaaaaaaaaa');
      expect(typeof handle.dir).toBe('string');
      expect(handle.dir.length).toBeGreaterThan(0);
      expect(isBareRepo(handle.dir)).toBe(true);
    } finally {
      await cache.shutdown();
    }
  });
});

// --------------------------------------------------------------------------
// 2. Cache hit — second acquire for same workspaceId returns same handle
// --------------------------------------------------------------------------

describe('mirror-cache — cache hit returns same handle', () => {
  it('second acquire(id) returns identical handle (same dir)', async () => {
    const cache = createMirrorCache({ cacheRoot });
    try {
      const a = await cache.acquire('ws-bbbbbbbbbbbbbbbb');
      const b = await cache.acquire('ws-bbbbbbbbbbbbbbbb');
      expect(b.dir).toBe(a.dir);
      expect(b).toBe(a);
    } finally {
      await cache.shutdown();
    }
  });
});

// --------------------------------------------------------------------------
// 3. LRU eviction at default cacheMaxEntries: 64
// --------------------------------------------------------------------------

describe('mirror-cache — LRU eviction at default cap (64)', () => {
  it('the oldest entry is evicted from disk when we acquire entry 65', async () => {
    const cache = createMirrorCache({ cacheRoot });
    try {
      const handles: MirrorHandle[] = [];
      // Fill the cache with 64 entries (the cap).
      for (let i = 0; i < 64; i++) {
        const id = `ws-${i.toString().padStart(16, '0')}`;
        handles.push(await cache.acquire(id));
      }

      // All 64 should be on disk.
      for (const h of handles) {
        expect(isBareRepo(h.dir)).toBe(true);
      }

      // Acquire the 65th — this evicts the LRU (the very first).
      const overflow = await cache.acquire('ws-overflow00000o');
      expect(isBareRepo(overflow.dir)).toBe(true);

      // Entry 0's dir should be gone.
      expect(existsSync(handles[0]!.dir)).toBe(false);
      // Entries 1..63 should still exist.
      for (let i = 1; i < 64; i++) {
        expect(isBareRepo(handles[i]!.dir)).toBe(true);
      }

      // Re-acquiring the evicted id creates a fresh dir at a new path.
      const reAcquired = await cache.acquire(handles[0]!.workspaceId);
      expect(reAcquired.dir).not.toBe(handles[0]!.dir);
      expect(isBareRepo(reAcquired.dir)).toBe(true);
    } finally {
      await cache.shutdown();
    }
  });

  it('touching a cached entry bumps it to MRU so it survives eviction', async () => {
    // With cap 3: acquire A, B, C, then re-acquire A (bumps A to MRU),
    // then acquire D. The LRU is now B (since A was bumped).
    const cache = createMirrorCache({ cacheRoot, cacheMaxEntries: 3 });
    try {
      const a = await cache.acquire('ws-aaaaaaaaaaaaaaa1');
      const b = await cache.acquire('ws-bbbbbbbbbbbbbbb1');
      const c = await cache.acquire('ws-ccccccccccccccc1');
      // Touch A — makes it MRU.
      const aAgain = await cache.acquire('ws-aaaaaaaaaaaaaaa1');
      expect(aAgain).toBe(a);
      // Acquire D — evicts B (now LRU).
      const d = await cache.acquire('ws-ddddddddddddddd1');
      expect(isBareRepo(d.dir)).toBe(true);

      expect(isBareRepo(a.dir)).toBe(true);
      expect(existsSync(b.dir)).toBe(false);
      expect(isBareRepo(c.dir)).toBe(true);
    } finally {
      await cache.shutdown();
    }
  });
});

// --------------------------------------------------------------------------
// 4. shutdown removes all tempdirs
// --------------------------------------------------------------------------

describe('mirror-cache — shutdown removes all tempdirs', () => {
  it('after shutdown(), every previously-tracked dir is gone', async () => {
    const cache = createMirrorCache({ cacheRoot });
    const a = await cache.acquire('ws-shutdown00000a');
    const b = await cache.acquire('ws-shutdown00000b');
    const c = await cache.acquire('ws-shutdown00000c');

    expect(isBareRepo(a.dir)).toBe(true);
    expect(isBareRepo(b.dir)).toBe(true);
    expect(isBareRepo(c.dir)).toBe(true);

    await cache.shutdown();

    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(b.dir)).toBe(false);
    expect(existsSync(c.dir)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 5. Concurrency-safe acquire: 10 simultaneous acquire(id) → exactly ONE
//    git init --bare invocation, ONE mirror dir, all 10 promises resolve to
//    the same handle.
// --------------------------------------------------------------------------

describe('mirror-cache — concurrency-safe acquire', () => {
  it('10 simultaneous acquire(sameId) calls invoke git init exactly once', async () => {
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    try {
      const cache = createMirrorCache({ cacheRoot });
      try {
        const promises = Array.from({ length: 10 }, () =>
          cache.acquire('ws-concurrent00001'),
        );
        const handles = await Promise.all(promises);

        // All resolve to the same handle (and thus the same dir).
        for (let i = 1; i < handles.length; i++) {
          expect(handles[i]).toBe(handles[0]);
          expect(handles[i]!.dir).toBe(handles[0]!.dir);
        }

        // Count how many `git init` invocations happened. The spawn spy will
        // pick up every spawn call; filter to ones where args[0] is 'git' and
        // the first arg is 'init' (or args[1][0] === 'init' depending on shape).
        const initInvocations = spawnSpy.mock.calls.filter((call) => {
          const cmd = call[0];
          const args = call[1];
          return (
            cmd === 'git' &&
            Array.isArray(args) &&
            args[0] === 'init' &&
            args.includes('--bare')
          );
        });
        expect(initInvocations.length).toBe(1);

        // And the on-disk dir exists.
        expect(isBareRepo(handles[0]!.dir)).toBe(true);
      } finally {
        await cache.shutdown();
      }
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

// --------------------------------------------------------------------------
// 6. Custom cacheMaxEntries: 2 evicts after 3 distinct acquires
// --------------------------------------------------------------------------

describe('mirror-cache — custom cacheMaxEntries', () => {
  it('with cacheMaxEntries: 2, the third acquire evicts the LRU', async () => {
    const cache = createMirrorCache({ cacheRoot, cacheMaxEntries: 2 });
    try {
      const a = await cache.acquire('ws-cap2cap2cap2aaa');
      const b = await cache.acquire('ws-cap2cap2cap2bbb');
      expect(isBareRepo(a.dir)).toBe(true);
      expect(isBareRepo(b.dir)).toBe(true);

      const c = await cache.acquire('ws-cap2cap2cap2ccc');
      expect(isBareRepo(c.dir)).toBe(true);

      // A was LRU (oldest, never touched again) → evicted.
      expect(existsSync(a.dir)).toBe(false);
      expect(isBareRepo(b.dir)).toBe(true);
    } finally {
      await cache.shutdown();
    }
  });
});

// --------------------------------------------------------------------------
// 7. Re-acquire after eviction → fresh handle, new dir, git init re-invoked.
// --------------------------------------------------------------------------

describe('mirror-cache — re-acquire after eviction', () => {
  it('with cap 1, evicted id re-acquires to a NEW dir and git init runs again', async () => {
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    try {
      const cache = createMirrorCache({ cacheRoot, cacheMaxEntries: 1 });
      try {
        const a1 = await cache.acquire('ws-evict0000000a01');
        // Acquire B — evicts A.
        const b = await cache.acquire('ws-evict0000000b01');
        expect(existsSync(a1.dir)).toBe(false);
        expect(isBareRepo(b.dir)).toBe(true);

        // Re-acquire A — should be a fresh handle with a new dir.
        const a2 = await cache.acquire('ws-evict0000000a01');
        expect(a2.dir).not.toBe(a1.dir);
        expect(isBareRepo(a2.dir)).toBe(true);

        // Count git init --bare invocations. Should be 3: A1, B, A2.
        const initInvocations = spawnSpy.mock.calls.filter((call) => {
          const cmd = call[0];
          const args = call[1];
          return (
            cmd === 'git' &&
            Array.isArray(args) &&
            args[0] === 'init' &&
            args.includes('--bare')
          );
        });
        expect(initInvocations.length).toBe(3);
      } finally {
        await cache.shutdown();
      }
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

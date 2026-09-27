import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wrap node:child_process so we can count `git init --bare` invocations.
// `vi.spyOn` does not work on ESM module namespaces (Vitest limitation), so
// we use `vi.mock` with `importOriginal` to forward calls to the real
// implementation while letting us inspect them via `mockedSpawn.mock.calls`.
vi.mock('node:child_process', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

// Imported AFTER vi.mock so the cache's `spawn` reference is the wrapped one.
const { spawn: mockedSpawn } = await import('node:child_process');
const { createMirrorCache } = await import('../mirror-cache.js');
type MirrorHandle = import('../mirror-cache.js').MirrorHandle;
type MirrorCache = import('../mirror-cache.js').MirrorCache;

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

/**
 * Test-only convenience: run `withMirror(id, fn)` and return whatever the
 * passed-through fn returns. Most tests just want to snapshot the handle
 * (or its `dir`) for off-pin assertions — they're testing eviction state,
 * not in-pin behavior. The pin-respects-eviction test below is the
 * exception and uses `withMirror` directly to interleave operations.
 *
 * NOTE: post-release, the cache may evict the dir we just snapshotted.
 * That's the test's whole point; treating the dir as a reference only.
 */
async function snapshotHandle(
  cache: MirrorCache,
  workspaceId: string,
): Promise<MirrorHandle> {
  return cache.withMirror(workspaceId, async (handle) => handle);
}

// --------------------------------------------------------------------------
// 1. withMirror creates a tempdir + git init --bare
// --------------------------------------------------------------------------

describe('mirror-cache — withMirror creates a bare repo', () => {
  it('passes a handle whose dir contains the bare-repo layout', async () => {
    const cache = createMirrorCache({ cacheRoot });
    try {
      let snapshotDir = '';
      await cache.withMirror('ws-aaaaaaaaaaaaaaaa', async (handle) => {
        expect(handle.workspaceId).toBe('ws-aaaaaaaaaaaaaaaa');
        expect(typeof handle.dir).toBe('string');
        expect(handle.dir.length).toBeGreaterThan(0);
        // Verify the bare repo exists DURING the pin — that's the contract.
        expect(isBareRepo(handle.dir)).toBe(true);
        snapshotDir = handle.dir;
      });
      // Post-release the dir is still on disk (cap not reached, no eviction).
      expect(isBareRepo(snapshotDir)).toBe(true);
    } finally {
      await cache.shutdown();
    }
  });
});

// --------------------------------------------------------------------------
// 2. Cache hit — second call for same workspaceId reuses the same dir
// --------------------------------------------------------------------------

describe('mirror-cache — cache hit reuses the same dir', () => {
  it('second withMirror(id) sees the same handle.dir', async () => {
    const cache = createMirrorCache({ cacheRoot });
    try {
      const a = await snapshotHandle(cache, 'ws-bbbbbbbbbbbbbbbb');
      const b = await snapshotHandle(cache, 'ws-bbbbbbbbbbbbbbbb');
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
        handles.push(await snapshotHandle(cache, id));
      }

      // All 64 should be on disk.
      for (const h of handles) {
        expect(isBareRepo(h.dir)).toBe(true);
      }

      // Acquire the 65th — this evicts the LRU (the very first).
      const overflow = await snapshotHandle(cache, 'ws-overflow00000o');
      expect(isBareRepo(overflow.dir)).toBe(true);

      // Entry 0's dir should be gone.
      expect(existsSync(handles[0]!.dir)).toBe(false);
      // Entries 1..63 should still exist.
      for (let i = 1; i < 64; i++) {
        expect(isBareRepo(handles[i]!.dir)).toBe(true);
      }

      // Re-acquiring the evicted id creates a fresh dir at a new path.
      const reAcquired = await snapshotHandle(cache, handles[0]!.workspaceId);
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
      const a = await snapshotHandle(cache, 'ws-aaaaaaaaaaaaaaa1');
      const b = await snapshotHandle(cache, 'ws-bbbbbbbbbbbbbbb1');
      const c = await snapshotHandle(cache, 'ws-ccccccccccccccc1');
      // Touch A — makes it MRU.
      const aAgain = await snapshotHandle(cache, 'ws-aaaaaaaaaaaaaaa1');
      expect(aAgain).toBe(a);
      // Acquire D — evicts B (now LRU).
      const d = await snapshotHandle(cache, 'ws-ddddddddddddddd1');
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
    const a = await snapshotHandle(cache, 'ws-shutdown00000a');
    const b = await snapshotHandle(cache, 'ws-shutdown00000b');
    const c = await snapshotHandle(cache, 'ws-shutdown00000c');

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
// 5. Concurrency-safe withMirror: 10 simultaneous calls for the same id →
//    exactly ONE git init --bare invocation, ONE mirror dir, all 10 pins
//    share the same handle.
// --------------------------------------------------------------------------

describe('mirror-cache — concurrency-safe withMirror', () => {
  it('10 simultaneous withMirror(sameId) calls invoke git init exactly once', async () => {
    vi.mocked(mockedSpawn).mockClear();
    const cache = createMirrorCache({ cacheRoot });
    try {
      const promises = Array.from({ length: 10 }, () =>
        snapshotHandle(cache, 'ws-concurrent00001'),
      );
      const handles = await Promise.all(promises);

      // All resolve to the same handle (and thus the same dir).
      for (let i = 1; i < handles.length; i++) {
        expect(handles[i]).toBe(handles[0]);
        expect(handles[i]!.dir).toBe(handles[0]!.dir);
      }

      // Count how many `git init --bare` invocations happened. Filter to
      // calls where args[0] === 'git' and the args list begins with 'init'
      // and includes '--bare'.
      const initInvocations = vi.mocked(mockedSpawn).mock.calls.filter((call) => {
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
  });
});

// --------------------------------------------------------------------------
// 6. Custom cacheMaxEntries: 2 evicts after 3 distinct acquires
// --------------------------------------------------------------------------

describe('mirror-cache — custom cacheMaxEntries', () => {
  it('with cacheMaxEntries: 2, the third acquire evicts the LRU', async () => {
    const cache = createMirrorCache({ cacheRoot, cacheMaxEntries: 2 });
    try {
      const a = await snapshotHandle(cache, 'ws-cap2cap2cap2aaa');
      const b = await snapshotHandle(cache, 'ws-cap2cap2cap2bbb');
      expect(isBareRepo(a.dir)).toBe(true);
      expect(isBareRepo(b.dir)).toBe(true);

      const c = await snapshotHandle(cache, 'ws-cap2cap2cap2ccc');
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
    vi.mocked(mockedSpawn).mockClear();
    const cache = createMirrorCache({ cacheRoot, cacheMaxEntries: 1 });
    try {
      const a1 = await snapshotHandle(cache, 'ws-evict0000000a01');
      // Acquire B — evicts A.
      const b = await snapshotHandle(cache, 'ws-evict0000000b01');
      expect(existsSync(a1.dir)).toBe(false);
      expect(isBareRepo(b.dir)).toBe(true);

      // Re-acquire A — should be a fresh handle with a new dir.
      const a2 = await snapshotHandle(cache, 'ws-evict0000000a01');
      expect(a2.dir).not.toBe(a1.dir);
      expect(isBareRepo(a2.dir)).toBe(true);

      // Count git init --bare invocations. Should be 3: A1, B, A2.
      const initInvocations = vi.mocked(mockedSpawn).mock.calls.filter((call) => {
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
  });
});

// --------------------------------------------------------------------------
// 8. withMirror() after shutdown() rejects with a clear message.
// --------------------------------------------------------------------------

describe('mirror-cache — withMirror after shutdown rejects', () => {
  it('rejects with an Error whose message mentions shutdown', async () => {
    const cache = createMirrorCache({ cacheRoot });
    await cache.shutdown();
    await expect(
      cache.withMirror('ws-aaaaaaaaaaaaaaaa', async () => undefined),
    ).rejects.toThrow(/shutdown/i);
  });
});

// --------------------------------------------------------------------------
// 9. Pin protects an in-flight op from eviction by a concurrent acquire.
//    THIS IS THE REGRESSION TEST FOR THE PIN/RELEASE FIX. With cap=1, an
//    in-flight `withMirror(A)` + a simultaneous `withMirror(B)` would
//    previously have rm -rf'd A's mirror while A's body was still using it.
//    The fix: pinCount > 0 entries are skipped during eviction.
// --------------------------------------------------------------------------

describe('mirror-cache — pin protects in-flight op from eviction race', () => {
  it('cap=1: A is pinned while B is acquired; A.dir survives until A returns', async () => {
    const cache = createMirrorCache({ cacheRoot, cacheMaxEntries: 1 });
    try {
      // Manual gate: we hold A inside its withMirror body until B has
      // acquired and released. If pin protection works, A's dir is intact
      // for the entire interval.
      let releaseA!: () => void;
      const aHeld = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      // Signal that A's body has actually run AND `aDir` has been set.
      // Without this we'd have a test-side race: A's `acquireInternal` is
      // async (mkdir + git-init-bare), so a setImmediate yield is NOT
      // enough to guarantee A's body has executed. If B's acquire finished
      // first, B's body would run while `aDir === ''` and the assertion
      // `isBareRepo(aDir)` would fail on an empty path — masking the real
      // pin/eviction property the test is here to pin.
      let aEntered!: () => void;
      const aEnteredP = new Promise<void>((resolve) => {
        aEntered = resolve;
      });

      let aDir = '';
      const aPromise = cache.withMirror('ws-pinAaaaaaaaaaaaa', async (handle) => {
        aDir = handle.dir;
        expect(isBareRepo(handle.dir)).toBe(true);
        // Tell the test it can now safely launch B. This MUST come after
        // `aDir` is set — otherwise B could race in and observe `aDir === ''`.
        aEntered();
        // Hold the pin until the test releases us. While we hold, B will
        // arrive (cap=1 → eviction would otherwise rm A's dir).
        await aHeld;
        // Re-verify A's dir AFTER B has run + returned. If the fix is
        // working, A's dir is still on disk; otherwise it was rm -rf'd.
        expect(
          isBareRepo(handle.dir),
          'A.dir must survive a concurrent withMirror(B) while A is pinned',
        ).toBe(true);
        return handle.dir;
      });

      // Wait for A to actually enter its body and set `aDir`. The pin on A
      // is in place from the synchronous start of `withMirror(A)`, so A's
      // pin is already present by the time we get here — what we're
      // waiting for is the test-side bookkeeping (the `aDir` capture).
      await aEnteredP;

      // Now acquire B in parallel. With cap=1, this triggers eviction. The
      // fix: A is pinned, so eviction skips A and the cache temporarily
      // grows to size 2. Inside B's body, A.dir MUST still exist — if the
      // bug were live, A's dir would be rm -rf'd here and A's body (still
      // running, holding `aHeld`) would crash on its post-release assertion.
      let bDir = '';
      await cache.withMirror('ws-pinBbbbbbbbbbbbb', async (handle) => {
        bDir = handle.dir;
        expect(isBareRepo(handle.dir)).toBe(true);
        // CRITICAL: A.dir must be alive RIGHT NOW. A is still pinned,
        // executing inside its withMirror body, and holding the gate.
        expect(
          isBareRepo(aDir),
          'A.dir must NOT be evicted while A is pinned',
        ).toBe(true);
      });
      // After B's body returns, B is unpinned. With cap=1 and A still
      // pinned, eviction picks B (the only unpinned entry over cap). So
      // B.dir may be gone — that's correct, not a bug. We don't assert
      // either way on bDir here; the load-bearing assertion is A's
      // survival above.
      void bDir;

      // Release A — its body re-asserts that A.dir still exists.
      releaseA();
      const aFinalDir = await aPromise;
      expect(aFinalDir).toBe(aDir);
    } finally {
      await cache.shutdown();
    }
  });
});

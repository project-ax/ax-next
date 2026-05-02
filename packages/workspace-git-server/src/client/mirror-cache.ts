// ---------------------------------------------------------------------------
// Per-workspace bare-mirror cache.
//
// Why a per-workspace mirror at all: the host plugin (Phase 2) needs to run
// `git fetch`, `git ls-tree`, and `git cat-file` against a local copy of each
// workspace it touches. Round-tripping to the storage tier on every read
// would burn latency and bandwidth. Per the Phase 2 plan §"Mirror cache
// lifetime", each plugin instance owns one cache, and each cached entry is
// a bare repo dir we can `git fetch <storage-url>` into. Cache lifetime is
// the plugin's lifetime; LRU eviction caps total disk use.
//
// Why `Map<id, Promise<MirrorHandle>>` and not `Map<id, MirrorHandle>`:
// concurrency. When two callers ask for the same id before the first
// `git init` finishes, both must wait on the same in-flight init —
// otherwise we'd double-init into the same dir, which races and wastes work.
// Inserting the Promise into the map *synchronously* (before any `await`)
// closes the race window: every subsequent caller for the same id finds the
// existing Promise and just `await`s it.
//
// Pin/release contract (the API the engine actually uses): `withMirror(id, fn)`
// pins the entry, runs `fn(handle)`, and releases on completion (success
// OR failure). Eviction skips entries whose pinCount > 0 — so an in-flight
// `git fetch` against a mirror can never race against an `rm -rf` on that
// same dir from a concurrent acquire on a different workspaceId. If every
// entry is pinned and we're already at the cap, we let the cache grow
// temporarily — correctness over a strict cap. The cap settles back to the
// configured value as pins drain.
//
// Why we accept inheriting `process.env.PATH`: dev and CI environments place
// `git` on non-standard paths (Homebrew on `/usr/local/bin` or
// `/opt/homebrew/bin`, asdf shims, etc.). Hard-coding a fixed PATH would
// break those. In production the host pod's container PATH is what we want
// anyway. The other env vars stay paranoid (no HOME, no system/global config,
// no terminal prompts) so we still fail closed against e.g. a malicious
// `/etc/gitconfig` or a `~/.gitconfig` smuggled in via a confused-deputy
// path.
//
// Callers are expected to pass a regex-validated workspaceId (the upstream
// `workspaceIdFor` helper produces one by construction). We don't re-validate
// here — defense-in-depth is fine, but the noise wasn't earning its keep.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MirrorHandle {
  /** Absolute path to the bare repo's working dir (the `<id>.git`-like directory). */
  readonly dir: string;
  /** The workspaceId this handle is for. */
  readonly workspaceId: string;
}

export interface WorkspaceGitMirrorCacheOptions {
  /** Optional override for the cache root directory. Default: per-instance tempdir under os.tmpdir(). */
  cacheRoot?: string;
  /** Max cached mirrors before LRU eviction. Default 64. */
  cacheMaxEntries?: number;
}

export interface MirrorCache {
  /**
   * Pin a mirror, run `fn(handle)`, release the pin (always — even on throw).
   * Eviction will skip this entry while `fn` is running, so the handle's
   * `dir` is guaranteed to exist for the duration of `fn`.
   *
   * Concurrent `withMirror` calls for the same workspaceId share one mirror
   * dir (the underlying handle promise is memoized by id). Concurrent calls
   * for DIFFERENT ids run in parallel without serializing.
   */
  withMirror<T>(
    workspaceId: string,
    fn: (handle: MirrorHandle) => Promise<T>,
  ): Promise<T>;
  shutdown(): Promise<void>;
}

const DEFAULT_CACHE_MAX_ENTRIES = 64;

// Same paranoid env shape as the rest of the host-side git callers
// (see plugin-test-only.ts `HOST_GIT_ENV`). We keep it inline here so the
// helper is a leaf module — no cross-file coupling to a "package-level
// paranoid env" constant.
function gitEnv(): NodeJS.ProcessEnv {
  return {
    HOME: '/nonexistent',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // PATH inheritance: see header comment. Dev/test envs need their PATH;
    // production overrides via the host pod's container PATH.
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
}

interface GitInitResult {
  code: number | null;
  stderr: string;
}

function runGitInitBare(dir: string): Promise<GitInitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '--bare', '-b', 'main', dir], {
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const errChunks: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));
    child.stdout?.on('data', () => {
      // Discard stdout; git init writes "Initialized empty Git repository
      // in <dir>" which we don't need.
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

export function createMirrorCache(
  opts?: WorkspaceGitMirrorCacheOptions,
): MirrorCache {
  const cacheMaxEntries = opts?.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  // Resolve the cache root eagerly. When unset, mint a per-instance tempdir
  // under `os.tmpdir()` so two MirrorCache instances in the same process
  // can't collide. `mkdtempSync` is fine here — construct runs once per
  // plugin instance.
  const cacheRoot =
    opts?.cacheRoot ?? mkdtempSync(join(tmpdir(), 'ax-ws-mirror-cache-'));

  // The map: id → in-flight or settled Promise<MirrorHandle>. Inserted
  // synchronously by the internal `acquire` helper before any await, which
  // is what makes concurrent calls for the same id share a single Promise.
  const entries = new Map<string, Promise<MirrorHandle>>();
  // Access order, oldest at index 0, newest at the end. Tracks LRU.
  const accessOrder: string[] = [];
  // Active pin count per workspaceId. Incremented on enter to `withMirror`,
  // decremented on exit (success OR failure). Eviction skips entries with
  // pinCount > 0 so an in-flight git op can't get its dir rm'd from under it.
  const pinCount = new Map<string, number>();
  let closed = false;

  function bump(workspaceId: string): void {
    const idx = accessOrder.indexOf(workspaceId);
    if (idx >= 0) accessOrder.splice(idx, 1);
    accessOrder.push(workspaceId);
  }

  async function evictLruIfOver(): Promise<void> {
    // Walk the access order from oldest to newest, picking the first
    // unpinned entry to evict. If every entry is pinned and we're at cap,
    // we let the cache grow — correctness (no `rm -rf` of a live mirror)
    // over a strict cap. The cap settles back as pins drain on the next
    // call that triggers eviction.
    while (accessOrder.length > cacheMaxEntries) {
      let evictIdx = -1;
      for (let i = 0; i < accessOrder.length; i++) {
        const id = accessOrder[i]!;
        if ((pinCount.get(id) ?? 0) === 0) {
          evictIdx = i;
          break;
        }
      }
      if (evictIdx === -1) {
        // Every entry is pinned. Bail — we'll re-check on the next acquire.
        return;
      }
      const evictId = accessOrder.splice(evictIdx, 1)[0]!;
      const inflight = entries.get(evictId);
      entries.delete(evictId);
      if (inflight) {
        // Wait for the in-flight Promise to settle so we don't try to rm a
        // dir that's still being created. Cancellation would race against the
        // resolver, so we just let it complete.
        let resolved: MirrorHandle | undefined;
        try {
          resolved = await inflight;
        } catch {
          // If the Promise rejected, there's no dir to clean up (the impl
          // below cleans up on init failure before rejecting).
        }
        if (resolved !== undefined) {
          await rm(resolved.dir, { recursive: true, force: true });
        }
      }
    }
  }

  async function buildHandle(workspaceId: string): Promise<MirrorHandle> {
    // We mint a unique tempdir per build (rather than a deterministic
    // `${id}.git` under cacheRoot) so that re-acquiring an evicted id
    // produces a fresh handle pointing at a NEW path. That keeps stale
    // handles held by other callers from accidentally aliasing the new
    // mirror's contents — they'll see ENOENT instead of a fresh repo.
    // The prefix makes the dir easy to identify when grepping the
    // cache root during incident response.
    await mkdir(cacheRoot, { recursive: true });
    const dir = mkdtempSync(join(cacheRoot, `${workspaceId}-`));
    try {
      const result = await runGitInitBare(dir);
      if (result.code !== 0) {
        // Best-effort cleanup of the partial dir before rejecting.
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(
          `git init --bare ${dir} failed (code ${result.code}): ${result.stderr}`,
        );
      }
      return { dir, workspaceId };
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  // Internal-only: looks up or builds the handle, but does NOT touch
  // `pinCount` and does NOT trigger eviction. `withMirror` wraps this with
  // pin/release + post-pin eviction.
  async function acquireInternal(workspaceId: string): Promise<MirrorHandle> {
    if (closed) {
      throw new Error('MirrorCache: withMirror() after shutdown()');
    }
    const existing = entries.get(workspaceId);
    if (existing !== undefined) {
      bump(workspaceId);
      return existing;
    }
    // SYNCHRONOUS Map insertion before any await — this is what closes the
    // concurrency race. Subsequent calls for the same id in the same tick
    // will find the existing Promise via the `entries.get` above.
    const promise = buildHandle(workspaceId);
    entries.set(workspaceId, promise);
    accessOrder.push(workspaceId);

    // If buildHandle rejects, drop the cache entry so a future call can
    // try again rather than getting the cached failure forever.
    promise.catch(() => {
      if (entries.get(workspaceId) === promise) {
        entries.delete(workspaceId);
        const idx = accessOrder.indexOf(workspaceId);
        if (idx >= 0) accessOrder.splice(idx, 1);
      }
    });

    return promise;
  }

  async function withMirror<T>(
    workspaceId: string,
    fn: (handle: MirrorHandle) => Promise<T>,
  ): Promise<T> {
    // Pin BEFORE the build/await: the synchronous insertion into pinCount
    // protects this entry from eviction triggered by a concurrent
    // `withMirror(otherId)` that arrives during our `acquireInternal` await.
    pinCount.set(workspaceId, (pinCount.get(workspaceId) ?? 0) + 1);
    try {
      const handle = await acquireInternal(workspaceId);
      // Run eviction once the new entry is in place. With pins respected,
      // we won't evict ourselves here; we may evict OTHER unpinned entries
      // that pushed us over the cap.
      await evictLruIfOver();
      return await fn(handle);
    } finally {
      const n = pinCount.get(workspaceId) ?? 0;
      if (n <= 1) {
        pinCount.delete(workspaceId);
      } else {
        pinCount.set(workspaceId, n - 1);
      }
      // Eviction may have been deferred while this id was pinned. If we're
      // the last pin to release and the cache is over cap, run eviction
      // now so the cap is honored as soon as it's safe.
      if ((pinCount.get(workspaceId) ?? 0) === 0) {
        await evictLruIfOver();
      }
    }
  }

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    // Snapshot the in-flight Promises and tracked dirs. We settle every
    // Promise (best-effort) before rm-ing the dirs, since rm racing against
    // an in-flight `git init` would be unsafe.
    const pending = Array.from(entries.values());
    const settled = await Promise.allSettled(pending);
    const dirsToRemove = new Set<string>();
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        dirsToRemove.add(result.value.dir);
      }
    }

    entries.clear();
    accessOrder.length = 0;
    pinCount.clear();

    for (const dir of dirsToRemove) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { withMirror, shutdown };
}

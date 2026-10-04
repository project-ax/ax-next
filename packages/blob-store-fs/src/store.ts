import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { PluginError } from '@ax/core';

// ---------------------------------------------------------------------------
// Content-addressed filesystem blob store.
//
// Objects live at <root>/<sha[0:2]>/<sha[2:4]>/<sha>, keyed by the lowercase-hex
// sha256 of their bytes. This is the content-addressed store from
// workspace-git-server/src/server/lfs.ts with the git/LFS HTTP protocol framing
// removed — it already did sha256 addressing, streamed I/O, atomic
// temp-then-rename, and digest verification. Here it becomes a backend for the
// storage-agnostic blob:* service hook.
//
// The sha is a CONTENT hash, never a caller-supplied path. The strict regex
// below defends against path traversal: a caller can only ever name a 64-char
// lowercase-hex string, which can't contain `/`, `..`, NUL, or any other path
// metacharacter. We reject anything else BEFORE building a path.
//
// Retired objects (blob GC, design D3/D9) live in a parallel tree on the SAME
// volume: <root>/.retired/<sha[0:2]>/<sha[2:4]>/<sha>. Retire and restore are
// single `rename`s between the two trees — atomic, never a copy. `purge` only
// ever builds a retired path, so it cannot address a live object.
// ---------------------------------------------------------------------------

/** Lowercase-hex sha256, 64 chars. The only shape a caller may name a blob by. */
const SHA256_REGEX = /^[a-f0-9]{64}$/;
/** One shard level: exactly two lowercase-hex chars. Anything else under the
 *  root (`.retired/`, `lost+found`, a stray file) is not part of the live walk. */
const SHARD_REGEX = /^[a-f0-9]{2}$/;
/** The most blobs one `list` page may carry. */
const LIST_MAX_LIMIT = 1000;
/** The retired namespace's directory under the root. Not a shard name, so the
 *  live walk never enters it. */
const RETIRED_DIR = '.retired';

const PLUGIN_NAME = '@ax/blob-store-fs';

function assertValidSha(sha256: string): void {
  if (typeof sha256 !== 'string' || !SHA256_REGEX.test(sha256)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'sha256 must be 64 lowercase-hex characters',
    });
  }
}

/**
 * Resolve the on-disk path for a content hash. The two-level shard
 * (`<sha[0:2]>/<sha[2:4]>`) keeps any single directory from accumulating
 * millions of entries. `sha256` MUST already be validated by `assertValidSha`.
 */
export function blobPath(root: string, sha256: string): string {
  return join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

/**
 * Resolve the on-disk path of a RETIRED object: `<root>/.retired/<aa>/<bb>/<sha>`.
 * Same volume as the live tree, so retire / restore are atomic renames.
 * `sha256` MUST already be validated by `assertValidSha`.
 */
export function retiredPath(root: string, sha256: string): string {
  return blobPath(join(root, RETIRED_DIR), sha256);
}

export interface BlobPutResult {
  sha256: string;
  size: number;
}

export type BlobGetResult = { bytes: Uint8Array } | { found: false };
export type BlobStatResult = { size: number } | { found: false };

/** Options for `stat`. `restore` defaults to true (restore-on-miss, D3). */
export interface BlobStatOptions {
  restore?: boolean;
}

/** One page request for `list`. `after` is the cursor from the previous page. */
export interface BlobListQuery {
  state: 'live' | 'retired';
  after?: string;
  limit: number;
}
/** One page of `list`. `next` is present iff the page is full — see `list`. */
export interface BlobListResult {
  items: Array<{ sha256: string; size: number }>;
  next?: string;
}

function invalidListInput(message: string): PluginError {
  return new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message });
}

/** Validate a `list` request before anything touches the disk. The hook bus
 *  hands us unchecked JSON-ish input, so check every field's runtime type. */
function assertValidListQuery(q: BlobListQuery): void {
  if (q.state !== 'live' && q.state !== 'retired') {
    throw invalidListInput("state must be 'live' or 'retired'");
  }
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > LIST_MAX_LIMIT) {
    throw invalidListInput(`limit must be an integer between 1 and ${LIST_MAX_LIMIT}`);
  }
  if (q.after !== undefined && (typeof q.after !== 'string' || !SHA256_REGEX.test(q.after))) {
    throw invalidListInput('after must be 64 lowercase-hex characters');
  }
}

/** Is this a "nothing there" error from a directory read or stat? */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Read a file, or `undefined` if it isn't there. */
async function readIfPresent(path: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path);
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

/** Size of a file, or `undefined` if it isn't there. */
async function sizeIfPresent(path: string): Promise<number | undefined> {
  try {
    return (await fs.stat(path)).size;
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

/** Names of the subdirectories of `dir` that are shard levels, ascending.
 *  A directory that doesn't exist (or vanished mid-walk) has none. */
async function shardDirs(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && SHARD_REGEX.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * A filesystem-backed content-addressed blob store rooted at a single
 * operator-supplied directory. The point operations are safe to call
 * concurrently for the SAME content hash:
 *
 *   - `put` is idempotent (identical bytes → identical sha → at most one final
 *     file; concurrent writers each use a unique temp path, and rename is
 *     atomic so the loser simply overwrites identical content).
 *   - `retire` renames live → retired; `purge` unlinks the retired copy only.
 *   - `get` / `stat` restore-on-miss: a live miss renames retired → live and
 *     reads live again. That is what makes a `put` racing a `retire` safe: a
 *     put whose fast path saw the live file just before a retire moved it
 *     still returned a sha that the next `get` can serve.
 *   - `get` re-verifies the digest and refuses to return tampered bytes.
 *
 * `list` is a read-only walk of the shard dirs, not a point operation: it
 * races freely with the others and reports whatever is on disk when each
 * directory is read.
 */
export class BlobStore {
  constructor(private readonly root: string) {}

  /** Create the root directory if it doesn't exist. Called once at plugin init. */
  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /**
   * Store `bytes`, returning their content hash + size. Idempotent: storing the
   * same bytes again yields the same sha and leaves a single file on disk.
   *
   * Atomic temp-then-rename: we hash the bytes, write to a per-call temp path
   * (`<final>.tmp.<pid>.<uuid>` — unique so two concurrent puts of the same
   * content can't corrupt each other's temp file), then rename over the final
   * path. A reader never sees a partially-written object.
   */
  async put(bytes: Uint8Array): Promise<BlobPutResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const finalPath = blobPath(this.root, sha256);

    // Fast path: already stored. Content-addressed, so identical bytes are
    // already on disk under this exact path — no need to rewrite.
    try {
      const stat = await fs.stat(finalPath);
      if (stat.isFile()) return { sha256, size: stat.size };
    } catch {
      // Not present yet — fall through to write.
    }

    await fs.mkdir(dirname(finalPath), { recursive: true });
    // Collision-safe per-call suffix — pid + Date.now() can collide for two
    // concurrent puts of the same content in the same millisecond, which would
    // let both writers mutate the same temp file before either renames and
    // corrupt the object (the lfs.ts concurrent-PUT fix).
    const tempPath = `${finalPath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, buf);
      // Atomic publish. If a concurrent put already created `finalPath` with the
      // SAME content (content-addressed — it must be identical), the rename
      // simply replaces identical bytes; the result is still correct.
      await fs.rename(tempPath, finalPath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {
        // Temp file never created, or already gone — best-effort cleanup.
      });
      throw err;
    }
    return { sha256, size: buf.length };
  }

  /**
   * Read the blob addressed by `sha256`, RE-VERIFYING its digest before
   * returning. A tampered / corrupted on-disk object (bitrot, or an attacker
   * who wrote bytes that don't match the path's hash) is REJECTED with a
   * `corrupt` error — never returned.
   *
   * Restore-on-miss: if the live object is missing, a retired copy is renamed
   * back live and live is read once more (restored bytes are digest-checked
   * like any other). Missing in both → `{ found: false }`.
   */
  async get(sha256: string): Promise<BlobGetResult> {
    assertValidSha(sha256);
    const path = blobPath(this.root, sha256);
    let buf = await readIfPresent(path);
    if (buf === undefined) {
      await this.restore(sha256);
      buf = await readIfPresent(path);
      if (buf === undefined) return { found: false };
    }
    // Re-verify: the content MUST hash to the key it was stored under. If it
    // doesn't, the object is corrupt or tampered — refuse to serve it.
    const computed = createHash('sha256').update(buf).digest('hex');
    if (computed !== sha256) {
      throw new PluginError({
        code: 'corrupt',
        plugin: PLUGIN_NAME,
        message: 'stored object failed digest re-verification',
      });
    }
    return { bytes: new Uint8Array(buf) };
  }

  /**
   * Size of the addressed blob, or `{ found: false }`. No digest check — a
   * cheap metadata probe.
   *
   * On a live miss it restores a retired copy (like `get`) unless
   * `restore: false`, in which case it reports the retired copy's size and
   * leaves it where it is — for probes (e.g. a quota release check) that must
   * not undo a retire.
   */
  async stat(sha256: string, options: BlobStatOptions = {}): Promise<BlobStatResult> {
    assertValidSha(sha256);
    const { restore } = options;
    if (restore !== undefined && typeof restore !== 'boolean') {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'restore must be a boolean',
      });
    }
    const path = blobPath(this.root, sha256);
    let size = await sizeIfPresent(path);
    if (size === undefined) {
      if (restore === false) {
        size = await sizeIfPresent(retiredPath(this.root, sha256));
      } else {
        await this.restore(sha256);
        size = await sizeIfPresent(path);
      }
    }
    return size === undefined ? { found: false } : { size };
  }

  /**
   * Move the addressed blob out of the live tree into the retired one (one
   * same-volume rename). Missing live object → no-op. Idempotent. Callers
   * (the GC) decide WHAT to retire; a wrong guess is harmless because any
   * `get` / `stat` restores it.
   */
  async retire(sha256: string): Promise<void> {
    assertValidSha(sha256);
    const target = retiredPath(this.root, sha256);
    await fs.mkdir(dirname(target), { recursive: true });
    try {
      await fs.rename(blobPath(this.root, sha256), target);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  /**
   * Delete the RETIRED copy of the addressed blob. Missing → no-op.
   * Idempotent. The only path built here is the retired one, so purge can
   * never remove a live object.
   */
  async purge(sha256: string): Promise<void> {
    assertValidSha(sha256);
    try {
      await fs.unlink(retiredPath(this.root, sha256));
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  /**
   * Rename a retired copy back live. If it is not there (never retired, or a
   * concurrent restore / purge got to it first) this is a no-op — the caller
   * re-reads live exactly once either way. `sha256` is already validated.
   */
  private async restore(sha256: string): Promise<void> {
    const live = blobPath(this.root, sha256);
    const retired = retiredPath(this.root, sha256);
    try {
      await fs.rename(retired, live);
      return;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    // ENOENT is either "no retired copy" (the common miss) or "the live shard
    // dir doesn't exist". Only pay for the mkdir when there is something to
    // move, so a plain miss never litters empty shard dirs.
    if ((await sizeIfPresent(retired)) === undefined) return;
    try {
      await fs.mkdir(dirname(live), { recursive: true });
      await fs.rename(retired, live);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  /**
   * One page of live (or retired) blobs, ascending by sha256. This is the GC's enumeration
   * seam (`blob:list`): it finds blobs no ledger row has ever seen.
   *
   * `after` is exclusive — pass the previous page's `next`. `next` is present
   * iff the page holds exactly `limit` items, and then it IS the last item's
   * sha. So a final page can legitimately be empty (an exact multiple of
   * `limit`); callers loop until `next` is absent. The key is left OFF rather
   * than set to `undefined`, so it survives the bus's `returns` schema as-is.
   *
   * The walk is `<root>/<aa>/<bb>/<sha>`, both shard levels sorted. Only
   * entries that are shaped like the store keeps them count: two-hex dirs, and
   * 64-hex files filed under their own shard. That leaves out `.retired/`,
   * `lost+found`, stray files, and — the one that matters — the
   * `<sha>.tmp.<pid>.<uuid>` file of an in-flight put, which is not a blob yet.
   * Shard dirs that sort before `after`'s shard are never read, so deep paging
   * doesn't re-walk the front of the store.
   *
   * `state: 'retired'` walks `<root>/.retired/<aa>/<bb>/<sha>` with exactly
   * the same rules.
   */
  async list(query: BlobListQuery): Promise<BlobListResult> {
    assertValidListQuery(query);
    const { state, after, limit } = query;
    const base = state === 'retired' ? join(this.root, RETIRED_DIR) : this.root;

    const afterAa = after?.slice(0, 2);
    const afterBb = after?.slice(2, 4);
    const items: BlobListResult['items'] = [];

    for (const aa of await shardDirs(base)) {
      if (afterAa !== undefined && aa < afterAa) continue;
      for (const bb of await shardDirs(join(base, aa))) {
        if (afterAa === aa && afterBb !== undefined && bb < afterBb) continue;
        const dir = join(base, aa, bb);
        let entries: Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          if (isEnoent(err)) continue;
          throw err;
        }
        const shas = entries
          .filter(
            (e) =>
              e.isFile() &&
              SHA256_REGEX.test(e.name) &&
              e.name.startsWith(aa + bb) &&
              (after === undefined || e.name > after),
          )
          .map((e) => e.name)
          .sort();
        for (const sha256 of shas) {
          let size: number;
          try {
            size = (await fs.stat(join(dir, sha256))).size;
          } catch (err) {
            // Moved / removed between the readdir and now — it isn't listed.
            if (isEnoent(err)) continue;
            throw err;
          }
          items.push({ sha256, size });
          if (items.length === limit) return { items, next: sha256 };
        }
      }
    }
    return { items };
  }
}

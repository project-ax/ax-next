import { promises as fs, constants, type Dir, type Dirent, type Stats } from 'node:fs';
import * as path from 'node:path';
import { UserFilesReadError } from './errors.js';
import { assertWalkPlatform, errnoOf, fdPath } from './walk-read.js';

// ---------------------------------------------------------------------------
// measureConfinedUserFiles — how much an agent's /files holds (TASK-993).
//
// THREAT MODEL. The tree is agent-written: its shape, its names, its links and
// its permissions are all the agent's choice, and it can change any of them at
// any moment, including while we walk it. It sits on an export beside every
// other tenant's tree. So nothing outside the agent's own folder may be
// counted, listed, or even looked up, whatever the agent plants or swaps.
//
// WHY NOT `measureDirBytes` (workspace-git-core/src/disk-usage.ts). It lstats
// a path and then reads the directory by that path again. An agent that swaps
// a folder for a symlink between those two calls makes it walk wherever the
// link points: a sibling tenant's folder, or `/` on the host. That is the W3b
// check-then-use window, the same one `readConfinedByWalk` (walk-read.ts)
// closes for the /files reader, and this walk closes it the same way.
//
// HOW. The root is the only path opened by name (it is trusted configuration
// and may itself be a symlink). Every folder below it is opened as ONE name
// relative to its parent's held descriptor, `/proc/self/fd/<fd>/<name>`, with
// O_NOFOLLOW | O_DIRECTORY, and then listed through its own descriptor. If the
// name is a link at the instant of the open, the open fails (ELOOP / ENOTDIR)
// and the folder is skipped. Entries are sized with `lstat` through the same
// held descriptor, which never follows the last name. Nothing but folders is
// ever opened, so a FIFO or a device can't park the walk, and no handle is
// writable. Names are raw bytes end to end (`encoding: 'buffer'`), so a name
// that isn't valid UTF-8 is measured, not lost; names are never logged or
// returned. LINUX ONLY, like the reader: elsewhere this throws
// `unsupported-platform` rather than answering 0.
//
// BOUNDS, because the tree is hostile as well as untrusted:
// - `maxEntries` (default 1,000,000): a million-file folder costs a million
//   lstats; the walk stops there.
// - `maxDepth` (default 64): every level holds two descriptors (the folder and
//   its listing), so depth is what bounds descriptors per walk.
// - `maxMs` (default 120 s): a slow export (NFS) can make even a bounded walk
//   take minutes. Checked every 256 entries.
// Concurrency is bounded HERE, per process (`MAX_CONCURRENT_USAGE_WALKS`,
// below), not only by the caller: see that constant for why.
//
// PARTIAL. When a bound is hit, or an entry or folder can't be read for any
// reason other than having vanished or been swapped, the walk keeps what it
// counted and says `complete: false`. That reading is a LOWER bound: the tree
// holds at least that much. A vanished entry or a swapped folder is ordinary
// churn, not a gap: it is skipped and the reading stays complete.
//
// ERRORS. A missing home folder under an export that exists is 0 (the agent
// has never run). A missing export, or a root that can't be opened, examined
// or listed, throws `UserFilesReadError` with the errno's name: a broken read
// is never a reading of 0. A walk refused because the per-process cap is full
// throws `UserFilesReadError` code `walk-busy` (transient).
//
// KNOWN RESIDUAL. An agent can remove read/search permission from its own
// folders and hide what is in them. The reading is then partial (and the
// caller logs that), and the export's capacity alert is the backstop.
// Also: on a filesystem whose directory entries come back with an unknown type
// (DT_UNKNOWN), Node's `Dir.read()` lstats each entry synchronously on the
// event loop, and an entry deleted in that window rejects the whole read. Linux
// NFS normally fills in entry types (READDIRPLUS), and the /files reader has
// the same exposure.
// ---------------------------------------------------------------------------

export interface UsageWalkLimits {
  /** Most entries (files, folders, links, anything) counted; then partial. */
  maxEntries: number;
  /** Deepest folder opened, the root being 0; a deeper one is partial. */
  maxDepth: number;
  /** Wall-clock budget; past it the reading is partial. */
  maxMs: number;
}

export const DEFAULT_USAGE_WALK_LIMITS: Readonly<UsageWalkLimits> = Object.freeze({
  maxEntries: 1_000_000,
  maxDepth: 64,
  maxMs: 120_000,
});

export interface UsageReading {
  /** Allocated bytes (`blocks * 512`) of the root and every entry counted. */
  bytes: number;
  /** Entries counted below the root (the root itself is not one). */
  entries: number;
  /** False means a lower bound: a bound was hit or something was unreadable. */
  complete: boolean;
}

/** How often (in entries) the clock is read. */
const CLOCK_EVERY = 256;

const DOT = Buffer.from('.');
const DOTDOT = Buffer.from('..');

/** Listing options: raw-byte names, streamed a few at a time. */
const DIR_OPTS = {
  // Node's types only admit text encodings here, but `fs.opendir` honours
  // 'buffer' and then names every entry with a Buffer (checked in `nameOf`).
  encoding: 'buffer' as BufferEncoding,
  bufferSize: 64,
};

interface Frame {
  fh: fs.FileHandle;
  dir: Dir | undefined;
  /** `/proc/self/fd/<fd>/`, as bytes, for building child paths. */
  prefix: Buffer;
  depth: number;
}

const allocated = (st: Stats): number =>
  Number.isFinite(st.blocks) ? st.blocks * 512 : st.size;

function checkLimit(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer of at least ${min}`);
  }
}

function fail(what: string, err: unknown): UserFilesReadError {
  const code = errnoOf(err);
  return new UserFilesReadError(`${what}${code === undefined ? '' : ` (${code})`}`, {
    cause: err,
    ...(code === undefined ? {} : { code }),
  });
}

function nameOf(dirent: Dirent): Buffer {
  const name: unknown = dirent.name;
  // A text name would have been decoded lossily: a non-UTF-8 name would then
  // look up a file that doesn't exist and be skipped as vanished, unseen.
  if (!Buffer.isBuffer(name)) throw new TypeError('directory listing did not return raw names');
  return name;
}

async function closeFrame(frame: Frame | undefined): Promise<void> {
  if (frame === undefined) return;
  await frame.dir?.close().catch(() => undefined);
  await frame.fh.close().catch(() => undefined);
}

function frameFor(fh: fs.FileHandle, depth: number): Frame {
  return { fh, dir: undefined, prefix: Buffer.from(`${fdPath(fh.fd)}/`), depth };
}

/**
 * At most this many usage walks run at once in this process, counted from the
 * start of each walk until the walk ITSELF ends; a further call is refused with
 * code `walk-busy`.
 *
 * Why here and not only in the caller: every fs call the walk makes holds one
 * libuv threadpool thread (4 by default) while it runs. On a hard-mounted
 * export that hangs, a single `readdir` or `lstat` never returns, so neither
 * `maxMs` (checked between entries) nor a caller's timeout ends the walk. A
 * caller that gave up (a bus timeout) frees its own concurrency slot while the
 * walk is still stuck, and the next request starts another. Counted here, stuck
 * USAGE walks can never hold more than this many threads, whatever the callers
 * do. (The /files reader walks the same export with no such cap, so a hung
 * export can still tie up the rest of the pool through it.)
 */
export const MAX_CONCURRENT_USAGE_WALKS = 2;
let usageWalksInFlight = 0;

/**
 * Sum the allocated bytes of the agent-written tree at the trusted `root`,
 * never leaving it and never following a link. See the file header.
 */
export async function measureConfinedUserFiles(
  root: string,
  limits: UsageWalkLimits = DEFAULT_USAGE_WALK_LIMITS,
  clock: () => number = Date.now,
): Promise<UsageReading> {
  checkLimit('maxEntries', limits.maxEntries, 1);
  checkLimit('maxDepth', limits.maxDepth, 0);
  checkLimit('maxMs', limits.maxMs, 1);
  assertWalkPlatform();
  if (usageWalksInFlight >= MAX_CONCURRENT_USAGE_WALKS) {
    throw new UserFilesReadError('too many usage walks are already running in this process', {
      code: 'walk-busy',
    });
  }
  usageWalksInFlight++;
  try {
    return await walkUsage(root, limits, clock);
  } finally {
    usageWalksInFlight--;
  }
}

async function walkUsage(
  root: string,
  limits: UsageWalkLimits,
  clock: () => number,
): Promise<UsageReading> {
  const start = clock();
  const stack: Frame[] = [];
  let bytes = 0;
  let entries = 0;
  let complete = true;

  try {
    // The root: trusted, opened by name, may be a link.
    let rootFh: fs.FileHandle;
    try {
      rootFh = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (err) {
      if (errnoOf(err) !== 'ENOENT') throw fail('could not open the usage root', err);
      // No home yet is 0, but only if the export it would live in is there:
      // a missing export is a broken mount, not an empty one.
      let parent: Stats;
      try {
        parent = await fs.stat(path.dirname(root));
      } catch (parentErr) {
        throw fail('could not find the folder that holds the usage root', parentErr);
      }
      if (!parent.isDirectory()) {
        throw new UserFilesReadError('the folder that holds the usage root is not a folder', {
          code: 'ENOTDIR',
        });
      }
      return { bytes: 0, entries: 0, complete: true };
    }
    const rootFrame = frameFor(rootFh, 0);
    stack.push(rootFrame);
    try {
      bytes += allocated(await rootFh.stat());
    } catch (err) {
      throw fail('could not examine the usage root', err);
    }
    try {
      rootFrame.dir = await fs.opendir(fdPath(rootFh.fd), DIR_OPTS);
    } catch (err) {
      throw fail('could not list the usage root', err);
    }

    walk: while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      let dirent: Dirent | null;
      try {
        dirent = await frame.dir!.read();
      } catch (err) {
        if (frame.depth === 0) throw fail('could not list the usage root', err);
        await closeFrame(stack.pop());
        complete = false;
        continue;
      }
      if (dirent === null) {
        await closeFrame(stack.pop());
        continue;
      }
      const name = nameOf(dirent);
      if (name.equals(DOT) || name.equals(DOTDOT)) continue;

      if (entries > 0 && entries % CLOCK_EVERY === 0 && clock() - start > limits.maxMs) {
        complete = false;
        break walk;
      }
      if (entries + 1 > limits.maxEntries) {
        complete = false;
        break walk;
      }
      entries++;

      // One name inside a folder we hold. lstat never follows it.
      const child = Buffer.concat([frame.prefix, name]);
      let st: Stats;
      try {
        st = await fs.lstat(child);
      } catch (err) {
        if (errnoOf(err) !== 'ENOENT') complete = false; // ENOENT: vanished since listed
        continue;
      }
      bytes += allocated(st);
      if (!st.isDirectory()) continue;

      if (frame.depth + 1 > limits.maxDepth) {
        complete = false;
        continue;
      }
      let fh: fs.FileHandle;
      try {
        fh = await fs.open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (err) {
        const code = errnoOf(err);
        // Vanished, or swapped for a link or a file since the lstat: churn,
        // not a gap. Anything else (EACCES, EIO, …) hides what is inside.
        if (code !== 'ENOENT' && code !== 'ELOOP' && code !== 'ENOTDIR') complete = false;
        continue;
      }
      const next = frameFor(fh, frame.depth + 1);
      try {
        next.dir = await fs.opendir(fdPath(fh.fd), DIR_OPTS);
      } catch {
        await closeFrame(next);
        complete = false;
        continue;
      }
      stack.push(next);
    }
    return { bytes, entries, complete };
  } finally {
    while (stack.length > 0) await closeFrame(stack.pop());
  }
}

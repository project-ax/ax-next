import { existsSync, promises as fs, constants, type BigIntStats } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { UserFileDirEntry, UserFileVersion } from '@ax/sandbox-mount-protocol';
import { UserFilesReadError } from './errors.js';

// ---------------------------------------------------------------------------
// readConfinedByWalk — a confined reader with no check-then-use window (W3b).
//
// A reader that confines by realpath and then opens the path again leaves a
// window between those two steps: an agent that writes the tree can swap an
// INTERMEDIATE directory for a symlink, and the second open follows it.
// O_NOFOLLOW only guards the last component. That window is acceptable
// nowhere it can be avoided, and for the /files reader it is the whole threat:
// an agent's writes, read by the host for the person browsing them, off an
// export that holds every tenant's files.
//
// So this reader never resolves a path at all. It opens the trusted root, then
// opens EACH component relative to the descriptor it already holds, through
// `/proc/self/fd/<fd>/<name>`, with O_NOFOLLOW. The kernel looks up exactly
// one name inside a directory we have pinned; if that name is a symlink at the
// instant of the lookup, the open fails (ELOOP / ENOTDIR). Swapping it a
// microsecond earlier or later changes which answer we give — the real file,
// or absent — but never makes us read through a link. There is no absolute
// path built from the parts anywhere in this file. Same pattern as the storage
// node's `openDirectory` (sandbox-k8s/src/storage-node/confined-directory.ts).
//
// LINUX ONLY: the mechanism is /proc. Elsewhere, and on a Linux host without
// procfs mounted, this throws `UserFilesReadError` with code
// `unsupported-platform` rather than quietly answering `absent` for everything
// (every /proc/... open would just be ENOENT).
//
// Decisions worth naming:
//
// - INTERMEDIATE components are opened O_PATH, not O_RDONLY (the ESTALE retry
//   below is the one exception). Passing through a directory should need
//   search permission only, the reach a path lookup always needed, so a
//   directory the agent made search-only (0311) still reads through. O_RDONLY
//   would need read permission too. The LEAF is opened O_RDONLY because we
//   read or list it.
// - The LEAF is opened O_NONBLOCK too. A FIFO opened O_RDONLY without it blocks
//   until a writer appears — an agent could park the host's request forever.
//   We open, fstat, and only read a regular file. A FIFO, socket, or device is
//   `absent` (reason `not-file-or-dir`): nothing a file browser serves, and
//   saying "absent" matches `readConfinedUserFiles`.
// - Symlinks (and FIFOs, sockets, devices) in a LISTING are omitted, never
//   named, and never opened. Each child is lstat'd through the held directory
//   descriptor — lstat does not follow the final component — and only regular
//   files and directories are kept.
// - "Absent" carries a `reason`, for tests and diagnostics. Nothing logs it:
//   the /files adapter (`readConfinedUserFiles`) drops it on purpose. A caller
//   must not echo it to a client: telling "this is a symlink" apart from "this
//   is missing" is a free oracle about a tree the reader may not otherwise see.
// - Everything else that fails (EACCES, EIO, ESTALE, …) THROWS
//   `WalkReadError` with the errno's name and the depth it failed at. A broken
//   read is not an absence (TASK-403).
// - ESTALE gets ONE retry: a whole new walk, whose answer is final. On NFS a
//   handle can name a directory that is gone: the agent replaced or deleted a
//   folder, and this host's NFS caches still hold the old one. Opening a
//   directory O_PATH skips NFS's close-to-open check, so the same walk again
//   finds the same stale directory, until the cache times out (up to a
//   minute). The retry opens the root and every intermediate O_RDONLY
//   instead. Below the root, each is still O_NOFOLLOW and O_DIRECTORY, and
//   still one name relative to the descriptor already held; the root, by
//   design, is neither no-follow nor relative to a held descriptor. On the
//   retry, O_DIRECTORY is what keeps a FIFO or device on the path from being
//   opened: an O_RDONLY open of a FIFO without O_NONBLOCK would park a thread
//   until a writer appears. An O_RDONLY open makes NFS check each directory
//   with the server and look a stale one up again. So a replaced folder
//   serves its new files, a deleted one is absent (ENOENT), and an export
//   that is itself stale fails ESTALE again, which throws. Measured on a real NFSv3 export
//   (TASK-899). The cost: on the retry, a search-only directory (above)
//   throws EACCES, because O_RDONLY needs read permission. A broken read,
//   never an absence.
//
// TWO READS, ONE WALK (TASK-1014). `readConfinedByWalk` reads a file's first
// bytes or lists a directory (the preview). `readRangeByWalk` reads one byte
// range of a regular file, with its size and an opaque version (a download, a
// range at a time). They differ only in what they do with the leaf: the open
// of the root and of every component, the flags above, the closing of every
// handle and the ESTALE retry are one piece of code, `walkOnce` and
// `walkWithRetry`, so everything in this header holds for both. The range
// read's leaf:
//
// - is fstat'd (with nanosecond times) BEFORE any byte is read. The version
//   is that fstat's `dev:ino:size:mtimeNs:ctimeNs`, and the read stops at that
//   fstat's size, so no byte past the size the version names is read. A file
//   that shrank since answers short; one that grew is read only up to the old
//   size, and its next answer carries a new size and version. A write into
//   the range while it is being read moves the file's times, so the caller's
//   next call (the next range, or its final check) sees a new version.
// - answers `dir` for a directory without listing it.
// - holds nothing once it returns. Every call walks again, so a caller can
//   stop at any moment without leaking a descriptor.
//
// KNOWN GAP in the version: an in-place rewrite that keeps the size, done
// inside one tick of the filesystem's timestamp clock, keeps the same mtime
// and ctime too, so the version cannot see it. A rename-replace (new inode),
// truncate or append (new size), or anything slower than one tick, can be
// seen.
// ---------------------------------------------------------------------------

/** No more path components than this, root excluded. */
export const MAX_WALK_PARTS = 32;

/** Ceiling on `limitBytes`: the largest read any caller may ask for. */
export const MAX_WALK_LIMIT_BYTES = 16 * 1024 * 1024;
/** Ceiling on `maxEntries`. */
export const MAX_WALK_ENTRIES = 10_000;
/**
 * Entries a listing may skip (links, FIFOs, sockets, devices, entries deleted
 * mid-listing) before it stops. Skipped entries don't count toward
 * `maxEntries`, so without this a folder of a million symlinks would cost a
 * million `lstat`s for one listing.
 */
export const MAX_WALK_SKIPPED = 1_000;

/**
 * O_PATH is not in Node's `fs.constants`. Its value is 010000000 on every
 * architecture Node supports on Linux (x86_64, arm64, arm, ppc64, s390x,
 * riscv64); only alpha/parisc/sparc differ.
 */
const O_PATH = (constants as Record<string, number | undefined>)['O_PATH'] ?? 0o10000000;

/** The caller's path was malformed: refused before the disk is touched. */
export class WalkPathError extends Error {
  readonly code = 'invalid-path' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WalkPathError';
  }
}

/**
 * The storage was there and refused (or this platform has no /proc).
 * `depth` is the index into `parts` that failed; `-1` is the root itself.
 */
export class WalkReadError extends UserFilesReadError {
  readonly depth: number;
  constructor(message: string, options: { cause?: unknown; code?: string; depth: number }) {
    super(message, options);
    this.name = 'WalkReadError';
    this.depth = options.depth;
  }
}

/**
 * Why a path is absent — for tests and diagnostics, never a client response.
 * The /files adapter drops it on purpose, and nothing logs it.
 * - `missing`: a component does not exist (ENOENT).
 * - `link-or-not-dir`: a component is a symlink, or a non-directory where a
 *   directory was needed (ELOOP / ENOTDIR).
 * - `not-file-or-dir`: the leaf is a FIFO, socket, or device.
 */
export type WalkAbsentReason = 'missing' | 'link-or-not-dir' | 'not-file-or-dir';

/** Same discriminants as `ReadUserFilesOutput` (minus `unavailable`, the caller's call). */
export type WalkReadOutput =
  | { kind: 'file'; contents: Uint8Array; truncated: boolean }
  | { kind: 'dir'; entries: UserFileDirEntry[]; truncated: boolean }
  | { kind: 'absent'; reason: WalkAbsentReason };

export interface WalkReadLimits {
  /** Most bytes of a file returned; a longer file is a prefix with `truncated`. */
  limitBytes: number;
  /** Most entries in a listing; more sets `truncated`. */
  maxEntries: number;
}

/** One byte range of a file, for `readRangeByWalk`. */
export interface WalkRange {
  /** First byte to read: a safe integer, 0 or more. At or past the end, nothing is read. */
  offset: number;
  /** Most bytes to read: an integer from 0 to MAX_WALK_LIMIT_BYTES. 0 reads nothing. */
  length: number;
}

/** The walk's absence: the answer, and why. Both reads give it the same way. */
type WalkAbsent = { kind: 'absent'; reason: WalkAbsentReason };

/** Same discriminants as `ReadUserFileRangeOutput` (minus `unavailable`, the caller's call). */
export type WalkRangeOutput =
  | { kind: 'file'; size: number; version: UserFileVersion; bytes: Uint8Array }
  | { kind: 'dir' }
  | WalkAbsent;

function assertSafePart(part: string): void {
  if (part === '' || part === '.' || part === '..' || part.includes('/') || part.includes('\0')) {
    throw new WalkPathError(`unsafe path component: ${JSON.stringify(part)}`);
  }
}

/** The part list's own rules, checked before the disk: depth, then each part. */
function assertWalkParts(parts: string[]): void {
  if (parts.length > MAX_WALK_PARTS) throw new WalkPathError('path is too deep');
  parts.forEach(assertSafePart);
}

/**
 * Refuse a range no call may ask for, with a `RangeError`, before the disk: an
 * offset that is not a whole byte, or a read bigger than one call may pull into
 * memory. Exported so the /files adapter can refuse it before anything else.
 */
export function assertWalkRange(range: WalkRange): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new RangeError('offset must be a safe integer, 0 or more');
  }
  if (!Number.isSafeInteger(range.length) || range.length < 0 || range.length > MAX_WALK_LIMIT_BYTES) {
    throw new RangeError(`length must be an integer from 0 to ${MAX_WALK_LIMIT_BYTES}`);
  }
}

/**
 * Split a caller-supplied relative path into walk components. `''` is the
 * root (`[]`). Refuses absolute paths, empty / `.` / `..` segments (so also
 * `a//b` and a trailing `/`), NUL, and more than `MAX_WALK_PARTS` segments.
 */
export function splitRelPath(relPath: string): string[] {
  if (relPath === '') return [];
  if (relPath.startsWith('/')) throw new WalkPathError('path must be relative');
  const parts = relPath.split('/');
  if (parts.length > MAX_WALK_PARTS) throw new WalkPathError('path is too deep');
  parts.forEach(assertSafePart);
  return parts;
}

/**
 * Errno numbers to names. Where two names share a number (EAGAIN and
 * EWOULDBLOCK), the first listed wins; Node names those itself anyway.
 */
const ERRNO_NAMES = new Map<number, string>();
for (const [name, n] of Object.entries(osConstants.errno)) {
  if (!ERRNO_NAMES.has(n)) ERRNO_NAMES.set(n, name);
}

/**
 * The errno's name: `code`, when Node gave a real one. Node's names come from
 * libuv, which has none for some errnos, ESTALE among them, and then `code` is
 * text like 'Unknown system error -116'. So the name comes from `errno`
 * instead, the number libuv reports negated. That is how a stale NFS handle
 * reads `ESTALE` here, which the ESTALE retry needs and `WalkReadError.code`
 * promises.
 */
export function errnoOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; errno?: unknown } | null;
  const code = e?.code;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return code;
  const named = typeof e?.errno === 'number' ? ERRNO_NAMES.get(Math.abs(e.errno)) : undefined;
  return named ?? (typeof code === 'string' ? code : undefined);
}

function absentReason(code: string | undefined): WalkAbsentReason | undefined {
  if (code === 'ENOENT') return 'missing';
  if (code === 'ELOOP' || code === 'ENOTDIR') return 'link-or-not-dir';
  // A UNIX socket cannot be open()ed at all: that is a special file, not an error.
  if (code === 'ENXIO') return 'not-file-or-dir';
  return undefined;
}

function fail(what: string, err: unknown, depth: number): WalkReadError {
  const code = errnoOf(err);
  return new WalkReadError(`${what}${code === undefined ? '' : ` (${code})`}`, {
    cause: err,
    depth,
    ...(code === undefined ? {} : { code }),
  });
}

// `self`, not our pid. Descriptors belong to the process, so it names the same
// directory, and it can never name another process: under a /proc from a
// different pid namespace, our pid may belong to someone else.
export const fdPath = (fd: number): string => `/proc/self/fd/${fd}`;

/**
 * Refuse to walk anywhere a descriptor-relative walk can't work: off Linux,
 * and on a Linux host without procfs mounted. Without /proc every
 * `/proc/self/fd/...` open is ENOENT, so a walk that ran anyway would answer
 * "absent" (or, for the usage meter, 0) for a tree it never saw.
 */
export function assertWalkPlatform(): void {
  if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) {
    throw new WalkReadError('the confined walk needs Linux /proc', {
      code: 'unsupported-platform',
      depth: -1,
    });
  }
}

/**
 * Read `parts` under the trusted `root`, opening every component relative to
 * the previous one's descriptor with O_NOFOLLOW. A walk that fails ESTALE is
 * walked once more, and that answer stands. See the file header.
 *
 * `root` is the only path opened by name, and it MAY be a symlink (it is
 * trusted configuration, not agent-written). `parts` is untrusted.
 */
export async function readConfinedByWalk(
  root: string,
  parts: string[],
  opts: WalkReadLimits,
): Promise<WalkReadOutput> {
  assertWalkParts(parts);
  if (!Number.isSafeInteger(opts.limitBytes) || opts.limitBytes < 0 || opts.limitBytes > MAX_WALK_LIMIT_BYTES) {
    throw new RangeError(`limitBytes must be an integer from 0 to ${MAX_WALK_LIMIT_BYTES}`);
  }
  if (!Number.isSafeInteger(opts.maxEntries) || opts.maxEntries < 1 || opts.maxEntries > MAX_WALK_ENTRIES) {
    throw new RangeError(`maxEntries must be an integer from 1 to ${MAX_WALK_ENTRIES}`);
  }
  assertWalkPlatform();

  return await walkWithRetry<WalkReadOutput>(root, parts, async (leaf, depth) => {
    let stat;
    try {
      stat = await leaf.stat();
    } catch (err) {
      throw fail('could not stat the leaf', err, depth);
    }
    if (stat.isDirectory()) return await listDir(leaf.fd, opts.maxEntries, depth);
    if (stat.isFile()) return await readPrefix(leaf, opts.limitBytes, stat.size, depth);
    return { kind: 'absent', reason: 'not-file-or-dir' };
  });
}

/**
 * Read one byte range of the regular file at `parts` under the trusted
 * `root`, with the file's size and an opaque version (TASK-1014). The walk is
 * `readConfinedByWalk`'s, the same code: every component opened relative to
 * the previous one's descriptor with O_NOFOLLOW, and the same one ESTALE
 * retry. A directory answers `dir` and is not listed. A FIFO, socket or
 * device, or a link anywhere on the path, is absent. See the file header.
 *
 * Size and version come from one fstat taken before any byte is read, and the
 * read never goes past that size. So `bytes` holds
 * `min(length, max(0, size - offset))` bytes, or fewer if the file shrank in
 * between: a short answer means the file changed.
 */
export async function readRangeByWalk(
  root: string,
  parts: string[],
  range: WalkRange,
): Promise<WalkRangeOutput> {
  assertWalkParts(parts);
  // Copied, then checked: what is read is exactly what was checked.
  const { offset, length } = range;
  assertWalkRange({ offset, length });
  assertWalkPlatform();

  return await walkWithRetry<WalkRangeOutput>(root, parts, async (leaf, depth) => {
    let stat: BigIntStats;
    try {
      stat = await leaf.stat({ bigint: true });
    } catch (err) {
      throw fail('could not stat the leaf', err, depth);
    }
    if (stat.isDirectory()) return { kind: 'dir' };
    if (!stat.isFile()) return { kind: 'absent', reason: 'not-file-or-dir' };
    return await readRange(leaf, stat, offset, length, depth);
  });
}

/**
 * What a walk does with the leaf it opened. `depth` is the leaf's index in
 * `parts` (`-1` when the leaf is the root itself), for errors. It runs inside
 * the walk's try/finally: every handle the walk holds, the leaf included, is
 * closed once it settles, so it must not keep the handle. What it throws gets
 * the same ESTALE retry as a failed open.
 */
type LeafVisitor<T> = (leaf: fs.FileHandle, depth: number) => Promise<T>;

/**
 * Walk to the leaf and hand it to `visit`. A walk that fails ESTALE, at any
 * step, `visit`'s included, is walked once more, and that answer stands. See
 * the file header. The caller checks the parts, its own arguments and the
 * platform first.
 */
async function walkWithRetry<T>(
  root: string,
  parts: string[],
  visit: LeafVisitor<T>,
): Promise<T | WalkAbsent> {
  try {
    return await walkOnce(root, parts, O_PATH, visit);
  } catch (err) {
    if (!(err instanceof WalkReadError) || err.code !== 'ESTALE') throw err;
  }
  // The one retry: a whole new walk that passes through every directory with
  // an open NFS revalidates. Its answer is final. See the file header.
  return await walkOnce(root, parts, constants.O_RDONLY, visit);
}

/**
 * One walk. `passThrough` is how the root and every directory on the way to
 * the leaf are opened: O_PATH, or O_RDONLY on the ESTALE retry. The leaf is
 * opened O_RDONLY | O_NONBLOCK | O_NOFOLLOW (or, for an empty `parts`, the root
 * itself O_RDONLY) and handed to `visit`.
 */
async function walkOnce<T>(
  root: string,
  parts: string[],
  passThrough: number,
  visit: LeafVisitor<T>,
): Promise<T | WalkAbsent> {
  const held: fs.FileHandle[] = [];
  try {
    // The root: trusted, so no O_NOFOLLOW. `passThrough` when we only pass
    // through it.
    try {
      held.push(
        await fs.open(
          root,
          constants.O_DIRECTORY | (parts.length > 0 ? passThrough : constants.O_RDONLY),
        ),
      );
    } catch (err) {
      throw fail('could not open the walk root', err, -1);
    }

    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      const flags =
        constants.O_NOFOLLOW |
        (leaf ? constants.O_RDONLY | constants.O_NONBLOCK : passThrough | constants.O_DIRECTORY);
      try {
        held.push(await fs.open(`${fdPath(held.at(-1)!.fd)}/${parts[i]}`, flags));
      } catch (err) {
        const reason = absentReason(errnoOf(err));
        if (reason !== undefined) return { kind: 'absent', reason };
        throw fail('could not open a path component', err, i);
      }
    }

    // `return await`, not `return`: the handles stay open until `visit` has
    // settled, and only then does the `finally` close them.
    return await visit(held.at(-1)!, parts.length - 1);
  } finally {
    for (const fh of held.reverse()) await fh.close().catch(() => undefined);
  }
}

async function listDir(dirFd: number, maxEntries: number, depth: number): Promise<WalkReadOutput> {
  const dirPath = fdPath(dirFd);
  // Streamed, never `readdir`: a folder an agent filled with millions of
  // names must not be loaded whole. Kept and skipped entries are both capped,
  // so one listing costs at most maxEntries + MAX_WALK_SKIPPED stats.
  let dir;
  try {
    dir = await fs.opendir(dirPath, { bufferSize: 64 });
  } catch (err) {
    throw fail('could not list a directory', err, depth);
  }
  const entries: UserFileDirEntry[] = [];
  let truncated = false;
  let skipped = 0;
  try {
    for (;;) {
      let dirent;
      try {
        dirent = await dir.read();
      } catch (err) {
        throw fail('could not list a directory', err, depth);
      }
      if (dirent === null) break;
      if (skipped >= MAX_WALK_SKIPPED) {
        truncated = true;
        break;
      }
      // lstat through the held descriptor: never follows the name, so a
      // symlink reports as a symlink and is dropped below. Nothing is opened.
      let st;
      try {
        st = await fs.lstat(`${dirPath}/${dirent.name}`);
      } catch (err) {
        if (errnoOf(err) === 'ENOENT') {
          skipped++; // deleted since it was listed
          continue;
        }
        throw fail('could not stat a directory entry', err, depth);
      }
      if (!st.isFile() && !st.isDirectory()) {
        skipped++;
        continue;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push({ name: dirent.name, kind: st.isFile() ? 'file' : 'dir' });
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return { kind: 'dir', entries, truncated };
}

async function readPrefix(
  fh: fs.FileHandle,
  limitBytes: number,
  size: number,
  depth: number,
): Promise<WalkReadOutput> {
  // One byte over the cap is what tells "exactly the cap" from "longer"; read
  // until EOF or full, because NFS may return short reads mid-file.
  // The buffer starts at the file's size (plus the probe byte), not at the
  // cap, so a small file never costs a cap-sized allocation; it grows only if
  // the file grew since fstat, and never past the probe.
  const probe = limitBytes + 1;
  let buf = Buffer.allocUnsafe(Math.min(probe, size + 1));
  let filled = 0;
  try {
    while (filled < probe) {
      if (filled === buf.length) {
        const grown = Buffer.allocUnsafe(Math.min(probe, buf.length * 2));
        buf.copy(grown, 0, 0, filled);
        buf = grown;
      }
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
  } catch (err) {
    throw fail('could not read a file', err, depth);
  }
  const truncated = filled > limitBytes;
  return {
    kind: 'file',
    contents: new Uint8Array(buf.subarray(0, truncated ? limitBytes : filled)),
    truncated,
  };
}

/**
 * Read up to `length` bytes from `offset` of the open regular file `fh`, never
 * past `stat.size`, the size its version names. NFS may return short reads
 * mid-file, so read until full or EOF; EOF early means the file shrank.
 */
async function readRange(
  fh: fs.FileHandle,
  stat: BigIntStats,
  offset: number,
  length: number,
  depth: number,
): Promise<WalkRangeOutput> {
  // Opaque to every caller, which only compares it. See the file header.
  const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ':',
  ) as UserFileVersion;
  // In bigint: a sparse file can claim more than 2^53 bytes, and the read
  // must still stop exactly at its size.
  const start = BigInt(offset);
  const left = stat.size > start ? stat.size - start : 0n;
  const want = left < BigInt(length) ? Number(left) : length;
  // Zeroed and an allocation of its own (never Buffer's shared pool), so
  // `bytes.buffer` carries these bytes and nothing else.
  const bytes = new Uint8Array(want);
  let filled = 0;
  try {
    while (filled < want) {
      const { bytesRead } = await fh.read(bytes, filled, want - filled, start + BigInt(filled));
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
  } catch (err) {
    throw fail('could not read a file', err, depth);
  }
  return {
    kind: 'file',
    // Rounded past 2^53 bytes, a size no caller serves anyway.
    size: Number(stat.size),
    version,
    // Short when the file shrank, and never padded out: zeros would pass for
    // the file's own bytes.
    bytes: filled < want ? bytes.slice(0, filled) : bytes,
  };
}

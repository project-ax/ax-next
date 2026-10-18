import { promises as fs, constants } from 'node:fs';
import type { UserFileDirEntry } from '@ax/sandbox-mount-protocol';
import { UserFilesReadError } from './confined-read.js';

// ---------------------------------------------------------------------------
// readConfinedByWalk — a confined reader with no check-then-use window (W3b).
//
// `readConfinedUserFiles` (confined-read.ts) confines by realpath and then
// opens the path again. Between those two steps an agent that writes the tree
// can swap an INTERMEDIATE directory for a symlink, and the second open follows
// it. O_NOFOLLOW only guards the last component. That window is acceptable
// nowhere it can be avoided, and for shared folders (one agent's writes, read
// by the host on behalf of every project member) it is the whole threat.
//
// So this reader never resolves a path at all. It opens the trusted root, then
// opens EACH component relative to the descriptor it already holds, through
// `/proc/<pid>/fd/<fd>/<name>`, with O_NOFOLLOW. The kernel looks up exactly
// one name inside a directory we have pinned; if that name is a symlink at the
// instant of the lookup, the open fails (ELOOP / ENOTDIR). Swapping it a
// microsecond earlier or later changes which answer we give — the real file,
// or absent — but never makes us read through a link. There is no absolute
// path built from the parts anywhere in this file. Same pattern as the storage
// node's `openDirectory` (sandbox-k8s/src/storage-node/confined-directory.ts).
//
// LINUX ONLY: the mechanism is /proc. Elsewhere this throws
// `UserFilesReadError` with code `unsupported-platform` rather than quietly
// answering `absent` for everything (/proc/... would just be ENOENT on macOS).
//
// Decisions worth naming:
//
// - INTERMEDIATE components are opened O_PATH, not O_RDONLY. In production the
//   host (uid 1000) walks through a root-owned `.shared` that is mode 0711:
//   searchable, not readable. O_RDONLY on it is EACCES; O_PATH needs only
//   search permission, which is exactly the right amount of reach. The LEAF is
//   opened O_RDONLY because we read or list it.
// - The LEAF is opened O_NONBLOCK too. A FIFO opened O_RDONLY without it blocks
//   until a writer appears — an agent could park the host's request forever.
//   We open, fstat, and only read a regular file. A FIFO, socket, or device is
//   `absent` (reason `not-file-or-dir`): nothing a file browser serves, and
//   saying "absent" matches `readConfinedUserFiles`.
// - Symlinks (and FIFOs, sockets, devices) in a LISTING are omitted, never
//   named, and never opened. Each child is lstat'd through the held directory
//   descriptor — lstat does not follow the final component — and only regular
//   files and directories are kept.
// - "Absent" carries a `reason` for the caller's LOG. A caller must not echo
//   it to a client: telling "this is a symlink" apart from "this is missing" is
//   a free oracle about a tree the reader may not otherwise see.
// - Everything else that fails (EACCES, EIO, ESTALE, …) THROWS
//   `WalkReadError` with the errno and the depth it failed at. A broken read is
//   not an absence (TASK-403). Callers map e.g. EACCES at `.shared` to
//   `unavailable`.
// ---------------------------------------------------------------------------

/** No more path components than this, root excluded. */
export const MAX_WALK_PARTS = 32;

/** Ceiling on `limitBytes`: the largest read any caller may ask for (a 10 MiB download plus slack). */
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

/** A listing entry: `UserFileDirEntry` plus, for files, size and mtime. */
export interface WalkDirEntry extends UserFileDirEntry {
  /** Bytes on disk (files only). */
  size?: number;
  /** Last modification, ISO-8601 (files only). */
  updatedAt?: string;
}

/**
 * Why a path is absent — for the caller's log ONLY, never a client response.
 * - `missing`: a component does not exist (ENOENT).
 * - `link-or-not-dir`: a component is a symlink, or a non-directory where a
 *   directory was needed (ELOOP / ENOTDIR).
 * - `not-file-or-dir`: the leaf is a FIFO, socket, or device.
 */
export type WalkAbsentReason = 'missing' | 'link-or-not-dir' | 'not-file-or-dir';

/** Same discriminants as `ReadUserFilesOutput` (minus `unavailable`, the caller's call). */
export type WalkReadOutput =
  | { kind: 'file'; contents: Uint8Array; truncated: boolean; size: number }
  | { kind: 'dir'; entries: WalkDirEntry[]; truncated: boolean }
  | { kind: 'absent'; reason: WalkAbsentReason };

export interface WalkReadLimits {
  /** Most bytes of a file returned; a longer file is a prefix with `truncated`. */
  limitBytes: number;
  /** Most entries in a listing; more sets `truncated`. */
  maxEntries: number;
}

function assertSafePart(part: string): void {
  if (part === '' || part === '.' || part === '..' || part.includes('/') || part.includes('\0')) {
    throw new WalkPathError(`unsafe path component: ${JSON.stringify(part)}`);
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

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
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

const fdPath = (fd: number): string => `/proc/${process.pid}/fd/${fd}`;

/**
 * Read `parts` under the trusted `root`, opening every component relative to
 * the previous one's descriptor with O_NOFOLLOW. See the file header.
 *
 * `root` is the only path opened by name, and it MAY be a symlink (it is
 * trusted configuration, not agent-written). `parts` is untrusted.
 */
export async function readConfinedByWalk(
  root: string,
  parts: string[],
  opts: WalkReadLimits,
): Promise<WalkReadOutput> {
  if (parts.length > MAX_WALK_PARTS) throw new WalkPathError('path is too deep');
  parts.forEach(assertSafePart);
  if (!Number.isSafeInteger(opts.limitBytes) || opts.limitBytes < 0 || opts.limitBytes > MAX_WALK_LIMIT_BYTES) {
    throw new RangeError(`limitBytes must be an integer from 0 to ${MAX_WALK_LIMIT_BYTES}`);
  }
  if (!Number.isSafeInteger(opts.maxEntries) || opts.maxEntries < 1 || opts.maxEntries > MAX_WALK_ENTRIES) {
    throw new RangeError(`maxEntries must be an integer from 1 to ${MAX_WALK_ENTRIES}`);
  }
  if (process.platform !== 'linux') {
    throw new WalkReadError('readConfinedByWalk needs Linux /proc', {
      code: 'unsupported-platform',
      depth: -1,
    });
  }

  const held: fs.FileHandle[] = [];
  try {
    // The root: trusted, so no O_NOFOLLOW. O_PATH when we only pass through it.
    try {
      held.push(
        await fs.open(
          root,
          constants.O_DIRECTORY | (parts.length > 0 ? O_PATH : constants.O_RDONLY),
        ),
      );
    } catch (err) {
      throw fail('could not open the walk root', err, -1);
    }

    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      const flags =
        constants.O_NOFOLLOW |
        (leaf ? constants.O_RDONLY | constants.O_NONBLOCK : O_PATH | constants.O_DIRECTORY);
      try {
        held.push(await fs.open(`${fdPath(held.at(-1)!.fd)}/${parts[i]}`, flags));
      } catch (err) {
        const reason = absentReason(errnoOf(err));
        if (reason !== undefined) return { kind: 'absent', reason };
        throw fail('could not open a path component', err, i);
      }
    }

    const leaf = held.at(-1)!;
    const depth = parts.length - 1;
    let stat;
    try {
      stat = await leaf.stat();
    } catch (err) {
      throw fail('could not stat the leaf', err, depth);
    }
    if (stat.isDirectory()) return await listDir(leaf.fd, opts.maxEntries, depth);
    if (stat.isFile()) return await readPrefix(leaf, opts.limitBytes, stat.size, depth);
    return { kind: 'absent', reason: 'not-file-or-dir' };
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
  const entries: WalkDirEntry[] = [];
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
      entries.push(
        st.isFile()
          ? { name: dirent.name, kind: 'file', size: st.size, updatedAt: st.mtime.toISOString() }
          : { name: dirent.name, kind: 'dir' },
      );
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
    size,
  };
}

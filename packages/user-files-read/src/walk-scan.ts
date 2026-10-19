import { promises as fs, constants } from 'node:fs';
import {
  MAX_WALK_ENTRIES,
  MAX_WALK_PARTS,
  MAX_WALK_SKIPPED,
  WalkPathError,
  WalkReadError,
  splitRelPath,
  type WalkAbsentReason,
} from './walk-read.js';

// ---------------------------------------------------------------------------
// scanConfinedByWalk — a recursive, confined STAT of one folder (W3d).
//
// File history needs to know what changed in a shared folder since the last
// look: every regular file's size, mtime and inode. The folder is written by
// agents, so this is the same threat as `readConfinedByWalk` and the same
// answer: no path is ever resolved. The trusted root is opened by name; the
// base components and then every directory under them are opened relative to
// the descriptor we already hold, through `/proc/<pid>/fd/<fd>/<name>`, with
// O_NOFOLLOW. A directory an agent swaps for a symlink between our listing and
// our open fails that open (ELOOP / ENOTDIR) and is skipped, never followed.
//
// Decisions worth naming:
//
// - Files are never OPENED. Each entry is `lstat`ed through the held
//   directory's descriptor, which does not follow the final name, so a
//   symlink reports as a symlink. Only regular files are reported; symlinks,
//   FIFOs, sockets and devices are skipped and count toward
//   `MAX_WALK_SKIPPED`. Nothing here can block on a FIFO.
// - Depth-first, and a directory's listing is closed before we descend into
//   its children. So at most one listing plus one descriptor per level is
//   open at a time: the walk holds `MAX_WALK_PARTS + 2` descriptors at worst.
// - Depth: a file's components below the root, base included, never exceed
//   `MAX_WALK_PARTS`, so every path this reports can be read back with
//   `readConfinedByWalk(root, [...baseParts, ...path.split('/')])`. A deeper
//   directory is not entered and the result is `truncated`.
// - Caps, all of which set `truncated` and stop (or, for depth, prune):
//   `maxEntries` files (default and ceiling `MAX_WALK_ENTRIES`),
//   `MAX_WALK_ENTRIES` directories, `MAX_WALK_SKIPPED` skipped entries. So a
//   folder an agent filled with a million names costs a bounded number of
//   stats. When `truncated`, a file missing from the answer may still exist:
//   a caller MUST NOT read the absence as a delete.
// - `mtimeMs` is Node's `Stats.mtimeMs`: milliseconds with the nanoseconds as
//   a fraction (as precise as a double allows). `ino` is a double too. Both
//   are deterministic for a given stat, which is what a change check needs.
// - The output is sorted by path (code-unit order), so two scans of the same
//   tree are identical and diffing is deterministic.
// - Absent BASE (a missing `.shared` or folder, or a link there) answers
//   `absent` with a reason for the caller's log. Every other failure (EACCES,
//   EIO, ...) THROWS `WalkReadError` with the errno and depth, like the reader:
//   a scan that failed is not an empty folder.
//
// LINUX ONLY, like the reader.
// ---------------------------------------------------------------------------

/** One regular file found by a scan. `path` is relative to the scanned folder, `/`-separated. */
export interface WalkScannedFile {
  path: string;
  /** Bytes on disk. */
  size: number;
  /** Last modification in ms since the epoch, with sub-ms precision when the filesystem has it. */
  mtimeMs: number;
  /** Inode number. */
  ino: number;
}

export type WalkScanOutput =
  | { kind: 'done'; files: WalkScannedFile[]; truncated: boolean }
  | { kind: 'absent'; reason: WalkAbsentReason };

export interface WalkScanLimits {
  /** Most files reported; more sets `truncated`. Default and ceiling: `MAX_WALK_ENTRIES`. */
  maxEntries?: number;
}

/** Most directories one scan enters. */
export const MAX_SCAN_DIRS = MAX_WALK_ENTRIES;

const O_PATH = (constants as Record<string, number | undefined>)['O_PATH'] ?? 0o10000000;
const DIR_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const fdPath = (fd: number): string => `/proc/${process.pid}/fd/${fd}`;

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function absentReason(code: string | undefined): WalkAbsentReason | undefined {
  if (code === 'ENOENT') return 'missing';
  if (code === 'ELOOP' || code === 'ENOTDIR') return 'link-or-not-dir';
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

interface ScanState {
  files: WalkScannedFile[];
  maxEntries: number;
  dirs: number;
  skipped: number;
  truncated: boolean;
  /** Set when a cap ends the whole scan (depth only prunes). */
  stopped: boolean;
}

/** Count one skipped entry; stops the scan once the cap is passed. */
function skip(state: ScanState): void {
  state.skipped++;
  if (state.skipped > MAX_WALK_SKIPPED) {
    state.truncated = true;
    state.stopped = true;
  }
}

/**
 * Stat every regular file under `root/baseParts...`, recursively, opening
 * every component relative to the previous one's descriptor with O_NOFOLLOW.
 * See the file header.
 *
 * `root` is the only path opened by name, and it MAY be a symlink (trusted
 * configuration). `baseParts` and everything below them are untrusted.
 */
export async function scanConfinedByWalk(
  root: string,
  baseParts: string[],
  opts: WalkScanLimits = {},
): Promise<WalkScanOutput> {
  // The folder's own files sit one level below it, so it can be at most
  // MAX_WALK_PARTS - 1 deep.
  if (baseParts.length >= MAX_WALK_PARTS) throw new WalkPathError('path is too deep');
  for (const part of baseParts) {
    // One definition of a safe component: splitRelPath's. A part that splits
    // into anything but itself has a `/` (or is empty).
    if (splitRelPath(part).length !== 1) {
      throw new WalkPathError(`unsafe path component: ${JSON.stringify(part)}`);
    }
  }
  const maxEntries = opts.maxEntries ?? MAX_WALK_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_WALK_ENTRIES) {
    throw new RangeError(`maxEntries must be an integer from 1 to ${MAX_WALK_ENTRIES}`);
  }
  if (process.platform !== 'linux') {
    throw new WalkReadError('scanConfinedByWalk needs Linux /proc', {
      code: 'unsupported-platform',
      depth: -1,
    });
  }

  const held: fs.FileHandle[] = [];
  try {
    try {
      held.push(
        await fs.open(
          root,
          constants.O_DIRECTORY | (baseParts.length > 0 ? O_PATH : constants.O_RDONLY),
        ),
      );
    } catch (err) {
      throw fail('could not open the walk root', err, -1);
    }
    for (let i = 0; i < baseParts.length; i++) {
      // Intermediates O_PATH (search only, so the host can pass a 0711
      // `.shared`); the folder itself O_RDONLY, because we list it.
      const flags =
        i === baseParts.length - 1 ? DIR_FLAGS : O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      try {
        held.push(await fs.open(`${fdPath(held.at(-1)!.fd)}/${baseParts[i]}`, flags));
      } catch (err) {
        const reason = absentReason(errnoOf(err));
        if (reason !== undefined) return { kind: 'absent', reason };
        throw fail('could not open a path component', err, i);
      }
    }

    const state: ScanState = {
      files: [],
      maxEntries,
      dirs: 0,
      skipped: 0,
      truncated: false,
      stopped: false,
    };
    await scanDir(held.at(-1)!.fd, '', baseParts.length, state);
    state.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { kind: 'done', files: state.files, truncated: state.truncated };
  } finally {
    for (const fh of held.reverse()) await fh.close().catch(() => undefined);
  }
}

/**
 * Scan one held directory. `prefix` is its path relative to the folder ('' for
 * the folder itself, else ending in '/'); `depth` is how many components
 * below the root it sits (base included).
 */
async function scanDir(dirFd: number, prefix: string, depth: number, state: ScanState): Promise<void> {
  const dirPath = fdPath(dirFd);
  const subdirs: string[] = [];

  // Streamed, never `readdir`, and closed before we descend.
  let dir;
  try {
    dir = await fs.opendir(dirPath, { bufferSize: 64 });
  } catch (err) {
    throw fail('could not list a directory', err, depth - 1);
  }
  try {
    for (;;) {
      let dirent;
      try {
        dirent = await dir.read();
      } catch (err) {
        throw fail('could not list a directory', err, depth - 1);
      }
      if (dirent === null) break;
      let st;
      try {
        st = await fs.lstat(`${dirPath}/${dirent.name}`);
      } catch (err) {
        if (errnoOf(err) === 'ENOENT') {
          skip(state); // deleted since it was listed
          if (state.stopped) return;
          continue;
        }
        throw fail('could not stat a directory entry', err, depth);
      }
      if (st.isFile()) {
        if (state.files.length >= state.maxEntries) {
          state.truncated = true;
          state.stopped = true;
          return;
        }
        state.files.push({
          path: `${prefix}${dirent.name}`,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ino: st.ino,
        });
      } else if (st.isDirectory()) {
        if (depth + 1 >= MAX_WALK_PARTS) {
          // Its files would sit deeper than MAX_WALK_PARTS: not entered.
          state.truncated = true;
          continue;
        }
        if (state.dirs >= MAX_SCAN_DIRS) {
          state.truncated = true;
          state.stopped = true;
          return;
        }
        state.dirs++;
        subdirs.push(dirent.name);
      } else {
        skip(state); // symlink, FIFO, socket, device
        if (state.stopped) return;
      }
    }
  } finally {
    await dir.close().catch(() => undefined);
  }

  for (const name of subdirs) {
    if (state.stopped) return;
    let child: fs.FileHandle;
    try {
      // O_NOFOLLOW on the one name, inside the directory we hold: if it was
      // swapped for a link since we listed it, this fails and we skip it.
      child = await fs.open(`${dirPath}/${name}`, DIR_FLAGS);
    } catch (err) {
      if (absentReason(errnoOf(err)) !== undefined) {
        skip(state);
        continue;
      }
      throw fail('could not open a directory', err, depth);
    }
    try {
      await scanDir(child.fd, `${prefix}${name}/`, depth + 1, state);
    } finally {
      await child.close().catch(() => undefined);
    }
  }
}

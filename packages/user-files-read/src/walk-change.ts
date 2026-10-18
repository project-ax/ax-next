import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type {
  SharedFolderChange,
  SharedFolderChangeOutcome,
  SharedFolderChangeResult,
} from '@ax/sandbox-mount-protocol';
import { UserFilesReadError } from './confined-read.js';
import { MAX_WALK_PARTS, WalkPathError, WalkReadError, splitRelPath } from './walk-read.js';

// ---------------------------------------------------------------------------
// changeConfinedByWalk — the confined WRITER beside `readConfinedByWalk` (W3c).
//
// One implementation for both providers: the k8s storage node (root, chowns
// what it creates to the agent uid) and the subprocess provider (no chown).
// The difference is injected as `opts.chown`.
//
// Same mechanism as the reader, and for the same reason: an agent writes this
// tree freely and can swap any directory for a symlink at any moment. So no
// path is ever resolved. The trusted root is opened by name; every component
// after it is opened (or created, then opened) relative to the descriptor we
// already hold, through `/proc/<pid>/fd/<fd>/<name>`, with O_NOFOLLOW. Every
// mutating call (create, link, rename, unlink, rmdir) names exactly ONE
// component inside a held directory, so a link planted anywhere above it is
// either refused at its open or irrelevant.
//
// Decisions worth naming:
//
// - Base components other than the last are opened O_PATH (search only: the
//   host can pass a root-owned 0711 `.shared`). The base itself and every
//   directory under it are opened O_RDONLY: we fsync them, and fchown/fchmod
//   need a real descriptor.
// - We only ever chown/chmod a descriptor we opened with O_NOFOLLOW, so a
//   planted link can never redirect an ownership change. If an agent swaps a
//   directory we just created for another directory, we chown THAT one — a
//   directory inside the folder, which is harmless.
// - Writes are temp file + rename in the target directory, so a reader sees
//   the old bytes or the new ones, never half. rename() replaces a symlink
//   leaf as a NAME, it never writes through it.
// - `ifAbsent` is link(temp, target): it fails EEXIST on any existing name
//   (even a dangling link), so it can never overwrite, whatever races it.
// - `ifMatch` is checked AFTER the temp file is written, right before the
//   rename, to keep the window small. Still best effort: no lock is held.
// - A refusal THROWS `WalkChangeError` carrying the results applied so far.
//   Only a `conflict` is an answer: it stops the batch and is returned.
//
// LINUX ONLY, like the reader.
// ---------------------------------------------------------------------------

// A deliberate COPY of the hook contract's `SHARED_FOLDER_CHANGE_MAX_*`
// (@ax/sandbox-mount-protocol): the lint allows only type imports from it.
// Both test files pin the same numbers.
/** Hard ceiling on `maxChanges`. */
export const MAX_CHANGE_COUNT = 64;
/** Hard ceiling on `maxFileBytes`: one written file. */
export const MAX_CHANGE_FILE_BYTES = 10 * 1024 * 1024;
/** Hard ceiling on `maxTotalBytes`: all written content in one call. */
export const MAX_CHANGE_TOTAL_BYTES = 25 * 1024 * 1024;

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
const BASE_MODE = 0o700;
const TEMP_PREFIX = '.ax-tmp-';
const SHA256_HEX = /^[0-9a-f]{64}$/;

const O_PATH = (constants as Record<string, number | undefined>)['O_PATH'] ?? 0o10000000;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** The hook's change / outcome / result shapes, unchanged: the walk IS its realization. */
export type ConfinedChange = SharedFolderChange;
export type ChangeOutcome = SharedFolderChangeOutcome;
export type ChangeResult = SharedFolderChangeResult;

export interface ChangeConfinedOptions {
  /** Create the LAST base component (0700) if it is missing. Its parents must exist. */
  createBase?: boolean;
  /** Called with a descriptor for every file and directory this call creates. */
  chown?: (fd: number) => void;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxChanges: number;
}

/**
 * Why a change was refused (as opposed to a storage failure, which is a
 * `WalkReadError` carrying the errno). `index` is the change that was
 * refused (`-1`: the whole call or the base); `applied` lists the changes
 * that already took effect before it, in order.
 */
export type WalkChangeErrorCode =
  | 'too-large'
  | 'too-many-changes'
  | 'invalid-change'
  | 'link-or-not-dir'
  | 'not-empty'
  | 'is-directory';

export class WalkChangeError extends UserFilesReadError {
  declare readonly code: WalkChangeErrorCode;
  readonly index: number;
  readonly applied: ChangeResult[];
  constructor(
    message: string,
    options: { code: WalkChangeErrorCode; index: number; applied?: ChangeResult[]; cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WalkChangeError';
    this.index = options.index;
    this.applied = options.applied ?? [];
  }
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

const fdPath = (fd: number): string => `/proc/${process.pid}/fd/${fd}`;

/** Thrown inside one change; the driver adds `index` / `applied`. */
class Refusal extends Error {
  constructor(
    readonly code: WalkChangeErrorCode,
    message: string,
    readonly inner?: unknown,
  ) {
    super(message);
  }
}

function storageFail(what: string, err: unknown, depth: number): WalkReadError {
  const code = errnoOf(err);
  return new WalkReadError(`${what}${code === undefined ? '' : ` (${code})`}`, {
    cause: err,
    depth,
    ...(code === undefined ? {} : { code }),
  });
}

/** ELOOP / ENOTDIR on an O_NOFOLLOW|O_DIRECTORY open: a link or a file where a directory goes. */
function walkFail(err: unknown, depth: number): Error {
  const code = errnoOf(err);
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    return new Refusal('link-or-not-dir', 'a path component is a symlink or not a directory', err);
  }
  return storageFail('could not open a path component', err, depth);
}

function closeAll(fds: number[]): void {
  for (const fd of fds.splice(0).reverse()) {
    try {
      closeSync(fd);
    } catch {
      // nothing useful to do
    }
  }
}

/** Open `name` under `dirFd` as a directory, creating it (mode, then chown) if missing. */
function openOrCreateDir(
  dirFd: number,
  name: string,
  depth: number,
  mode: number,
  chown: ((fd: number) => void) | undefined,
): { fd: number; created: boolean } {
  const path = `${fdPath(dirFd)}/${name}`;
  try {
    return { fd: openSync(path, DIR_FLAGS), created: false };
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw walkFail(err, depth);
  }
  let created = true;
  try {
    mkdirSync(path, { mode });
  } catch (err) {
    // Someone else made it between our open and mkdir: just use it.
    if (errnoOf(err) !== 'EEXIST') throw storageFail('could not create a directory', err, depth);
    created = false;
  }
  let fd: number;
  try {
    fd = openSync(path, DIR_FLAGS);
  } catch (err) {
    throw walkFail(err, depth);
  }
  if (created) {
    try {
      fchmodSync(fd, mode); // umask-independent
      chown?.(fd);
    } catch (err) {
      closeSync(fd);
      throw storageFail('could not set a new directory owner', err, depth);
    }
  }
  return { fd, created };
}

/**
 * Walk `parts` below the held `baseFd`. With `create`, missing directories
 * are made (DIR_MODE, then chown). Returns the held descriptors (last is the
 * target) — or `undefined` if a component is missing and `create` is off.
 */
function walkDirs(
  baseFd: number,
  parts: string[],
  create: boolean,
  chown: ((fd: number) => void) | undefined,
  depthOffset: number,
): { fds: number[]; leafCreated: boolean } | undefined {
  const fds: number[] = [];
  let leafCreated = false;
  try {
    let dir = baseFd;
    for (let i = 0; i < parts.length; i++) {
      const depth = depthOffset + i;
      if (create) {
        const opened = openOrCreateDir(dir, parts[i]!, depth, DIR_MODE, chown);
        fds.push(opened.fd);
        leafCreated = opened.created;
      } else {
        try {
          fds.push(openSync(`${fdPath(dir)}/${parts[i]}`, DIR_FLAGS));
        } catch (err) {
          if (errnoOf(err) === 'ENOENT') {
            closeAll(fds);
            return undefined;
          }
          throw walkFail(err, depth);
        }
      }
      dir = fds.at(-1)!;
    }
    return { fds, leafCreated };
  } catch (err) {
    closeAll(fds);
    throw err;
  }
}

/** sha256 of the regular file `name` under `dirFd`, or `undefined` if it isn't one (or is too big to be a match). */
function hashExisting(dirFd: number, name: string, maxBytes: number, depth: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(
      `${fdPath(dirFd)}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = errnoOf(err);
    // Missing, a link, or a socket: nothing a caller could have hashed.
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENXIO') return undefined;
    throw storageFail('could not open the current file', err, depth);
  }
  try {
    const st = fstatSync(fd);
    // A file bigger than any write could not be the base of this write.
    if (!st.isFile() || st.size > maxBytes) return undefined;
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return undefined; // grew since fstat
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } catch (err) {
    throw storageFail('could not hash the current file', err, depth);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, content: Uint8Array): void {
  let off = 0;
  while (off < content.length) off += writeSync(fd, content, off, content.length - off);
}

function applyWrite(
  baseFd: number,
  parts: string[],
  change: Extract<ConfinedChange, { op: 'write' }>,
  opts: ChangeConfinedOptions,
  depthOffset: number,
): ChangeOutcome {
  const walked = walkDirs(baseFd, parts.slice(0, -1), true, opts.chown, depthOffset)!;
  const dirFd = walked.fds.at(-1) ?? baseFd;
  const dir = fdPath(dirFd);
  const name = parts.at(-1)!;
  const depth = depthOffset + parts.length - 1;
  const temp = `${dir}/${TEMP_PREFIX}${randomBytes(8).toString('hex')}`;
  let tempExists = false;
  try {
    let fd: number;
    try {
      fd = openSync(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        FILE_MODE,
      );
    } catch (err) {
      throw storageFail('could not create a temp file', err, depth);
    }
    tempExists = true;
    try {
      fchmodSync(fd, FILE_MODE);
      opts.chown?.(fd);
      writeAll(fd, change.content);
      fsyncSync(fd);
    } catch (err) {
      throw storageFail('could not write a temp file', err, depth);
    } finally {
      closeSync(fd);
    }

    let outcome: ChangeOutcome;
    if (change.ifAbsent) {
      try {
        linkSync(temp, `${dir}/${name}`);
      } catch (err) {
        if (errnoOf(err) === 'EEXIST') return 'exists';
        throw storageFail('could not link the new file', err, depth);
      }
      outcome = 'created';
      // The target now holds the bytes; the temp name goes in the finally.
    } else {
      if (change.ifMatch !== undefined) {
        const current = hashExisting(dirFd, name, opts.maxFileBytes, depth);
        if (current !== change.ifMatch) return 'conflict';
      }
      let existed: boolean;
      try {
        const st = lstatSync(`${dir}/${name}`);
        if (st.isDirectory()) throw new Refusal('is-directory', 'a directory is in the way of a write');
        existed = true;
      } catch (err) {
        if (err instanceof Refusal) throw err;
        if (errnoOf(err) !== 'ENOENT') throw storageFail('could not stat the target', err, depth);
        existed = false;
      }
      try {
        renameSync(temp, `${dir}/${name}`);
      } catch (err) {
        const code = errnoOf(err);
        if (code === 'EISDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') {
          throw new Refusal('is-directory', 'a directory is in the way of a write', err);
        }
        throw storageFail('could not rename the new file into place', err, depth);
      }
      tempExists = false;
      outcome = existed ? 'written' : 'created';
    }
    try {
      fsyncSync(dirFd);
    } catch (err) {
      throw storageFail('could not sync a directory', err, depth);
    }
    return outcome;
  } finally {
    if (tempExists) {
      try {
        unlinkSync(temp);
      } catch {
        // best effort: the name is ours alone (O_EXCL, random) and harmless
      }
    }
    closeAll(walked.fds);
  }
}

function applyMkdir(
  baseFd: number,
  parts: string[],
  opts: ChangeConfinedOptions,
  depthOffset: number,
): ChangeOutcome {
  if (parts.length === 0) return 'exists';
  const walked = walkDirs(baseFd, parts, true, opts.chown, depthOffset)!;
  try {
    if (walked.leafCreated) {
      // The new name lives in the parent: sync that.
      const parent = walked.fds.at(-2) ?? baseFd;
      try {
        fsyncSync(parent);
      } catch (err) {
        throw storageFail('could not sync a directory', err, depthOffset + parts.length - 1);
      }
    }
    return walked.leafCreated ? 'created' : 'exists';
  } finally {
    closeAll(walked.fds);
  }
}

function applyDelete(baseFd: number, parts: string[], depthOffset: number): ChangeOutcome {
  const walked = walkDirs(baseFd, parts.slice(0, -1), false, undefined, depthOffset);
  if (walked === undefined) return 'absent';
  const dirFd = walked.fds.at(-1) ?? baseFd;
  const target = `${fdPath(dirFd)}/${parts.at(-1)!}`;
  const depth = depthOffset + parts.length - 1;
  try {
    let isDir: boolean;
    try {
      // lstat: a symlink leaf is a link to remove, never followed.
      isDir = lstatSync(target).isDirectory();
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') return 'absent';
      throw storageFail('could not stat the target', err, depth);
    }
    try {
      if (isDir) rmdirSync(target);
      else unlinkSync(target);
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ENOENT') return 'absent';
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw new Refusal('not-empty', 'only an empty directory can be deleted', err);
      }
      throw storageFail('could not delete', err, depth);
    }
    try {
      fsyncSync(dirFd);
    } catch (err) {
      throw storageFail('could not sync a directory', err, depth);
    }
    return 'deleted';
  } finally {
    closeAll(walked.fds);
  }
}

function assertLimit(name: string, value: number, ceiling: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`${name} must be an integer from 1 to ${ceiling}`);
  }
}

function invalid(message: string, index: number): WalkChangeError {
  return new WalkChangeError(message, { code: 'invalid-change', index });
}

/** Every check that needs no disk: shapes, caps, and every path. Returns each change's parts. */
function validate(baseParts: string[], changes: ConfinedChange[], opts: ChangeConfinedOptions): string[][] {
  assertLimit('maxChanges', opts.maxChanges, MAX_CHANGE_COUNT);
  assertLimit('maxFileBytes', opts.maxFileBytes, MAX_CHANGE_FILE_BYTES);
  assertLimit('maxTotalBytes', opts.maxTotalBytes, MAX_CHANGE_TOTAL_BYTES);
  if (baseParts.length > MAX_WALK_PARTS) throw new WalkPathError('base path is too deep');
  for (const part of baseParts) {
    // One element each: splitRelPath on a lone part refuses '', '.', '..', '/', NUL.
    if (part === '' || splitRelPath(part).length !== 1) throw new WalkPathError('unsafe base component');
  }
  if (opts.createBase && baseParts.length === 0) {
    throw new WalkPathError('createBase needs a base component to create');
  }
  if (!Array.isArray(changes)) throw invalid('changes must be an array', -1);
  if (changes.length > opts.maxChanges) {
    throw new WalkChangeError(`more than ${opts.maxChanges} changes`, { code: 'too-many-changes', index: -1 });
  }
  let total = 0;
  return changes.map((change, i) => {
    if (typeof change?.path !== 'string') throw invalid('a change needs a path', i);
    const parts = splitRelPath(change.path);
    if (baseParts.length + parts.length > MAX_WALK_PARTS) throw new WalkPathError('path is too deep');
    switch (change.op) {
      case 'write': {
        if (parts.length === 0) throw new WalkPathError('a write needs a file name');
        if (!(change.content instanceof Uint8Array)) throw invalid('write content must be bytes', i);
        if (change.content.length > opts.maxFileBytes) {
          throw new WalkChangeError('a file is too large', { code: 'too-large', index: i });
        }
        total += change.content.length;
        if (total > opts.maxTotalBytes) {
          throw new WalkChangeError('the changes are too large', { code: 'too-large', index: i });
        }
        if (change.ifMatch !== undefined && !SHA256_HEX.test(change.ifMatch)) {
          throw invalid('ifMatch must be a lowercase sha256 hex digest', i);
        }
        if (change.ifMatch !== undefined && change.ifAbsent) {
          throw invalid('ifMatch and ifAbsent cannot both be set', i);
        }
        break;
      }
      case 'mkdir':
        break;
      case 'delete':
        if (parts.length === 0) throw new WalkPathError('a delete needs a name');
        break;
      default:
        throw invalid('unknown change op', i);
    }
    return parts;
  });
}

/** Open the trusted root, then `baseParts` below it (the last one created if `createBase`). */
function openBase(root: string, baseParts: string[], opts: ChangeConfinedOptions): number[] {
  const fds: number[] = [];
  try {
    try {
      // The root is trusted configuration and may be a symlink: no O_NOFOLLOW.
      fds.push(
        openSync(
          root,
          constants.O_DIRECTORY | (baseParts.length > 0 ? O_PATH : constants.O_RDONLY),
        ),
      );
    } catch (err) {
      throw storageFail('could not open the walk root', err, -1);
    }
    for (let i = 0; i < baseParts.length; i++) {
      const last = i === baseParts.length - 1;
      const path = `${fdPath(fds.at(-1)!)}/${baseParts[i]}`;
      if (last && opts.createBase) {
        fds.push(openOrCreateDir(fds.at(-1)!, baseParts[i]!, i, BASE_MODE, opts.chown).fd);
        continue;
      }
      try {
        fds.push(
          openSync(path, last ? DIR_FLAGS : O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW),
        );
      } catch (err) {
        if (errnoOf(err) === 'ENOENT') throw storageFail('the base does not exist', err, i);
        throw walkFail(err, i);
      }
    }
    return fds;
  } catch (err) {
    closeAll(fds);
    throw err;
  }
}

/**
 * Apply `changes`, in order, under `root` + `baseParts`. See the file header.
 *
 * `root` is trusted; `baseParts` is the caller's (e.g. `['.shared', id]`);
 * every change `path` is untrusted, relative to the base, and validated
 * before the disk is touched. Stops at the first `conflict` and returns the
 * results up to and including it.
 *
 * Throws `WalkPathError` (bad path), `RangeError` (bad limits),
 * `WalkChangeError` (refused: caps, a link or a file in the path, a
 * non-empty directory, a directory in the way), or `WalkReadError` (the
 * storage failed; `code` is the errno, `ENOENT` for a missing base).
 */
export function changeConfinedByWalk(
  root: string,
  baseParts: string[],
  changes: ConfinedChange[],
  opts: ChangeConfinedOptions,
): ChangeResult[] {
  const allParts = validate(baseParts, changes, opts);
  if (process.platform !== 'linux') {
    throw new WalkReadError('changeConfinedByWalk needs Linux /proc', {
      code: 'unsupported-platform',
      depth: -1,
    });
  }

  let baseFds: number[];
  try {
    baseFds = openBase(root, baseParts, opts);
  } catch (err) {
    if (err instanceof Refusal) {
      throw new WalkChangeError(err.message, { code: err.code, index: -1, cause: err.inner });
    }
    throw err;
  }
  const baseFd = baseFds.at(-1)!;
  const results: ChangeResult[] = [];
  try {
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]!;
      const parts = allParts[i]!;
      let outcome: ChangeOutcome;
      try {
        switch (change.op) {
          case 'write':
            outcome = applyWrite(baseFd, parts, change, opts, baseParts.length);
            break;
          case 'mkdir':
            outcome = applyMkdir(baseFd, parts, opts, baseParts.length);
            break;
          case 'delete':
            outcome = applyDelete(baseFd, parts, baseParts.length);
            break;
          default:
            throw invalid('unknown change op', i); // unreachable: validate() refused it
        }
      } catch (err) {
        if (err instanceof Refusal) {
          throw new WalkChangeError(err.message, {
            code: err.code,
            index: i,
            applied: results,
            cause: err.inner,
          });
        }
        throw err;
      }
      results.push({ path: change.path, outcome });
      if (outcome === 'conflict') break;
    }
    return results;
  } finally {
    closeAll(baseFds);
  }
}

import * as path from 'node:path';
import type { ReadUserFilesOutput } from '@ax/sandbox-mount-protocol';
import {
  MAX_WALK_PARTS,
  WalkReadError,
  readConfinedByWalk,
  splitRelPath,
} from './walk-read.js';

// ---------------------------------------------------------------------------
// @ax/user-files-read — ONE confined reader for an agent's durable user-files
// subtree, shared by every realization of `sandbox:read-user-files`.
//
// This is a pure library: no manifest, no hooks, no @ax/core dependency. It
// exists because the same path confinement was about to be written a THIRD
// time. It was shell inside the k8s one-shot reader pod
// (`buildReadCommand`), TypeScript in @ax/sandbox-subprocess, and the
// host-mounted k8s read would have been a third copy. Path confinement is the
// load-bearing cross-tenant property on this surface; three copies of it means
// three places a fix has to land and two places it silently doesn't.
//
// WHAT IT IS NOT: it does not resolve mounts, call the bus, or know what an
// agent is. It takes a root directory that the CALLER has already decided this
// request is entitled to read, and a caller-supplied relative path, and it
// answers with the `ReadUserFilesOutput` shape. Deciding WHICH root — the ACL —
// stays with the caller, because that is where the identity is.
//
// THE THREAT MODEL, stated plainly. The root's whole contents are written by an
// untrusted agent. It can plant a symlink anywhere in its own subtree
// (`notes -> /export/some-other-agent`, or `-> /`), at any depth, and it can
// swap one in at any moment — including between two of our own steps. So:
//
//   1. LEXICAL guard on the caller's relPath — absolute paths and `..` segments
//      throw. Necessary, nowhere near sufficient: it does not look at the disk.
//   2. THE WALK (walk-read.ts). No path is ever resolved and then opened again,
//      so there is no check-then-use window to win. The root is opened once,
//      and every component below it is opened relative to the directory
//      descriptor already held, with O_NOFOLLOW. A component that is a symlink
//      at the instant of its lookup fails the open — whether the link points
//      outside the subtree or inside it, because where a link points is never
//      looked at.
//   3. NEVER SERVED, NEVER NAMED. Symlinks, FIFOs, sockets and devices are not
//      served, and a listing does not name them. A name we hand back is a name
//      the client will ask us to open; offering one that points somewhere we
//      would refuse to read is an invitation to probe.
//
// A MISS IS `{ kind: 'absent' }` AND NOTHING ELSE. A link and a missing file
// must look the same: a 400-vs-404 split on a path is a free oracle for mapping
// someone else's subtree, and "absent" is also simply true from the caller's
// side — this surface does not have that file. The walk records why a path was
// absent (its `reason`), for tests and diagnostics; this adapter drops it on
// purpose, and nothing logs it. A path deeper than MAX_WALK_PARTS components,
// or with a segment longer than a filename may be, is absent too: both depend
// only on the path's text.
//
// A BROKEN READ IS NOT AN ABSENCE (TASK-403). `absent` used to swallow the
// storage failing too: a listing that came back `EIO` or `ESTALE` — the
// ordinary way an NFS export tells you it is having a bad day — answered
// exactly like a directory the agent never created, and the Files tab told the
// reader their agent had written nothing. So a path that VANISHED is `absent`
// (see `VANISHED_ERRNOS`), and every other errno throws `UserFilesReadError`,
// ESTALE included. ESTALE is also how NFS reports a folder the walk holds
// being replaced or deleted by the agent, so the walk retries it once itself,
// with opens that make NFS look again (walk-read.ts). A replaced folder is
// then served, a deleted one comes back ENOENT and is absent, and ESTALE that
// survives the retry throws, because that means an export that went stale, or
// a folder the agent is rewriting faster than a read finishes. Telling these apart costs no secrecy: every errno the walk
// reports concerns the root the caller chose or a directory the walk has
// already opened inside it, so it says nothing about anyone else's files.
//
// WHAT IT REPLACED (TASK-899). This reader used to `realpath` the target, check
// the result was under the root, and then open the path again, with O_NOFOLLOW
// on the final component only. An agent that swapped an INTERMEDIATE directory
// for a symlink between the check and the open made that second open follow
// the link, into another tenant's files. W3's review reproduced it. On real
// NFS, a plain read through a directory being swapped for a link leaked the
// link's target 1,121 times in 20,000 reads, and the walk 0 times in 40,000
// (W3b, 2026-10-17).
//
// LINUX ONLY. The walk works through /proc/self/fd. Anywhere else, and on a
// Linux host without procfs, this throws `UserFilesReadError` with code
// `unsupported-platform`, rather than fall back to a reader with the window
// above.
//
// KNOWN GAPS. A listing stops after MAX_WALK_SKIPPED (1,000) skipped entries —
// links and special files — so one folder of a million symlinks can't cost a
// million stats. If that happens before the regular entries, the listing comes
// back short, and the hook's dir answer has no field to say so.
//
// A file name that is not valid UTF-8 is left out of a listing. Node decodes
// it with U+FFFD in place of the bad bytes, the walk's lstat of the re-encoded
// name looks up different bytes and normally finds nothing (ENOENT), and the
// entry is skipped, counting toward that same cap. Asked for by its mangled
// name, it is absent. The reader this replaced listed it under the mangled
// name, and opening it answered absent, so it was never readable here.
//
// READ-ONLY, structurally: nothing here opens a writable handle, and there is
// no write/delete entry point to reach for by mistake.
// ---------------------------------------------------------------------------

// `UserFilesReadError` lives in errors.ts so the walk (walk-read.ts) can
// subclass it without importing this file back. Re-exported: public API.
export { UserFilesReadError } from './errors.js';

/**
 * Errnos that turn a failed walk into an ABSENCE rather than a broken read: the
 * path stopped existing, or stopped being a directory, before we got to it. An
 * ordinary race against an agent that is still working, and still an absence.
 * ENOENT on the root itself is the commonest case of all: an agent that has
 * never written anything has no subtree yet.
 *
 * The walk answers a component that is missing, a link or not a directory at
 * the moment it opens it by itself, so these arrive here from the other steps:
 * opening the root, listing, and the leaf's stat and read. On NFS the same race
 * can arrive as ESTALE instead. That is not one of these: the walk retries it,
 * and a path that is really gone comes back from the retry as ENOENT.
 */
const VANISHED_ERRNOS = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/**
 * A path segment longer than a filename may be (NAME_MAX: 255 bytes on every
 * filesystem this runs on). No such file can exist, and the answer depends
 * only on the path's text, so it is no oracle; a 5xx would invite a retry that
 * can never succeed. The MAX_WALK_PARTS rule's reasoning, for length. It does reach us:
 * channel-web caps a segment at 255 UTF-16 units, and 128 two-byte characters
 * are 256 bytes.
 */
const NAME_TOO_LONG = 'ENAMETOOLONG';

/**
 * Whether a failed walk means the path is not there, rather than that the
 * storage would not answer. See the two constants above.
 */
function isAbsence(err: WalkReadError): boolean {
  return err.code !== undefined && (VANISHED_ERRNOS.has(err.code) || err.code === NAME_TOO_LONG);
}

/**
 * Bounds on somebody else's filesystem.
 *
 * Both matter for the HOST-mounted realization specifically. Before it, the
 * host had no access to an agent subtree at all; after it, an unbounded read of
 * an NFS file into the host process is a denial of service against the host —
 * which holds the database, the blob store and every credential — and not just
 * a slow request. So the cap is not a nicety, it is the price of the mount.
 */
export interface ConfinedReadLimits {
  /**
   * The most bytes one file read will pull into memory. An integer from 0 to
   * 16 MiB (16 * 1024 * 1024): anything else makes the read throw a
   * `RangeError`. A larger file is read
   * as its first `maxFileBytes` bytes — a PREFIX, not an error and not an
   * `absent`. Rendering "no such file" over a 4 GB dataset the agent definitely
   * wrote would be a lie; handing back a prefix lets the consumer say "this is
   * the beginning of it", which is what the Files surface already says.
   *
   * A prefix is reported as one: the answer carries `truncated: true`. The
   * read therefore asks the filesystem for `maxFileBytes + 1` bytes and keeps
   * `maxFileBytes` of them — one byte is what tells a file of exactly the cap
   * apart from a file that is longer, and the consumer cannot recover that
   * from a length.
   */
  maxFileBytes: number;
  /**
   * The most children one directory listing will carry. An integer from 1 to
   * 10,000: 0 or anything above makes the read throw a `RangeError`. A
   * directory with more
   * is listed up to the cap. The caller is expected to SAY that the list is
   * short — see `truncated` on the route response. A silently-clipped listing
   * is a listing that lies about what the agent has.
   */
  maxDirEntries: number;
}

/**
 * 1 MiB / 5000 entries.
 *
 * The byte cap matches the k8s one-shot reader pod's `READ_MAX_FILE_BYTES` so
 * the two realizations of `sandbox:read-user-files` return the same bytes for
 * the same file — a browser that shows a different amount of a file depending
 * on which sandbox provider is loaded is a browser nobody can reason about.
 */
export const DEFAULT_CONFINED_READ_LIMITS: ConfinedReadLimits = {
  maxFileBytes: 1024 * 1024,
  maxDirEntries: 5000,
};

/**
 * Resolve `relPath` against `root`, REJECTING anything that escapes it.
 *
 * `relPath` is caller-supplied (it arrives from a URL), so an absolute path, a
 * `..` segment, or a post-join path outside `root` all throw. An empty /`'.'`
 * `relPath` resolves to `root` itself.
 *
 * This is the LEXICAL guard, the first defense in this file's header, and
 * `readConfinedUserFiles` runs it before anything else. It is exported so a
 * realization that wants to reject a malformed path LOUDLY (a bug in our own
 * caller) can. The joined path is never opened by the reader: the walk opens
 * one component at a time.
 */
export function safeJoinUnderRoot(
  root: string,
  relPath: string | undefined,
): string {
  const rel = relPath === undefined || relPath === '' ? '.' : relPath;
  if (path.isAbsolute(rel)) {
    throw new Error(`user-files relPath must be relative, got: ${rel}`);
  }
  if (rel.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new Error(`user-files relPath must not contain '..': ${rel}`);
  }
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, rel);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`user-files relPath escapes the mount root: ${rel}`);
  }
  return full;
}

/**
 * Read ONE path under `root`, confined to it, read-only.
 *
 * `root` is a directory the caller has already decided this request may read —
 * for the durable user-files tier that is `<export or host mount>/<agentId>`,
 * and confining to the PER-AGENT segment rather than to the export is
 * load-bearing: a symlink could otherwise still cross into a sibling agent's
 * subtree on the same export without ever leaving it.
 *
 * A regular file answers with its bytes (capped, see `ConfinedReadLimits`); a
 * directory with its immediate children (files and dirs only, capped); anything
 * else — missing, a symlink at any depth, a socket, a device — with
 * `{ kind: 'absent' }`.
 *
 * Throws for a relPath malformed enough to be OUR bug: absolute, containing
 * `..` (both a plain `Error` from `safeJoinUnderRoot`), or not a clean
 * `a/b/c` — an empty segment (`a//b`, a trailing `/`), a `.` segment, or NUL —
 * which is a `WalkPathError` (code `invalid-path`; it is not a
 * `UserFilesReadError`, and it is not exported from the package). The reader
 * this replaced served `docs/`, `a//b` and `x/./y`, and answered NUL as absent.
 * The shipped routes cannot reach any of these: channel-web's
 * `workspaceFilePath` (`packages/channel-web/src/server/safe-path.ts`) answers
 * every one of them with a 400 before the path gets here. A new caller must
 * normalize its paths first.
 *
 * Throws `UserFilesReadError` when the storage is there and will not answer
 * — an unreachable root, a listing or a read that failed for any reason other
 * than the path having vanished underneath us, a stale NFS handle the walk's
 * one retry could not get past — or when this is not Linux (code
 * `unsupported-platform`). Everything path-dependent stays `absent`: see the
 * header.
 */
export async function readConfinedUserFiles(
  root: string,
  relPath: string | undefined,
  limits: ConfinedReadLimits = DEFAULT_CONFINED_READ_LIMITS,
): Promise<ReadUserFilesOutput> {
  // The order is the contract.
  // 1. Lexical guard: absolute paths and `..` throw, with the messages callers
  //    already match. The joined path itself is not used.
  safeJoinUnderRoot(root, relPath);
  // 2. Every spelling of the root. The k8s provider sends '.'.
  const rel = relPath === undefined || relPath === '' || relPath === '.' ? '' : relPath;
  // 3. Too deep to walk. Decided from the text alone, so it is the same answer
  //    whatever is on disk, and no oracle.
  if (rel !== '' && rel.split('/').length > MAX_WALK_PARTS) return { kind: 'absent' };
  // 4. Anything else malformed (`a//b`, a trailing `/`, NUL) throws
  //    `WalkPathError`: that is our caller's bug, not a missing file.
  const parts = splitRelPath(rel);
  // 5. The walk.
  let out;
  try {
    out = await readConfinedByWalk(root, parts, {
      limitBytes: limits.maxFileBytes,
      maxEntries: limits.maxDirEntries,
    });
  } catch (err) {
    if (err instanceof WalkReadError && isAbsence(err)) return { kind: 'absent' };
    throw err;
  }
  // 6. Only the hook's fields: the walk's `reason` is for tests and
  //    diagnostics, never a client, and the hook's dir answer has no
  //    `truncated`.
  if (out.kind === 'absent') return { kind: 'absent' };
  if (out.kind === 'dir') return { kind: 'dir', entries: out.entries };
  return { kind: 'file', contents: out.contents, truncated: out.truncated };
}

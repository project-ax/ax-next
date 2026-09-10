import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type {
  ReadUserFilesOutput,
  UserFileDirEntry,
} from '@ax/sandbox-mount-protocol';

// ---------------------------------------------------------------------------
// @ax/user-files-read — ONE confined reader for an agent's durable user-files
// subtree, shared by every realization of `sandbox:read-user-files`.
//
// This is a pure library: no manifest, no hooks, no @ax/core dependency. It
// exists because the same realpath-confinement was about to be written a THIRD
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
// swap one between our check and our open. So:
//
//   1. LEXICAL guard on the caller's relPath — absolute paths and `..` segments
//      are rejected outright. Necessary, nowhere near sufficient: it does not
//      look at the disk at all.
//   2. REALPATH confinement — every component of the resolved path must land
//      inside the realpath'd root. This is the primary defense, and it is the
//      one that catches an INTERMEDIATE symlink.
//   3. `O_NOFOLLOW` on the final open — shrinks the realpath→open TOCTOU
//      window: a final component swapped for a symlink after step 2 fails the
//      open (ELOOP) instead of being followed.
//   4. Symlink children are DROPPED from a listing, never named. A name we
//      hand back is a name the client will ask us to open; offering one that
//      points somewhere we would refuse to read is an invitation to probe.
//
// Anything that fails confinement resolves to `{ kind: 'absent' }`, never an
// error with a distinguishing message. A 400-vs-404 split on a path is a free
// oracle for mapping someone else's subtree, and "absent" is also simply true
// from the caller's side: this surface does not have that file.
//
// READ-ONLY, structurally: nothing here opens a writable handle, and there is
// no write/delete entry point to reach for by mistake.
// ---------------------------------------------------------------------------

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
   * The most bytes one file read will pull into memory. A larger file is read
   * as its first `maxFileBytes` bytes — a PREFIX, not an error and not an
   * `absent`. Rendering "no such file" over a 4 GB dataset the agent definitely
   * wrote would be a lie; handing back a prefix lets the consumer say "this is
   * the beginning of it", which is what the Files surface already says.
   */
  maxFileBytes: number;
  /**
   * The most children one directory listing will carry. A directory with more
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
 * This is step 1 of the walk in this file's header, and it is exported so a
 * realization that wants to reject a malformed path LOUDLY (a bug in our own
 * caller) can, before the on-disk steps that deliberately answer `absent`.
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
 * Confine `target` to `root` by realpath — resolving EVERY component, so an
 * intermediate symlink the untrusted agent planted inside its own subtree
 * cannot point the read at another tenant's files or at the host filesystem.
 *
 * `safeJoinUnderRoot` only catches `..`/absolute in the caller's string; it
 * does not touch the disk, so it is necessary but NOT sufficient. This is the
 * step that closes the cross-tenant disclosure.
 *
 * Returns the realpath'd target when it stays under the realpath'd root, else
 * `undefined` (→ the caller serves `absent`). A missing path or a dangling
 * link also yields `undefined`: realpath fails, and "we could not resolve it"
 * and "it is not there" are the same answer to a reader.
 */
export async function confineByRealpath(
  root: string,
  target: string,
): Promise<string | undefined> {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.realpath(root);
    realTarget = await fs.realpath(target);
  } catch {
    return undefined;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return undefined;
  }
  return realTarget;
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
 * else — missing, outside the root, a socket, a device, a dangling link — with
 * `{ kind: 'absent' }`.
 *
 * Throws only for a relPath that is malformed enough to be OUR bug (absolute,
 * or containing `..`). Everything the filesystem has an opinion about is
 * `absent`, deliberately: see the oracle note in the header.
 */
export async function readConfinedUserFiles(
  root: string,
  relPath: string | undefined,
  limits: ConfinedReadLimits = DEFAULT_CONFINED_READ_LIMITS,
): Promise<ReadUserFilesOutput> {
  // 1. Lexical guard on the caller-supplied relPath (absolute / `..`).
  const lexicalTarget = safeJoinUnderRoot(root, relPath);
  // 2. On-disk guard: realpath-confine to the root so an intermediate symlink
  //    cannot escape. A path that resolves outside → absent.
  const target = await confineByRealpath(root, lexicalTarget);
  if (target === undefined) return { kind: 'absent' };

  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return { kind: 'absent' };
  }
  // Belt: unreachable after realpath, which is exactly why it is handled
  // rather than assumed.
  if (stat.isSymbolicLink()) return { kind: 'absent' };

  if (stat.isDirectory()) return listDir(target, limits.maxDirEntries);
  if (stat.isFile()) return readFilePrefix(target, limits.maxFileBytes);
  // A socket / fifo / device — nothing a file browser should serve.
  return { kind: 'absent' };
}

/**
 * The immediate children of a confirmed-in-root directory, capped.
 *
 * `withFileTypes` reports lstat semantics, so a symlink dirent is neither
 * `isFile()` nor `isDirectory()` — symlinks are dropped by the same filter that
 * drops sockets and devices, and are never named back to the caller.
 */
async function listDir(
  target: string,
  maxEntries: number,
): Promise<ReadUserFilesOutput> {
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return { kind: 'absent' };
  }
  const entries: UserFileDirEntry[] = [];
  for (const d of dirents) {
    if (entries.length >= maxEntries) break;
    if (!d.isFile() && !d.isDirectory()) continue;
    entries.push({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' });
  }
  return { kind: 'dir', entries };
}

/**
 * Up to `maxBytes` of a confirmed-in-root regular file.
 *
 * `O_NOFOLLOW` shrinks the realpath→open TOCTOU window: if the final component
 * was swapped for a symlink between the confinement check and this open, the
 * open fails (ELOOP) → `absent`, rather than following the swapped link.
 *
 * The read is bounded at the syscall, not after the fact — `readFile()` on a
 * multi-gigabyte NFS file would already have spent the memory by the time we
 * looked at its length.
 */
async function readFilePrefix(
  target: string,
  maxBytes: number,
): Promise<ReadUserFilesOutput> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    // Copy out of the over-allocated buffer so the returned view cannot expose
    // whatever `allocUnsafe` handed us past `bytesRead`.
    return { kind: 'file', contents: new Uint8Array(buf.subarray(0, bytesRead)) };
  } catch {
    return { kind: 'absent' };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

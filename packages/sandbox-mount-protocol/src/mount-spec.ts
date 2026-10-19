import type { ServiceHandler } from '@ax/core';
import type { OpenSessionInput } from '@ax/sandbox-protocol';

// ---------------------------------------------------------------------------
// @ax/sandbox-mount-protocol — the sandbox per-agent mount contract
// (filestore-user-files epic, design §4; follows the
// @ax/workspace-bundle-protocol / @ax/sandbox-protocol precedent)
//
// This package holds the HOST-INTERNAL `sandbox:resolve-mounts` service-hook
// contract: the `MountSpec` discriminated union a mount-resolver plugin
// (`@ax/workspace-filestore`, `@ax/workspace-localdir`) emits, and the TS
// signature a sandbox provider (`@ax/sandbox-k8s`, `@ax/sandbox-subprocess`)
// realizes into a real pod/process mount. (Those consumers land in a later
// card — this package is contract-only.)
//
// Why it lives HERE and not in @ax/core: the kernel is storage- and
// backend-AGNOSTIC (architecture doc §4.5, invariant I1 — no
// nfs/server/exportPath/hostPath vocabulary). `MountSpec` carries exactly
// that backend vocabulary. Keeping it in @ax/core would make the neutral
// kernel carry NFS/dev-host field names — the very leak I1 forbids.
// Isolating it in this provider-facing protocol package keeps the kernel
// clean: a sandbox provider that doesn't support a durable mount simply
// never imports this package and never lists `sandbox:resolve-mounts` in
// its `optionalCalls`, so it never sees the vocabulary and never pays for
// the abstraction. (Mirrors exactly what ARCH-3 did for the git-vocabulary
// bundle types in @ax/workspace-bundle-protocol.)
//
// Pure TS types (plus a few plain constants), NO zod: this is consumed only as an in-process hook-bus
// generic (`bus.call<In, Out>` / `registerService<In, Out>`), where the TS
// type IS the whole contract. `sandbox:resolve-mounts` is host-internal — it
// is called by the provider during pod construction and NEVER crosses the
// untrusted sandbox edge (it is deliberately NOT an IPC action; design §4),
// so there is no untrusted wire to validate and zod here would be dead
// validation. The owner shape is reused type-only from @ax/sandbox-protocol
// so the resolver's input can't drift from the real session owner; the
// handler alias is built on @ax/core's neutral `ServiceHandler` generic.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MountSpec — an OPAQUE, kind-discriminated mount request.
//
// **Consumer contract (load-bearing — read before realizing a mount):**
// A consumer (sandbox provider) MUST branch on `kind` and realize only the
// members it supports; an unknown `kind` is an EXPLICIT error, never a silent
// skip (design §4 / §10). A consumer MUST NOT read a backend-specific field
// (`server`, `exportPath`, `subPath`, `hostPath`) without first narrowing on
// `kind` — those fields exist only on the member that owns them, and keying
// off them across the union (e.g. "does it have a `server`?") couples the
// consumer to one backend and breaks when another `kind` ships. The `kind`
// discriminator is the only safe thing to switch on; everything else is
// backend detail bounded behind it (the same escape hatch @ax/credentials
// uses for its own `kind` union). Adding a future backend (e.g. `gcsFuse`,
// `s3Csi`) is purely a new union member — and the `never`-exhaustiveness
// pattern (see the package test) forces every consumer to handle it.
//
// `mountPath`, `readOnly`, and the optional `role` are the only fields shared
// across every member — the backend-neutral surface a consumer can read
// without narrowing. `role: 'user-files'` tells the provider which mount to
// expose as `AX_USERFILES_ROOT` in the runner env; `role: 'memory'` marks the
// TASK-494 facts-export projection, which the provider exposes as
// `AX_MEMORY_ROOT` and realizes read-only only.
//
// `role: 'shared-folder'` (W2 shared folders) marks ONE folder shared between
// agents. A session can carry zero or many of them, so — unlike the single
// `user-files` / `memory` mounts — it is never exposed as a lone root env var.
// The provider instead lists every realized `shared-folder` mount, in the one
// runner env var `AX_SHARED_FOLDERS`: a JSON array of
// `{ id, path, readOnly }` built from each mount's `folderId`, its path (the
// `mountPath` inside a sandbox, the host path for a shared-FS provider) and its
// `readOnly`. A `shared-folder` mount ALWAYS carries a `folderId`; a consumer
// that needs the folder id reads `folderId`, never parses it out of
// `mountPath`/`subPath`. Because a provider may hold several, a consumer
// looking up the `user-files` (or `memory`) mount MUST match on `role` and
// never take "the first mount" — the shared-folder mounts come AFTER it.
// ---------------------------------------------------------------------------

/**
 * An NFS (e.g. Google Cloud Filestore) export, realized by a network-mount
 * provider. The k8s provider realizes this as an inline `nfs:` pod volume
 * (`{ nfs: { server, path: exportPath } }`) plus a `volumeMount` that pins
 * the per-agent `subPath` subtree; the kubelet auto-creates the `subPath`
 * subdir on first use. Cross-tenant isolation is the `subPath` confinement:
 * other agents' subtrees are not even mounted.
 */
export interface NfsMountSpec {
  /** Discriminator — consumers switch on this and NOTHING else. */
  kind: 'nfs';
  /** Where the mount appears inside the sandbox, e.g. `/files`. */
  mountPath: string;
  /** NFS server address — Filestore IP or DNS name. */
  server: string;
  /** Export path on the server, e.g. `/vol1/agents`. */
  exportPath: string;
  /** Per-tenant subtree within the export, e.g. the `agentId`. */
  subPath: string;
  /** Mount the export read-only. The runner uses `false`; a future host-read realization uses `true`. */
  readOnly: boolean;
  /**
   * When set, the provider exports this mount's path as `AX_USERFILES_ROOT`
   * (`user-files`), `AX_MEMORY_ROOT` (`memory`), or lists it in
   * `AX_SHARED_FOLDERS` (`shared-folder`).
   */
  role?: 'user-files' | 'memory' | 'shared-folder';
  /** The shared folder's id. Set IFF `role` is `'shared-folder'`; absent otherwise. */
  folderId?: string;
}

/**
 * A real persistent directory on the host filesystem, realized by a provider
 * that shares the host FS (the subprocess/dev provider). It realizes this by
 * `mkdir -p hostPath` — there is no container mount; the path is simply made
 * to exist. Gives the canary + local dev loop a durable per-agent mount
 * without real NFS.
 */
export interface LocalDirMountSpec {
  /** Discriminator — consumers switch on this and NOTHING else. */
  kind: 'localDir';
  /** Where the mount appears inside the sandbox, e.g. `/files`. */
  mountPath: string;
  /** Real persistent directory on the dev host, e.g. `<root>/<agentId>`. */
  hostPath: string;
  /** Mount the directory read-only. The runner uses `false`. */
  readOnly: boolean;
  /**
   * When set, the provider exports this mount's path as `AX_USERFILES_ROOT`
   * (`user-files`) or lists it in `AX_SHARED_FOLDERS` (`shared-folder`).
   */
  role?: 'user-files' | 'shared-folder';
  /** The shared folder's id. Set IFF `role` is `'shared-folder'`; absent otherwise. */
  folderId?: string;
}

/**
 * A per-agent durable mount request. Opaque discriminated union — see the
 * consumer contract above: branch on `kind`, error on an unknown member,
 * never key off a backend-specific field without narrowing first.
 */
export type MountSpec = NfsMountSpec | LocalDirMountSpec;

// ---------------------------------------------------------------------------
// `sandbox:resolve-mounts` (host-internal service hook)
//
//   sandbox:resolve-mounts (ctx, { owner }) → { mounts: MountSpec[] }
//
// A mount-resolver plugin registers this; a sandbox provider lists it in
// `optionalCalls` and calls it during session open to learn which durable
// per-agent mounts to realize. When no resolver is loaded, the provider
// degrades to the default emptyDir tiers (no durable user-files mount). A
// resolver returns `[]` when it has nothing to contribute (e.g. an anonymous
// CLI session with no `agentId`) — that is a no-mount, not an error.
// ---------------------------------------------------------------------------

/**
 * Input to `sandbox:resolve-mounts`. `owner` is the session owner, reused
 * verbatim from `@ax/sandbox-protocol`'s `OpenSessionInput` so the resolver's
 * input cannot drift from the real session-owner shape (invariant I4 — one
 * source of truth). The resolver keys the per-agent subtree off
 * `owner.agentId`.
 *
 * `readOnly` lets a NON-runner caller request a read-only realization of the
 * same owner-keyed mount (design §11 host-read: the host serves an agent's
 * user files to the web UI without granting write). The runner's
 * session-open call omits it (defaults to a writable mount). A resolver MUST
 * carry this value through onto `MountSpec.readOnly` so a downstream consumer
 * (a host-read realization) can mount the export read-only. Defaulting to a
 * writable mount keeps the session-open path byte-for-byte unchanged.
 */
export interface ResolveMountsInput {
  owner: NonNullable<OpenSessionInput['owner']>;
  /**
   * When `true`, the resolver emits each mount with `readOnly: true` so the
   * caller realizes a read-only view (host-read, design §11). Absent/false →
   * the writable realization the runner uses. The resolver applies this to
   * EVERY mount it emits; it never widens write access, only narrows it.
   */
  readOnly?: boolean;
  /**
   * W2 shared folders: the folders the HOST wants mounted into this session
   * (copied from `OpenSessionInput.sharedFolderIds`). A REQUEST, not a grant —
   * the resolver filters it through `shared-folders:authorize-mounts` and emits
   * a `role: 'shared-folder'` mount only for each folder that comes back
   * (read-only for a viewer). Ids that are invalid or not authorized are
   * dropped (and logged), never an error. Absent/empty → no shared-folder
   * mounts, the session-open path unchanged.
   */
  sharedFolderIds?: readonly string[];
}

/**
 * Output of `sandbox:resolve-mounts`: the durable per-agent mounts the
 * provider should realize. May be empty (the resolver has nothing to
 * contribute — a graceful no-mount, never an error).
 */
export interface ResolveMountsOutput {
  mounts: MountSpec[];
}

/**
 * The full `sandbox:resolve-mounts` handler signature — the in-process
 * hook-bus contract a resolver plugin satisfies via
 * `registerService<ResolveMountsInput, ResolveMountsOutput>` and a sandbox
 * provider invokes via `bus.call<ResolveMountsInput, ResolveMountsOutput>`.
 * Built on `@ax/core`'s neutral `ServiceHandler` so the `(ctx, input) =>
 * Promise<output>` shape stays identical to every other service hook.
 */
export type ResolveMountsHandler = ServiceHandler<ResolveMountsInput, ResolveMountsOutput>;

// ---------------------------------------------------------------------------
// `sandbox:read-user-files` (host-internal service hook) — design §11 host-read
//
//   sandbox:read-user-files (ctx, { owner, relPath }) → ReadUserFilesOutput
//
// The host's READ-ONLY view of an agent's durable user-files mount, so the web
// UI can serve those files without entering a live sandbox. The provider that
// owns mount realization registers this; it resolves the owner's mount via
// `sandbox:resolve-mounts({ owner, readOnly: true })` and realizes a READ-ONLY
// view of it (the subprocess provider reads its shared-FS `hostPath`; the k8s
// provider realizes the `nfs` export read-only inside a short-lived job). Write
// access is NEVER granted on this path — the realization is read-only end to
// end (design §11: "without granting write").
//
// Like `sandbox:resolve-mounts`, this is HOST-INTERNAL: the host calls it
// directly (e.g. from a web route handler), it never crosses the untrusted
// sandbox edge, and it is deliberately NOT an IPC action — so there is no wire
// schema and no new untrusted-input surface here. The path argument IS
// caller-supplied, so a realization MUST confine every read to the resolved
// mount subtree and reject traversal (`..`, absolute paths) — that confinement
// is the realization's job, documented on its impl.
// ---------------------------------------------------------------------------

/**
 * Input to `sandbox:read-user-files`. `owner` keys the per-agent mount exactly
 * like `sandbox:resolve-mounts` (the hook resolves the mount internally with
 * `readOnly: true`). `relPath` is a path RELATIVE to the user-files mount root
 * (`mountPath`/`hostPath`): omit it (or pass `''`/`'.'`) to read the mount
 * root. A realization MUST reject any `relPath` that escapes the mount
 * (absolute, `..` segment) — the path is caller-supplied.
 */
export interface ReadUserFilesInput {
  owner: NonNullable<OpenSessionInput['owner']>;
  /** Path relative to the user-files mount root. Default: the root itself. */
  relPath?: string;
}

/** One entry in a directory listing returned by `sandbox:read-user-files`. */
export interface UserFileDirEntry {
  /** Entry name (a single path segment, never a `/`-joined path). */
  name: string;
  /** Whether the entry is a regular file or a subdirectory. Other node
   *  types (symlink, socket, device) are omitted by the realization — a
   *  read-only file browser surfaces only files and dirs. */
  kind: 'file' | 'dir';
}

/**
 * Output of `sandbox:read-user-files` — a read-only view of one path.
 *
 * - `{ kind: 'file', contents, truncated }` — `relPath` resolved to a regular
 *   file; its bytes are returned, and `truncated` says whether they are ALL of
 *   them.
 * - `{ kind: 'dir', entries }` — `relPath` resolved to a directory; its
 *   immediate children are listed (not recursive).
 * - `{ kind: 'absent' }` — there IS a durable tier for this owner and the path
 *   is not in it: never written, since deleted, or resolved outside the
 *   owner's own subtree. A graceful "this surface does not have that file".
 * - `{ kind: 'unavailable' }` — there is no durable tier for this owner AT ALL
 *   in this deployment: no `sandbox:resolve-mounts` resolver is loaded, the
 *   owner is anonymous, or no resolver emitted a `role: 'user-files'` mount.
 *
 * THE LAST TWO USED TO BE ONE ANSWER, and collapsing them was a lie the UI had
 * no way to un-tell (TASK-403). A caller that gets `absent` for both can only
 * say "either nothing was written or nothing is being kept — we can't tell
 * which", and it had to say that even on a deployment where the tier is wired
 * and working. They are now separate because they are separate facts, and
 * because `unavailable` is safe to distinguish: it is decided BEFORE any path
 * is consulted, so it is the same answer for every `relPath` and therefore
 * discloses nothing about which paths exist. `absent` keeps carrying every
 * path-dependent case for exactly that reason — a 400-vs-404 split on a path
 * is a free oracle for mapping somebody else's subtree.
 *
 * A READ THAT FAILED IS NEITHER, AND MUST NOT BE EITHER. If the storage is
 * there and would not answer — the export is unreachable, the listing raised
 * `EIO`/`ESTALE`, the reader pod died — a realization THROWS. There is
 * deliberately no `failed` member here: an absence and an error travel by
 * different mechanisms so that no caller can pattern-match one into the other
 * by forgetting a case. The host surface turns a throw into a 5xx and the UI
 * offers a retry; an `absent` rendered over a broken mount would tell somebody
 * their agent produced nothing when we simply could not look.
 *
 * WHY `truncated` EXISTS. Every realization bounds one file read — an
 * unbounded read of somebody else's filesystem into the host process is a
 * denial of service against the host, not a slow request — and a bounded read
 * answers with a PREFIX rather than an error, because "no such file" over a
 * 4 GB dataset the agent definitely wrote would be a lie.
 *
 * But a prefix that does not SAY it is a prefix is the same lie pointing the
 * other way, and the consumer cannot work it out: `contents.length === cap`
 * is equally what a file of exactly the cap looks like. A preview can survive
 * that (it says "showing the beginning" whenever it clips at its own, much
 * smaller, bound). A consumer handing the bytes to a person as THE FILE cannot
 * — a truncated PDF is a corrupt PDF, and it looks like a whole one.
 *
 * So the bit rides on the answer. It is a fact about the ANSWER, not about the
 * backend: no cap, no mount kind and no byte count crosses this boundary, and
 * a realization with no cap at all simply always reports `false`.
 */
export type ReadUserFilesOutput =
  | {
      kind: 'file';
      contents: Uint8Array;
      /**
       * `true` when the file is LONGER than `contents` — i.e. these bytes are
       * a prefix and the rest was not read.
       *
       * Optional so a realization written before this field keeps type-checking,
       * but every realization in this repo sets it explicitly. A consumer that
       * must not hand over a partial file treats `undefined` as "unknown, and
       * unknown is not a promise" — see the download routes in
       * `@ax/channel-web`.
       */
      truncated?: boolean;
    }
  | { kind: 'dir'; entries: UserFileDirEntry[] }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

/**
 * The full `sandbox:read-user-files` handler signature — the in-process
 * hook-bus contract a sandbox provider satisfies via
 * `registerService<ReadUserFilesInput, ReadUserFilesOutput>` and the host
 * invokes via `bus.call<ReadUserFilesInput, ReadUserFilesOutput>`.
 */
export type ReadUserFilesHandler = ServiceHandler<ReadUserFilesInput, ReadUserFilesOutput>;

// ---------------------------------------------------------------------------
// Shared folders (W2) — constants + the three host-internal service contracts
//
// Like everything else in this file these are HOST-INTERNAL: they never cross
// the untrusted sandbox edge and are deliberately NOT IPC actions, so there is
// no wire to validate. They live HERE (types only) so a mount resolver can
// import the `shared-folders:authorize-mounts` contract without importing the
// `@ax/shared-folders` plugin (invariant I2 — no cross-plugin imports; the hook
// bus is the inter-plugin API).
// ---------------------------------------------------------------------------

/**
 * Directory, at the root of the per-agent backing store, that holds every
 * shared folder: `.shared/<folderId>` (an NFS `subPath`; a localdir
 * `<root>/.shared/<folderId>`). The leading dot is load-bearing: no valid agent
 * id can equal `.shared`, so no agent's `/files` subtree can ever be the parent
 * of the shared folders, and a per-agent `rm -rf <agentId>` can never reach them.
 */
export const SHARED_FOLDERS_DIR = '.shared';

/**
 * Where a shared folder appears inside a sandbox: `/shared/<folderId>`. Outside
 * `/files` on purpose — `/files` is the agent's own writable subtree, so the
 * agent would control the mount target there.
 */
export const SHARED_FOLDERS_MOUNT_BASE = '/shared';

/**
 * Input to `shared-folders:authorize-mounts` (registered by `@ax/shared-folders`,
 * called by the mount resolvers during session open). There is NO actor: this is
 * a person-less, host-internal filter, never reachable from a sandbox. It only
 * narrows `folderIds` down to the folders `agentId` currently holds a live grant on.
 */
export interface AuthorizeMountsInput {
  /** The agent the session belongs to (`owner.agentId`). */
  agentId: string;
  /** The folders the host requested to mount. */
  folderIds: readonly string[];
}

/**
 * Output of `shared-folders:authorize-mounts`: the requested folders `agentId`
 * holds a live grant on, in no promised order. A folder the agent has no grant
 * on, a tombstoned (being-deleted) folder, and an unknown id are all simply
 * ABSENT — never an error, and the absence reveals nothing about which.
 */
export interface AuthorizeMountsOutput {
  folders: {
    folderId: string;
    /** `true` for a viewer grant: the resolver MUST realize the mount read-only. */
    readOnly: boolean;
  }[];
}

/**
 * Input to `sandbox:locate-shared-folder` (registered by the mount resolver —
 * `@ax/workspace-filestore`, `@ax/workspace-localdir`). Asks where a folder's
 * bytes live, for DELETION only (`sandbox:delete-shared-folder`). It performs NO
 * grant check — by the time a folder is being deleted its grants are already
 * gone — so it must never be used to read or mount anything on someone's behalf.
 * A resolver rejects an id that fails `isValidSharedFolderId`.
 */
export interface LocateSharedFolderInput {
  folderId: string;
}

/**
 * Output of `sandbox:locate-shared-folder`: a WRITABLE `role: 'shared-folder'`
 * `MountSpec` for the folder (the same location a session mount would use), so
 * the provider that owns realization can remove it. Opaque to every caller
 * except that provider — branch on `kind` like any other `MountSpec`.
 */
export interface LocateSharedFolderOutput {
  mount: MountSpec;
}

/**
 * Input to `sandbox:delete-shared-folder` (registered by the sandbox provider
 * that owns mount realization; called by `@ax/shared-folders` when a folder is
 * deleted). The provider resolves the location via
 * `sandbox:locate-shared-folder` and removes the folder's bytes.
 */
export interface DeleteSharedFolderInput {
  folderId: string;
}

/**
 * Output of `sandbox:delete-shared-folder`. The literal `true`: a delete that
 * did not happen THROWS rather than returning `false`, so a caller cannot
 * forget a case and drop a tombstone over bytes that are still there. Deleting
 * an already-absent folder is a success (idempotent).
 */
export interface DeleteSharedFolderOutput {
  deleted: true;
}

// ---------------------------------------------------------------------------
// `sandbox:read-shared-folder` (host-internal service hook) — W3b
//
//   sandbox:read-shared-folder (ctx, { folderId, relPath?, limitBytes, maxEntries? })
//     → ReadSharedFolderOutput
//
// The host's READ-ONLY view of one shared folder, so a project's files can be
// shown in the web UI and summarized for an agent without entering a sandbox.
// Registered by the sandbox provider that owns mount realization
// (`@ax/sandbox-k8s`, `@ax/sandbox-subprocess`).
//
// THIS HOOK DOES NO GRANT CHECK. Like `sandbox:locate-shared-folder` it takes
// a bare `folderId` and answers for it. The ONLY caller is `@ax/projects`, and
// only AFTER it has checked that the person can use the project the folder
// belongs to. Anything else that wants a folder's bytes goes through
// `@ax/projects` (or grows its own check) — never straight here.
//
// HOST-INTERNAL, never an IPC action: no wire schema, no sandbox reach. The
// `relPath` IS untrusted, though — the folder is written by agents, so a
// realization MUST confine every read to the folder without following a
// symlink at ANY component, at any moment (a check-then-open is not enough:
// the agent can swap a directory for a link in between). The k8s and
// subprocess realizations walk component by component with O_NOFOLLOW.
// ---------------------------------------------------------------------------

/**
 * Input to `sandbox:read-shared-folder`. `folderId` must pass
 * `isValidSharedFolderId` (a realization rejects anything else). `relPath` is
 * relative to the folder root; omit it (or pass `''`) for the root. Absolute
 * paths and `''` / `.` / `..` segments are rejected. `limitBytes` bounds one
 * file read (a longer file comes back as a prefix with `truncated: true`);
 * `maxEntries` bounds one listing (the realization picks a default).
 */
export interface ReadSharedFolderInput {
  folderId: string;
  /** Path relative to the folder root. Default: the root itself. */
  relPath?: string;
  /** Most bytes of a file returned. Required: every read is bounded. */
  limitBytes: number;
  /** Most entries in a listing. Default chosen by the realization. */
  maxEntries?: number;
}

/**
 * One entry in a `sandbox:read-shared-folder` listing: a `UserFileDirEntry`
 * plus, for files, size and last-modified time (so a file browser can show
 * them without opening each file). Symlinks, sockets, FIFOs and devices are
 * omitted, never named.
 */
export interface SharedFolderDirEntry extends UserFileDirEntry {
  /** Bytes on disk (files only). */
  size?: number;
  /** Last modification, ISO-8601 (files only). */
  updatedAt?: string;
}

/**
 * Output of `sandbox:read-shared-folder`. Same four answers as
 * `ReadUserFilesOutput`, with the same rules:
 *
 * - `file` — `truncated` says whether `contents` is a prefix; `size` is the
 *   file's full size on disk, so a caller can show "12 MB" without fetching it.
 * - `dir` — immediate children only; `truncated` when the listing hit
 *   `maxEntries`.
 * - `absent` — the folder or the path isn't there, or a component is a symlink
 *   or not a directory. Deliberately ONE answer: telling "a link" from
 *   "missing" would be an oracle over an agent-written tree.
 * - `unavailable` — this deployment can't read shared folders at all (no host
 *   read root configured, the storage won't let the host traverse it, or the
 *   platform can't do a confined walk). Decided before the path matters.
 *
 * A read that FAILED (EIO, ESTALE, an unexpected EACCES deeper in) THROWS. It
 * is neither `absent` nor `unavailable` (TASK-403).
 */
export type ReadSharedFolderOutput =
  | { kind: 'file'; contents: Uint8Array; truncated: boolean; size: number }
  | { kind: 'dir'; entries: SharedFolderDirEntry[]; truncated: boolean }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

/**
 * The full `sandbox:read-shared-folder` handler signature — satisfied via
 * `registerService<ReadSharedFolderInput, ReadSharedFolderOutput>`.
 */
export type ReadSharedFolderHandler = ServiceHandler<ReadSharedFolderInput, ReadSharedFolderOutput>;

// ---------------------------------------------------------------------------
// `sandbox:scan-shared-folder` (host-internal service hook) — W3d
//
//   sandbox:scan-shared-folder (ctx, { folderId, maxEntries? })
//     → ScanSharedFolderOutput
//
// A recursive, confined STAT of one shared folder: every regular file's path,
// size, mtime and inode, so `@ax/projects` can tell what changed since its
// last look (file history). Registered by the provider that owns mount
// realization (`@ax/sandbox-k8s`, `@ax/sandbox-subprocess`), over the same
// read-only host walk as `sandbox:read-shared-folder`
// (`scanConfinedByWalk`, `@ax/user-files-read`).
//
// THIS HOOK DOES NO GRANT CHECK, exactly like `sandbox:read-shared-folder`.
// The ONLY caller is `@ax/projects`, for a project it already holds.
//
// HOST-INTERNAL, never an IPC action. The folder's CONTENTS are untrusted
// (agents write it): a realization never follows a symlink at any depth and
// never opens a file. Symlinks, sockets, FIFOs and devices are skipped,
// never named. Directories are walked but not reported.
// ---------------------------------------------------------------------------

/** Default and ceiling for `ScanSharedFolderInput.maxEntries`. */
export const SCAN_SHARED_FOLDER_MAX_ENTRIES = 10_000;
/** Most directory components below the export root a reported file may sit at (`MAX_WALK_PARTS`). */
export const SCAN_SHARED_FOLDER_MAX_DEPTH = 32;

/**
 * Input to `sandbox:scan-shared-folder`. `folderId` must pass
 * `isValidSharedFolderId`. `maxEntries` bounds the files reported (default
 * and ceiling `SCAN_SHARED_FOLDER_MAX_ENTRIES`); a realization refuses more.
 */
export interface ScanSharedFolderInput {
  folderId: string;
  maxEntries?: number;
}

/** One regular file in a scan. */
export interface ScannedSharedFile {
  /** Relative to the folder root, `/`-separated; valid as a `ReadSharedFolderInput.relPath`. */
  path: string;
  /** Bytes on disk. */
  size: number;
  /** Last modification, ms since the epoch, with sub-ms precision where the filesystem keeps it. */
  mtimeMs: number;
  /** Inode number. */
  ino: number;
}

/**
 * Output of `sandbox:scan-shared-folder`.
 *
 * - `done` — `files` sorted by `path` (code-unit order), so two scans diff
 *   deterministically. `truncated` when a cap stopped the scan (files,
 *   directories, skipped entries) or a directory was too deep to enter: a
 *   file missing from a truncated scan MAY STILL EXIST, so a caller must not
 *   read its absence as a delete. A folder that does not exist yet (a new
 *   project's folder before anything wrote it) is `done` with no files and
 *   not truncated: an empty scan is the truth.
 * - `unavailable` — this deployment can't read shared folders at all (no host
 *   read root, the host can't traverse `.shared`, or the platform can't do a
 *   confined walk). Same rule as `ReadSharedFolderOutput`.
 *
 * A scan that FAILED (EIO, ESTALE, an EACCES deeper in, the folder's name
 * being a link or a file) THROWS. It is never `done` with fewer files.
 */
export type ScanSharedFolderOutput =
  | { kind: 'done'; files: ScannedSharedFile[]; truncated: boolean }
  | { kind: 'unavailable' };

/**
 * The full `sandbox:scan-shared-folder` handler signature — satisfied via
 * `registerService<ScanSharedFolderInput, ScanSharedFolderOutput>`.
 */
export type ScanSharedFolderHandler = ServiceHandler<ScanSharedFolderInput, ScanSharedFolderOutput>;

// ---------------------------------------------------------------------------
// `sandbox:change-shared-folder` (host-internal service hook) — W3c
//
//   sandbox:change-shared-folder (ctx, { folderId, changes, createFolder? })
//     → ChangeSharedFolderOutput
//
// The host's WRITE path into one shared folder: a person saving, creating,
// or deleting a project file from the web UI, and `@ax/projects` seeding a
// new project's layout. Registered by the provider that owns mount
// realization (`@ax/sandbox-k8s` via its storage node, `@ax/sandbox-subprocess`
// directly); both apply the changes with `changeConfinedByWalk`
// (`@ax/user-files-read`).
//
// THIS HOOK DOES NO GRANT CHECK, exactly like `sandbox:read-shared-folder`.
// The ONLY caller is `@ax/projects`, after it has checked that the person may
// edit the project (and that the path isn't protected or read-only).
//
// HOST-INTERNAL, never an IPC action. `content` is bytes in-process; it is
// base64 only on the k8s storage node's own wire, whose schema lives with
// that route (`sandbox-k8s/src/storage-node/protocol.ts`), not here. Every
// `path` is untrusted relative to the folder, and a realization MUST confine
// every change without following a symlink at any component.
// ---------------------------------------------------------------------------

/** Most changes in one `sandbox:change-shared-folder` call. */
export const SHARED_FOLDER_CHANGE_MAX_CHANGES = 64;
/** Most bytes of one written file. */
export const SHARED_FOLDER_CHANGE_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Most bytes of written content across one call. */
export const SHARED_FOLDER_CHANGE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * One change, relative to the folder root. Same path rules as
 * `ReadSharedFolderInput.relPath`, and `path` may not be `''` for a write or
 * a delete.
 *
 * - `write` replaces the file atomically (temp file in the same directory,
 *   fsync, rename), creating missing parent directories. `ifMatch` is the
 *   lowercase hex sha256 of the bytes the caller last read: anything else on
 *   disk (or nothing) is a `conflict`. `ifAbsent` never overwrites: an
 *   existing name answers `exists`. Not both.
 * - `mkdir` is `mkdir -p`; an existing directory answers `exists` either way
 *   (`ifAbsent` records the caller's intent for seeding).
 * - `delete` removes a file, a symlink (as a link), or an EMPTY directory.
 */
export type SharedFolderChange =
  | { op: 'write'; path: string; content: Uint8Array; ifMatch?: string; ifAbsent?: true }
  | { op: 'mkdir'; path: string; ifAbsent?: true }
  | { op: 'delete'; path: string };

/**
 * What one change did. `conflict` stops the call: it is the LAST result.
 * `written` replaced an existing file; `created` made a new file or directory.
 */
export type SharedFolderChangeOutcome =
  | 'written'
  | 'created'
  | 'exists'
  | 'deleted'
  | 'absent'
  | 'conflict';

/** One entry of `ChangeSharedFolderOutput.results`, in the order of `changes`. */
export interface SharedFolderChangeResult {
  path: string;
  outcome: SharedFolderChangeOutcome;
}

/**
 * Input to `sandbox:change-shared-folder`. `folderId` must pass
 * `isValidSharedFolderId`. At most `SHARED_FOLDER_CHANGE_MAX_CHANGES`
 * changes, `SHARED_FOLDER_CHANGE_MAX_FILE_BYTES` per file and
 * `SHARED_FOLDER_CHANGE_MAX_TOTAL_BYTES` per call; a realization refuses more
 * before it touches the disk. `createFolder` makes the folder itself if it is
 * missing (seeding a new project); without it a missing folder throws.
 */
export interface ChangeSharedFolderInput {
  folderId: string;
  changes: SharedFolderChange[];
  createFolder?: true;
}

/**
 * Output of `sandbox:change-shared-folder`.
 *
 * - `done` — the changes applied in order, up to and including the first
 *   `conflict` (later changes were not attempted).
 * - `unavailable` — this deployment can't write shared folders at all (no
 *   storage pool, no export). Decided before the paths matter.
 *
 * A REFUSAL (a path through a symlink or a file, a non-empty directory, a
 * directory in the way, a bad path, over a cap) or a storage failure THROWS;
 * it is never `done` with fewer results.
 */
export type ChangeSharedFolderOutput =
  | { kind: 'done'; results: SharedFolderChangeResult[] }
  | { kind: 'unavailable' };

/**
 * The full `sandbox:change-shared-folder` handler signature — satisfied via
 * `registerService<ChangeSharedFolderInput, ChangeSharedFolderOutput>`.
 */
export type ChangeSharedFolderHandler = ServiceHandler<
  ChangeSharedFolderInput,
  ChangeSharedFolderOutput
>;

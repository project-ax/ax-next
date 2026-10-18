import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import { isValidSharedFolderId } from '@ax/sandbox-protocol';
import type {
  ChangeSharedFolderInput,
  ChangeSharedFolderOutput,
  DeleteSharedFolderInput,
  DeleteSharedFolderOutput,
  LocalDirMountSpec,
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  ReadSharedFolderInput,
  ReadSharedFolderOutput,
} from '@ax/sandbox-mount-protocol';
import {
  changeConfinedByWalk,
  readConfinedByWalk,
  splitRelPath,
  WalkChangeError,
  WalkPathError,
  WalkReadError,
} from '@ax/user-files-read';

// ---------------------------------------------------------------------------
// shared-folders — the subprocess provider's realization of W2 shared folders
// (design §3.5-§3.8): validating the `shared-folder` mounts a resolver hands
// back, and `sandbox:delete-shared-folder`.
//
// The subprocess sandbox shares the host filesystem and is a DEV-ONLY provider
// (see SECURITY.md): it realizes a shared folder as `mkdir -p <root>/.shared/<id>`
// and hands the runner that HOST path. It does NOT enforce `readOnly` — there is
// no mount namespace to make a path read-only in — so a viewer's "read-only" is
// advisory here (the runner's prompt note says so; the k8s provider enforces it
// with a read-only mount). Everything below is about the one thing that IS
// enforced here: a hostile, drifted or buggy mount resolver can never make this
// provider create, hand out, or delete a path that is not exactly
// `<root>/.shared/<one safe segment>`.
// ---------------------------------------------------------------------------

// LOCAL copies of `SHARED_FOLDERS_DIR` / `SHARED_FOLDERS_MOUNT_BASE` from
// `@ax/sandbox-mount-protocol`: plugins may only `import type` from that package
// (invariant I2 — the lint rule), and these are runtime values.
// `__tests__/shared-folder-mounts.test.ts` asserts they equal the protocol
// constants, so drift fails a test rather than silently moving a mount.
export const SHARED_FOLDERS_DIR = '.shared';
export const SHARED_FOLDERS_MOUNT_BASE = '/shared';

const RESOLVE_HOOK = 'sandbox:resolve-mounts';
const LOCATE_HOOK = 'sandbox:locate-shared-folder';
const DELETE_HOOK = 'sandbox:delete-shared-folder';
const READ_HOOK = 'sandbox:read-shared-folder';
const CHANGE_HOOK = 'sandbox:change-shared-folder';

/** One entry of the runner's `AX_SHARED_FOLDERS` JSON list (key order is part of the contract). */
export interface SharedFolderEnvEntry {
  id: string;
  path: string;
  readOnly: boolean;
}

/**
 * Is `mount` exactly `{ role:'shared-folder', folderId, mountPath:'/shared/<folderId>',
 * hostPath:'<root>/.shared/<folderId>' }` with an absolute, normalized
 * `hostPath`? Returns the proven `folderId`, or the `problem` that disqualifies
 * it. One definition so the session-open path and the delete path can never
 * disagree about what a well-formed shared mount is.
 *
 * `expectedFolderId` additionally pins WHICH folder the mount must be for (the
 * delete path: the id the caller asked to delete).
 */
export function checkSharedFolderMount(
  mount: LocalDirMountSpec,
  expectedFolderId?: string,
): { folderId: string } | { problem: string } {
  if (mount.role !== 'shared-folder') {
    return { problem: `role is ${JSON.stringify(mount.role ?? null)}, not 'shared-folder'` };
  }
  const folderId: unknown = mount.folderId;
  if (!isValidSharedFolderId(folderId)) {
    return { problem: 'folderId is missing or not a valid shared-folder id' };
  }
  if (expectedFolderId !== undefined && folderId !== expectedFolderId) {
    return { problem: 'folderId is not the requested folder' };
  }
  if (mount.mountPath !== `${SHARED_FOLDERS_MOUNT_BASE}/${folderId}`) {
    return { problem: `mountPath is not ${SHARED_FOLDERS_MOUNT_BASE}/<folderId>` };
  }
  const hostPath: unknown = mount.hostPath;
  if (
    typeof hostPath !== 'string' ||
    !path.isAbsolute(hostPath) ||
    path.normalize(hostPath) !== hostPath
  ) {
    return { problem: 'hostPath is not an absolute, normalized path' };
  }
  // `basename` ignores a trailing separator, so compare against the exact join
  // too: it is what makes "exactly <root>/.shared/<folderId>" literal.
  const sharedDir = path.dirname(hostPath);
  if (
    path.basename(hostPath) !== folderId ||
    path.basename(sharedDir) !== SHARED_FOLDERS_DIR ||
    hostPath !== path.join(path.dirname(sharedDir), SHARED_FOLDERS_DIR, folderId)
  ) {
    return { problem: `hostPath is not <root>/${SHARED_FOLDERS_DIR}/<folderId>` };
  }
  return { folderId };
}

/**
 * Validate the `shared-folder` localDir mounts a resolver returned for a
 * session that REQUESTED `requested`, and project them to the runner's env
 * entries. Throws `PluginError('mount-resolve-failed')` — the open-session
 * fail-closed path — on anything malformed. Pure: touches no filesystem, so the
 * caller can validate every mount before realizing any of them.
 *
 * Beyond the per-mount shape, a shared mount for a folder the host did NOT
 * request, or the same folder twice, is a resolver bug: the host picks which
 * folders mount (design §3.5), the resolver only narrows that set.
 *
 * `readOnly` is carried through but never enforced here (see the header);
 * anything other than an explicit `false` is reported read-only, matching the
 * resolvers (a missing flag can only narrow access).
 */
export function validateSharedFolderMounts(
  mounts: readonly LocalDirMountSpec[],
  requested: readonly string[],
  pluginName: string,
): SharedFolderEnvEntry[] {
  const refuse = (reason: string): PluginError =>
    new PluginError({
      code: 'mount-resolve-failed',
      plugin: pluginName,
      hookName: RESOLVE_HOOK,
      message: `refusing a malformed shared-folder mount from the mount resolver: ${reason}`,
    });
  const entries: SharedFolderEnvEntry[] = [];
  const seen = new Set<string>();
  for (const mount of mounts) {
    const checked = checkSharedFolderMount(mount);
    if ('problem' in checked) throw refuse(checked.problem);
    const { folderId } = checked;
    if (!requested.includes(folderId)) throw refuse('folder was not requested for this session');
    if (seen.has(folderId)) throw refuse('folder is mounted more than once');
    seen.add(folderId);
    entries.push({ id: folderId, path: mount.hostPath, readOnly: mount.readOnly !== false });
  }
  return entries;
}

/**
 * Refuse to realize a shared folder through a link. `mkdir -p` FOLLOWS symlinks:
 * a `.shared` (or `.shared/<id>`) that is a symlink would make the provider
 * create the folder wherever the link points — and then hand that path to the
 * runner as the shared folder. So, before any mkdir and before anything is
 * stamped, `lstat` both components of an already-validated shared `hostPath`
 * ({@link checkSharedFolderMount}): each must either not exist yet (mkdir will
 * make a real directory) or be a REAL directory. A symlink (dangling or not), a
 * regular file or anything else fails the open closed with `mount-resolve-failed`
 * — the same two shapes {@link deleteSharedFolder} refuses. A component we
 * cannot `lstat` (EACCES, EIO, ...) is also a refusal: unproven is not safe.
 *
 * Same caveat as the delete path: lstat → mkdir is not atomic. This provider is a
 * single-host dev tool whose agents already share the host's uid; the check
 * closes the realistic mistake (a stray link), not a concurrent attacker.
 */
export async function assertSharedFolderConfined(
  hostPath: string,
  folderId: string,
  pluginName: string,
): Promise<void> {
  const refuse = (reason: string, cause?: unknown): PluginError =>
    new PluginError({
      code: 'mount-resolve-failed',
      plugin: pluginName,
      hookName: RESOLVE_HOOK,
      message:
        `refusing to realize shared folder '${folderId}': ${reason}. ` +
        `Nothing was created and the session was not opened.`,
      ...(cause !== undefined ? { cause } : {}),
    });
  const sharedDir = path.dirname(hostPath);
  for (const [dir, label] of [
    [sharedDir, SHARED_FOLDERS_DIR],
    [hostPath, `${SHARED_FOLDERS_DIR}/${folderId}`],
  ] as const) {
    let stat: Stats | undefined;
    try {
      stat = await lstatOrUndefined(dir);
    } catch (cause) {
      throw refuse(`could not inspect '${label}'`, cause);
    }
    if (stat !== undefined && !stat.isDirectory()) {
      throw refuse(`'${label}' is a symlink or not a directory`);
    }
  }
}

// ---------------------------------------------------------------------------
// sandbox:delete-shared-folder
// ---------------------------------------------------------------------------

function deleteError(
  code: string,
  pluginName: string,
  message: string,
  cause?: unknown,
): PluginError {
  return new PluginError({
    code,
    plugin: pluginName,
    hookName: DELETE_HOOK,
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

async function lstatOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(p);
  } catch (err) {
    // Only "not there" is an answer; anything else (EACCES, ENOTDIR, EIO) means
    // we could not tell, and a delete we could not confirm must throw.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Realize `sandbox:delete-shared-folder` for the subprocess provider (design
 * §3.7): locate the folder through `sandbox:locate-shared-folder` and remove
 * ONLY that directory.
 *
 * The locate answer comes from another plugin and is not trusted (the
 * resolver deliberately performs no grant check — by now the grants are gone):
 * the id is validated BEFORE anything is called, and the answer must be exactly
 * `<root>/.shared/<the requested id>` ({@link checkSharedFolderMount}) or
 * nothing is deleted. A delete that did not happen THROWS — the caller keeps its
 * tombstone and retries — so there is no "skipped" success: no resolver loaded is
 * `no-mount-resolver` (unlike agent-delete cleanup, which degrades to a no-op),
 * and a folder that is already gone is the only quiet success (idempotent).
 *
 * Symlinks are never followed out of the root: a `.shared` that is a symlink
 * (or not a directory) is refused, and a folder directory that is itself a
 * symlink has only the LINK unlinked. `fs.rm` does not follow links inside the
 * tree either. (The lstat → rm window is not atomic; this provider is a
 * single-host dev tool whose agents already share the host's uid, and the checks
 * close the realistic mistakes — a stray link — not a concurrent attacker.)
 */
export async function deleteSharedFolder(
  ctx: AgentContext,
  bus: HookBus,
  pluginName: string,
  input: DeleteSharedFolderInput,
): Promise<DeleteSharedFolderOutput> {
  const folderId: unknown = (input as { folderId?: unknown } | undefined)?.folderId;
  if (!isValidSharedFolderId(folderId)) {
    throw deleteError('invalid-folder-id', pluginName, 'folderId is not a valid shared-folder id');
  }
  if (!bus.hasService(LOCATE_HOOK)) {
    throw deleteError(
      'no-mount-resolver',
      pluginName,
      `cannot locate shared folder '${folderId}': no plugin registers '${LOCATE_HOOK}' ` +
        `(load @ax/workspace-localdir for the subprocess/CLI preset). Nothing was deleted.`,
    );
  }

  const { mount } = await bus.call<LocateSharedFolderInput, LocateSharedFolderOutput>(
    LOCATE_HOOK,
    ctx,
    { folderId },
  );

  // Narrow on `kind` and realize only what this provider can; an `nfs` answer is
  // a mis-wired preset (the filestore resolver paired with the subprocess
  // provider) and is an EXPLICIT error, never a silent skip. The `never` default
  // forces a compile error if a new MountSpec member is added unhandled.
  let located: LocalDirMountSpec;
  switch (mount.kind) {
    case 'localDir':
      located = mount;
      break;
    case 'nfs':
      throw deleteError(
        'unrealizable-mount-kind',
        pluginName,
        `subprocess sandbox cannot delete a 'nfs' shared folder (it shares the host filesystem ` +
          `and has no network-mount path). Load @ax/workspace-localdir for the subprocess/CLI ` +
          `preset instead of @ax/workspace-filestore. Nothing was deleted.`,
      );
    default: {
      const kind = (mount as { kind: string }).kind;
      throw deleteError(
        'unrealizable-mount-kind',
        pluginName,
        `subprocess sandbox cannot delete a '${kind}' shared folder. Nothing was deleted.`,
      );
    }
  }

  const checked = checkSharedFolderMount(located, folderId);
  if ('problem' in checked) {
    throw deleteError(
      'unsafe-shared-folder-location',
      pluginName,
      `refusing to delete shared folder '${folderId}': the located path is not ` +
        `<root>/${SHARED_FOLDERS_DIR}/${folderId} (${checked.problem}). Nothing was deleted.`,
    );
  }

  await removeConfined(located.hostPath, folderId, pluginName);
  ctx.logger.info('shared_folder_deleted', { folderId });
  return { deleted: true };
}

async function removeConfined(
  hostPath: string,
  folderId: string,
  pluginName: string,
): Promise<void> {
  // `.shared` must be a real directory. If it is a symlink, `rm` of a child
  // would resolve through it to wherever it points; refuse rather than guess.
  const sharedDir = path.dirname(hostPath);
  const sharedStat = await lstatOrUndefined(sharedDir);
  if (sharedStat === undefined) return; // no `.shared` yet → nothing to delete
  if (!sharedStat.isDirectory()) {
    throw deleteError(
      'unsafe-shared-folder-location',
      pluginName,
      `refusing to delete shared folder '${folderId}': '${SHARED_FOLDERS_DIR}' is a symlink or ` +
        `not a directory. Nothing was deleted.`,
    );
  }

  const stat = await lstatOrUndefined(hostPath);
  if (stat === undefined) return; // already gone → idempotent success
  if (stat.isSymbolicLink()) {
    // Drop the link itself; its target is not ours to delete.
    await fs.unlink(hostPath);
    return;
  }
  await fs.rm(hostPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// sandbox:read-shared-folder (W3b)
// ---------------------------------------------------------------------------

/** Most entries in one listing when the caller does not say (matches k8s). */
const READ_MAX_ENTRIES = 5000;

function readError(code: string, pluginName: string, message: string, cause?: unknown): PluginError {
  return new PluginError({
    code,
    plugin: pluginName,
    hookName: READ_HOOK,
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Realize `sandbox:read-shared-folder` for the subprocess provider: the host's
 * read-only view of one folder. NO GRANT CHECK — the only caller,
 * `@ax/projects`, checks the person can use the project first.
 *
 * Where: the resolver's `sandbox:locate-shared-folder` answer, which must be
 * exactly `<root>/.shared/<the requested id>` ({@link checkSharedFolderMount}).
 * How: `readConfinedByWalk` from `<root>` — the one path opened by name, and
 * only after the shape check — then `.shared`, `<id>` and each caller
 * component opened relative to the previous descriptor with O_NOFOLLOW. A
 * symlink the agent planted at any depth is `absent`, never followed, even
 * one swapped in mid-read. (Unlike the delete path above, this one is not
 * check-then-use: there is no window.)
 *
 * `unavailable` when no resolver is loaded, or off Linux (the walk needs
 * /proc). A read that failed throws. `walk` is injectable for tests only.
 */
export async function readSharedFolder(
  ctx: AgentContext,
  bus: HookBus,
  pluginName: string,
  input: ReadSharedFolderInput,
  walk: typeof readConfinedByWalk = readConfinedByWalk,
): Promise<ReadSharedFolderOutput> {
  if (!bus.hasService(LOCATE_HOOK)) return { kind: 'unavailable' };
  const folderId: unknown = (input as { folderId?: unknown } | undefined)?.folderId;
  if (!isValidSharedFolderId(folderId)) {
    throw readError('invalid-payload', pluginName, 'folderId is not a valid shared-folder id');
  }
  let rel: string[];
  try {
    rel = splitRelPath(input.relPath ?? '');
  } catch (err) {
    if (err instanceof WalkPathError) {
      throw readError('invalid-payload', pluginName, `invalid relPath: ${err.message}`, err);
    }
    throw err;
  }

  const { mount } = await bus.call<LocateSharedFolderInput, LocateSharedFolderOutput>(
    LOCATE_HOOK,
    ctx,
    { folderId },
  );
  if (mount.kind !== 'localDir') {
    throw readError(
      'unrealizable-mount-kind',
      pluginName,
      `subprocess sandbox cannot read a '${String(mount.kind)}' shared folder. Load ` +
        `@ax/workspace-localdir for the subprocess/CLI preset instead of @ax/workspace-filestore.`,
    );
  }
  const checked = checkSharedFolderMount(mount, folderId);
  if ('problem' in checked) {
    throw readError(
      'unsafe-shared-folder-location',
      pluginName,
      `refusing to read shared folder '${folderId}': the located path is not ` +
        `<root>/${SHARED_FOLDERS_DIR}/${folderId} (${checked.problem})`,
    );
  }
  // Proven `<root>/.shared/<folderId>`, so this is `<root>`.
  const root = path.dirname(path.dirname(mount.hostPath));

  try {
    const out = await walk(root, [SHARED_FOLDERS_DIR, folderId, ...rel], {
      limitBytes: input.limitBytes,
      maxEntries: input.maxEntries ?? READ_MAX_ENTRIES,
    });
    if (out.kind === 'absent') {
      // The reason is for our log only (a link-vs-missing split is an oracle).
      ctx.logger.debug('shared_folder_read_absent', { folderId, reason: out.reason });
      return { kind: 'absent' };
    }
    return out;
  } catch (err) {
    if (err instanceof WalkReadError && err.code === 'unsupported-platform') {
      return { kind: 'unavailable' };
    }
    // The walk adds `.shared/<id>` to the caller's parts, so a relPath that
    // passed splitRelPath can still be too deep. Same answer as k8s.
    if (err instanceof WalkPathError) {
      throw readError('invalid-payload', pluginName, `invalid relPath: ${err.message}`, err);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sandbox:change-shared-folder (W3c)
// ---------------------------------------------------------------------------

// LOCAL copies of `SHARED_FOLDER_CHANGE_MAX_*` from `@ax/sandbox-mount-protocol`
// (type-only imports from that package, like `SHARED_FOLDERS_DIR` above).
// `__tests__/shared-folders-change.test.ts` pins them to the protocol constants.
export const CHANGE_MAX_CHANGES = 64;
export const CHANGE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CHANGE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Mode of a `.shared` this path creates: the same `0700` session open uses. */
const SHARED_DIR_MODE = 0o700;

function changeError(
  code: string,
  pluginName: string,
  message: string,
  extra: { cause?: unknown; reasonCode?: string } = {},
): PluginError {
  return new PluginError({
    code,
    plugin: pluginName,
    hookName: CHANGE_HOOK,
    message,
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
    ...(extra.reasonCode !== undefined ? { reasonCode: extra.reasonCode } : {}),
  });
}

/**
 * The checks that need no disk and no other plugin: the folder id, the shape
 * of `changes`, the three caps, and every path. The walk repeats all of this
 * (it is the authority); we run it first so a bad call never reaches the
 * resolver or creates `.shared`.
 */
function precheckChange(input: ChangeSharedFolderInput, pluginName: string): string {
  const raw = input as Partial<ChangeSharedFolderInput> | undefined;
  const folderId: unknown = raw?.folderId;
  if (!isValidSharedFolderId(folderId)) {
    throw changeError('invalid-payload', pluginName, 'folderId is not a valid shared-folder id');
  }
  const refuse = (reasonCode: string, message: string, cause?: unknown): PluginError =>
    changeError('invalid-payload', pluginName, message, { reasonCode, cause });
  const changes: unknown = raw?.changes;
  if (!Array.isArray(changes)) throw refuse('invalid-change', 'changes must be an array');
  if (changes.length > CHANGE_MAX_CHANGES) {
    throw refuse('too-many-changes', `more than ${CHANGE_MAX_CHANGES} changes`);
  }
  let total = 0;
  for (const change of changes as Array<Partial<{ path: unknown; content: unknown }> | null>) {
    if (typeof change?.path !== 'string') throw refuse('invalid-change', 'a change needs a path');
    try {
      splitRelPath(change.path);
    } catch (err) {
      if (err instanceof WalkPathError) {
        throw refuse(err.code, `invalid change path: ${err.message}`, err);
      }
      throw err;
    }
    if (change.content instanceof Uint8Array) {
      if (change.content.length > CHANGE_MAX_FILE_BYTES) throw refuse('too-large', 'a file is too large');
      total += change.content.length;
      if (total > CHANGE_MAX_TOTAL_BYTES) throw refuse('too-large', 'the changes are too large');
    }
  }
  return folderId;
}

/**
 * Realize `sandbox:change-shared-folder` for the subprocess provider: the
 * host's WRITE path into one folder (a person saving, creating or deleting a
 * project file; `@ax/projects` seeding a new project). NO GRANT CHECK — the
 * only caller, `@ax/projects`, checks the person may edit the project first.
 *
 * Where: exactly as {@link readSharedFolder} — the resolver's
 * `sandbox:locate-shared-folder` answer, which must be exactly
 * `<root>/.shared/<the requested id>` ({@link checkSharedFolderMount}).
 * How: `changeConfinedByWalk` from `<root>` with NO chown (the dev provider
 * runs as the agent's uid already). Every component below `<root>` is opened
 * relative to the previous descriptor with O_NOFOLLOW, so a symlink the agent
 * planted anywhere in the folder is refused, never written through.
 *
 * `createFolder`: a missing `.shared` is made with `mkdir -p`, mode 0700, the
 * same thing session open does — and, like session open, only after `lstat`
 * proves `.shared` is a real directory or absent (`mkdir -p` follows links).
 * The folder directory itself is made by the walk (`createBase`, 0700,
 * O_NOFOLLOW). Without `createFolder`, a missing folder throws the walk's
 * `WalkReadError` (`code: 'ENOENT'`), as the contract says.
 *
 * Answers:
 * - `unavailable` when no resolver is loaded, or off Linux (the walk needs
 *   /proc). Off Linux a `createFolder` call may still have made an empty
 *   `.shared`, exactly as session open there would.
 * - `done` with one result per applied change. A `conflict` is a RESULT (the
 *   last one), never an error.
 * - A REFUSAL throws `PluginError` code `invalid-payload` with `reasonCode` =
 *   the walk's code: `invalid-path` (WalkPathError), or WalkChangeError's
 *   `too-large` | `too-many-changes` | `invalid-change` | `link-or-not-dir` |
 *   `not-empty` | `is-directory`. W3b maps `WalkPathError` to
 *   `invalid-payload` too. The walk error is the `cause`; a WalkChangeError
 *   cause carries `applied` (the changes that took effect before the refusal).
 * - A storage failure (`WalkReadError`: EACCES, EIO, a missing folder) throws
 *   unchanged, as the read does.
 *
 * `walk` is injectable for tests only.
 */
export async function changeSharedFolder(
  ctx: AgentContext,
  bus: HookBus,
  pluginName: string,
  input: ChangeSharedFolderInput,
  walk: typeof changeConfinedByWalk = changeConfinedByWalk,
): Promise<ChangeSharedFolderOutput> {
  if (!bus.hasService(LOCATE_HOOK)) return { kind: 'unavailable' };
  const folderId = precheckChange(input, pluginName);

  const { mount } = await bus.call<LocateSharedFolderInput, LocateSharedFolderOutput>(
    LOCATE_HOOK,
    ctx,
    { folderId },
  );
  if (mount.kind !== 'localDir') {
    throw changeError(
      'unrealizable-mount-kind',
      pluginName,
      `subprocess sandbox cannot change a '${String(mount.kind)}' shared folder. Load ` +
        `@ax/workspace-localdir for the subprocess/CLI preset instead of @ax/workspace-filestore.`,
    );
  }
  const checked = checkSharedFolderMount(mount, folderId);
  if ('problem' in checked) {
    throw changeError(
      'unsafe-shared-folder-location',
      pluginName,
      `refusing to change shared folder '${folderId}': the located path is not ` +
        `<root>/${SHARED_FOLDERS_DIR}/${folderId} (${checked.problem}). Nothing was changed.`,
    );
  }
  // Proven `<root>/.shared/<folderId>`.
  const sharedDir = path.dirname(mount.hostPath);
  const root = path.dirname(sharedDir);
  const createFolder = input.createFolder === true;

  if (createFolder) {
    let stat: Stats | undefined;
    try {
      stat = await lstatOrUndefined(sharedDir);
    } catch (cause) {
      throw changeError(
        'unsafe-shared-folder-location',
        pluginName,
        `refusing to create shared folder '${folderId}': could not inspect '${SHARED_FOLDERS_DIR}'`,
        { cause },
      );
    }
    if (stat === undefined) {
      await fs.mkdir(sharedDir, { recursive: true, mode: SHARED_DIR_MODE });
    } else if (!stat.isDirectory()) {
      throw changeError(
        'unsafe-shared-folder-location',
        pluginName,
        `refusing to create shared folder '${folderId}': '${SHARED_FOLDERS_DIR}' is a symlink or ` +
          `not a directory. Nothing was changed.`,
      );
    }
  }

  try {
    const results = walk(root, [SHARED_FOLDERS_DIR, folderId], input.changes, {
      ...(createFolder ? { createBase: true } : {}),
      maxChanges: CHANGE_MAX_CHANGES,
      maxFileBytes: CHANGE_MAX_FILE_BYTES,
      maxTotalBytes: CHANGE_MAX_TOTAL_BYTES,
    });
    ctx.logger.info('shared_folder_changed', {
      folderId,
      changes: input.changes.length,
      applied: results.length,
      conflict: results.at(-1)?.outcome === 'conflict',
    });
    return { kind: 'done', results };
  } catch (err) {
    if (err instanceof WalkReadError && err.code === 'unsupported-platform') {
      return { kind: 'unavailable' };
    }
    if (err instanceof WalkChangeError) {
      ctx.logger.info('shared_folder_change_refused', {
        folderId,
        reasonCode: err.code,
        index: err.index,
        applied: err.applied.length,
      });
      throw changeError('invalid-payload', pluginName, `change refused: ${err.message}`, {
        cause: err,
        reasonCode: err.code,
      });
    }
    if (err instanceof WalkPathError) {
      throw changeError('invalid-payload', pluginName, `invalid change path: ${err.message}`, {
        cause: err,
        reasonCode: err.code,
      });
    }
    throw err;
  }
}

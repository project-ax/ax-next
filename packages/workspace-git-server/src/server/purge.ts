import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import { z } from 'zod';
import {
  PluginError,
  PURGE_MAX_KEEP,
  PURGE_MAX_PREFIXES,
  validatePurgeSelector,
} from '@ax/core';
import {
  purgeHistoryPaths,
  type GitRunResult,
  type RunGit,
} from '@ax/workspace-git-purge';
import {
  InvalidWorkspaceIdError,
  validateWorkspaceId,
} from '../shared/workspace-id.js';
import { repoPathFor } from '../shared/repo-path.js';
import { PARANOID_GIT_ENV } from './git-env.js';
import { writeError, writeJson } from './listener.js';

// ---------------------------------------------------------------------------
// POST /repos/<id>/purge (TASK-576) — erase a path selector from EVERY version
// of one bare repo: the tip, all history, and the object store. Irreversible.
//
// The listener has already run the method, content-type (application/json),
// bearer-auth and 1 MiB body gates, and URL-regex-validated <id>. Here:
//
//   1. strict body schema + `validatePurgeSelector` -> 400 `validation`
//      (nothing on disk is touched for a rejected body),
//   2. workspace-id re-validation + path resolution (defense-in-depth),
//   3. 404 when the repo does not exist — it is NOT created,
//   4. `purgeHistoryPaths` under a per-repo in-process mutex, with a `runGit`
//      that spawns git exactly like every other handler here: argv array, no
//      shell, PARANOID_GIT_ENV as the COMPLETE env,
//   5. 200 {purged, headOid, rewritten}; 409 `purge_conflict` if the branch
//      moved under us (the algorithm's CAS refused); 500 `purge_failed`
//      otherwise. Messages never carry a path or git's stderr: the paths
//      under the selector are the data being erased.
//
// CONCURRENCY. Two purges of one repo serialize on the mutex below. A
// concurrent `git-receive-pack` is NOT serialized with it (it is a separate
// child process with its own ref locking). The algorithm's compare-and-swap
// `update-ref main <new> <old>` refuses to clobber a push that landed during
// the rewrite (-> 409, nothing lost). What the CAS cannot cover is the
// window AFTER the swap: `gc --prune=now` may delete objects an in-flight
// push has written but not yet referenced. We accept that, because the only
// caller is the host's memory-retirement migration, which runs at host boot
// BEFORE the host serves traffic — and runners only push through the host.
//
// The repo keeps `receive.denyNonFastForwards=true`: the rewrite moves main
// with a local `update-ref`, which that setting does not govern, so nothing
// here weakens it.
// ---------------------------------------------------------------------------

export const PurgeRepoRequestSchema = z
  .object({
    prefixes: z.array(z.string()).min(1).max(PURGE_MAX_PREFIXES),
    keep: z.array(z.string()).max(PURGE_MAX_KEEP).optional(),
  })
  .strict();

/** A purge can outlive the listener's 60 s idle timeout on a large repo (gc). */
const PURGE_SOCKET_TIMEOUT_MS = 15 * 60_000;

// Per-repo mutex, keyed by the resolved repo path (so two listener instances
// in one process over the same root still serialize).
const repoLocks = new Map<string, Promise<void>>();

async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => mine);
  repoLocks.set(repoPath, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (repoLocks.get(repoPath) === tail) repoLocks.delete(repoPath);
  }
}

function makeRunGit(registerChild?: (child: ChildProcess) => () => void): RunGit {
  return (args, opts) =>
    new Promise<GitRunResult>((resolve, reject) => {
      const input = opts?.input;
      const child = spawn('git', [...args], {
        env: { ...PARANOID_GIT_ENV } as NodeJS.ProcessEnv,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      // Drain bookkeeping: on a shutdown timeout the listener SIGKILLs these.
      // The algorithm is crash-safe (main only moves by one verified CAS; a
      // leftover temp ref is recovered on the next run).
      registerChild?.(child);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (c: Buffer) => out.push(c));
      child.stderr?.on('data', (c: Buffer) => err.push(c));
      child.once('error', reject);
      child.once('close', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
      if (input !== undefined && child.stdin !== null) {
        child.stdin.on('error', () => undefined); // EPIPE: the exit code tells the story
        child.stdin.end(input);
      }
    });
}

// The purge routine's step names that mean "main moved under us".
function isConcurrentChange(message: string): boolean {
  return message.includes('update-ref main failed') || message.includes('main moved');
}

export async function handlePurgeRepo(
  workspaceId: string,
  rawBody: unknown,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { repoRoot: string; registerChild?: (child: ChildProcess) => () => void },
): Promise<void> {
  // 1. Body.
  const parsed = PurgeRepoRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const message =
      first !== undefined
        ? `${first.path.join('.') || '<root>'}: ${first.message}`
        : 'invalid request body';
    return writeError(res, 400, 'validation', message);
  }
  const prefixes = parsed.data.prefixes;
  const keep = parsed.data.keep ?? [];
  try {
    validatePurgeSelector({ prefixes, keep });
  } catch (err) {
    if (err instanceof PluginError) {
      // validatePurgeSelector names the offending index, never the value.
      return writeError(res, 400, 'validation', err.message);
    }
    throw err;
  }

  // 2. Id + path.
  try {
    validateWorkspaceId(workspaceId);
  } catch (err) {
    if (err instanceof InvalidWorkspaceIdError) {
      return writeError(res, 400, 'invalid_workspace_id', 'invalid workspaceId');
    }
    throw err;
  }
  let repoPath: string;
  try {
    repoPath = repoPathFor(opts.repoRoot, workspaceId);
  } catch (err) {
    process.stderr.write(
      `workspace-git-server: repoPathFor escape on '${workspaceId}': ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'internal server error');
  }

  // 3. Missing repo -> 404, never created.
  if (!existsSync(repoPath)) {
    return writeError(res, 404, 'workspace_not_found', 'workspace not found');
  }

  req.setTimeout(PURGE_SOCKET_TIMEOUT_MS);

  // 4. Purge, serialized per repo.
  let result: Awaited<ReturnType<typeof purgeHistoryPaths>>;
  try {
    result = await withRepoLock(repoPath, async () => {
      if (!existsSync(repoPath)) return null;
      return purgeHistoryPaths({
        gitdir: repoPath,
        prefixes,
        keep,
        runGit: makeRunGit(opts.registerChild),
      });
    }).then((r) => {
      if (r === null) throw new RepoVanishedError();
      return r;
    });
  } catch (err) {
    if (err instanceof RepoVanishedError) {
      return writeError(res, 404, 'workspace_not_found', 'workspace not found');
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    // Step name only — the purge routine never puts a path or git stderr in
    // its messages.
    process.stderr.write(`workspace-git-server: purge of '${workspaceId}' failed: ${message}\n`);
    if (isConcurrentChange(message)) {
      return writeError(
        res,
        409,
        'purge_conflict',
        'workspace changed during purge; retry',
      );
    }
    return writeError(res, 500, 'purge_failed', `purge failed: ${message}`);
  }

  // 5. Done.
  return writeJson(res, 200, {
    purged: result.purged,
    headOid: result.version,
    rewritten: result.pastVersionsChanged,
  });
}

class RepoVanishedError extends Error {
  constructor() {
    super('repo vanished');
    this.name = 'RepoVanishedError';
  }
}

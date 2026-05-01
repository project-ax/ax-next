import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import * as http from 'node:http';
import { z } from 'zod';
import {
  InvalidWorkspaceIdError,
  validateWorkspaceId,
} from '../shared/workspace-id.js';
import { repoPathFor } from '../shared/repo-path.js';
import { PARANOID_GIT_ENV } from './git-env.js';
import { writeError, writeJson } from './listener.js';

// ---------------------------------------------------------------------------
// Lifecycle handlers — POST /repos (Slice 2), GET /repos/<id> (Slice 3),
// DELETE /repos/<id> (Slice 4). The listener has already:
//
//   - verified the method
//   - verified content-type for POST
//   - verified bearer auth
//   - parsed the JSON body for POST
//
// so handlers here only deal with schema validation, workspaceId validation,
// path resolution, and git invocation. PARANOID_GIT_ENV is the COMPLETE env
// for every spawn — never merged with process.env.
// ---------------------------------------------------------------------------

export const CreateRepoRequestSchema = z
  .object({
    workspaceId: z.string(),
  })
  .strict();

export type CreateRepoRequest = z.infer<typeof CreateRepoRequestSchema>;

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

// Test seam: tests inject a spy here to inspect argv + env. Production code
// calls the default `spawn` import. ESM module-namespace exports can't be
// redefined at runtime (vi.spyOn fails on `node:child_process`), so we use
// a local indirection.
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

let _spawn: SpawnFn = spawn as unknown as SpawnFn;

export function __setSpawnForTest(fn: SpawnFn | null): void {
  _spawn = fn ?? (spawn as unknown as SpawnFn);
}

/**
 * Run `git` with the given argv. PARANOID_GIT_ENV is the complete env (no
 * merge with process.env). Argv-array form only — no shell, no string-form.
 */
function runGit(args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = _spawn('git', [...args], {
      env: { ...PARANOID_GIT_ENV } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdout.push(c));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

const PER_REPO_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['receive.denyDeletes', 'true'],
  ['receive.denyNonFastForwards', 'true'],
  ['core.hooksPath', '/dev/null'],
  ['protocol.allow', 'never'],
  ['uploadpack.allowAnySHA1InWant', 'false'],
];

/**
 * Best-effort cleanup of a partially-created bare repo. Errors are swallowed
 * (mirrors v1 http-server.js:285-295) — the goal is not leaving behind a
 * half-initialized directory after a failed `git init`.
 */
async function cleanupPartial(repoPath: string): Promise<void> {
  try {
    await rm(repoPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export async function handleCreateRepo(
  rawBody: unknown,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): Promise<void> {
  // 1. Schema validation
  const parsed = CreateRepoRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const message =
      first !== undefined
        ? `${first.path.join('.') || '<root>'}: ${first.message}`
        : 'invalid request body';
    return writeError(res, 400, 'validation', message);
  }

  // 2. Workspace-id validation. Don't echo the offending input.
  try {
    validateWorkspaceId(parsed.data.workspaceId);
  } catch (err) {
    if (err instanceof InvalidWorkspaceIdError) {
      return writeError(res, 400, 'invalid_workspace_id', 'invalid workspaceId');
    }
    throw err;
  }
  const workspaceId = parsed.data.workspaceId;

  // 3. Path resolution. A bug here would be ours, not the client's, but we
  // surface it as 500 internal_error and log to stderr. validateWorkspaceId
  // already rejected anything that could traverse, so this is defense-in-depth.
  let repoPath: string;
  try {
    repoPath = repoPathFor(opts.repoRoot, workspaceId);
  } catch (err) {
    process.stderr.write(
      `workspace-git-server: repoPathFor escape on '${workspaceId}': ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'internal server error');
  }

  // 4. Atomic create. Two concurrent POSTs for the same id race here; whoever
  // wins mkdir owns the dir. The loser sees EEXIST and gets the documented
  // 409. Crucially, only the winner sets `createdByThisRequest`, so on a
  // later failure path the loser's `cleanupPartial` is a no-op — we never
  // delete a peer's freshly-initialized repo.
  let createdByThisRequest = false;
  try {
    await mkdir(repoPath);
    createdByThisRequest = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return writeError(
        res,
        409,
        'workspace_already_exists',
        'workspace already exists',
      );
    }
    process.stderr.write(
      `workspace-git-server: mkdir failed for '${workspaceId}': ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'create failed');
  }

  // 5. git init --bare --initial-branch=main <repoPath>. Running `git init
  // --bare` against an existing empty dir is fine — it populates it.
  let initResult: SpawnResult;
  try {
    initResult = await runGit([
      'init',
      '--bare',
      '--initial-branch=main',
      repoPath,
    ]);
  } catch (err) {
    process.stderr.write(
      `workspace-git-server: git init spawn failed: ${(err as Error).message}\n`,
    );
    if (createdByThisRequest) await cleanupPartial(repoPath);
    return writeError(res, 500, 'internal_error', 'git init failed');
  }
  if (initResult.code !== 0) {
    process.stderr.write(
      `workspace-git-server: git init exited ${initResult.code}: ${initResult.stderr}\n`,
    );
    if (createdByThisRequest) await cleanupPartial(repoPath);
    return writeError(res, 500, 'internal_error', 'git init failed');
  }

  // 6. Lock down the per-repo config.
  for (const [key, value] of PER_REPO_CONFIG) {
    let cfgResult: SpawnResult;
    try {
      cfgResult = await runGit(['-C', repoPath, 'config', key, value]);
    } catch (err) {
      process.stderr.write(
        `workspace-git-server: git config spawn failed: ${(err as Error).message}\n`,
      );
      if (createdByThisRequest) await cleanupPartial(repoPath);
      return writeError(res, 500, 'internal_error', 'git config failed');
    }
    if (cfgResult.code !== 0) {
      process.stderr.write(
        `workspace-git-server: git config '${key}' exited ${cfgResult.code}: ${cfgResult.stderr}\n`,
      );
      if (createdByThisRequest) await cleanupPartial(repoPath);
      return writeError(res, 500, 'internal_error', 'git config failed');
    }
  }

  // 7. Done.
  return writeJson(res, 201, {
    workspaceId,
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// GET /repos/<id> — Slice 3
// ---------------------------------------------------------------------------

export async function handleGetRepo(
  workspaceId: string,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): Promise<void> {
  // Listener already URL-regex-validated workspaceId (only matches the same
  // class as WORKSPACE_ID_REGEX). Defense-in-depth: re-run validateWorkspaceId
  // to keep handler-level invariant local and obvious.
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

  if (!existsSync(repoPath)) {
    return writeError(res, 404, 'workspace_not_found', 'workspace not found');
  }

  // rev-parse refs/heads/main. Empty stdout (or non-zero exit) -> headOid:null.
  let result: SpawnResult;
  try {
    result = await runGit([
      '-C',
      repoPath,
      'rev-parse',
      '--quiet',
      '--verify',
      'refs/heads/main',
    ]);
  } catch (err) {
    process.stderr.write(
      `workspace-git-server: git rev-parse spawn failed: ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'git rev-parse failed');
  }

  let headOid: string | null = null;
  const out = result.stdout.trim();
  if (result.code === 0 && out.length > 0) {
    headOid = out;
  }
  return writeJson(res, 200, { workspaceId, exists: true, headOid });
}

// ---------------------------------------------------------------------------
// DELETE /repos/<id> — Slice 4
// ---------------------------------------------------------------------------

export async function handleDeleteRepo(
  workspaceId: string,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): Promise<void> {
  // Defense-in-depth re-validation (URL regex already enforced).
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

  // Idempotent: 204 whether or not the path existed. force:true ignores
  // ENOENT, but rm can still throw on permission/IO errors — surface those
  // as a controlled 500 instead of letting them bubble as unhandled rejections.
  try {
    await rm(repoPath, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `workspace-git-server: rm failed for '${workspaceId}': ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'delete failed');
  }

  if (res.headersSent || res.writableEnded) return;
  res.writeHead(204);
  res.end();
}

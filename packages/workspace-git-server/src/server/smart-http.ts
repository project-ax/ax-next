import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import {
  InvalidWorkspaceIdError,
  validateWorkspaceId,
} from '../shared/workspace-id.js';
import { repoPathFor } from '../shared/repo-path.js';
import { PARANOID_GIT_ENV } from './git-env.js';
import { writeError } from './listener.js';

// ---------------------------------------------------------------------------
// Smart-HTTP handlers — three routes:
//
//   GET  /<id>.git/info/refs?service=git-{upload|receive}-pack   (Slice 1)
//   POST /<id>.git/git-upload-pack                                (Slice 2)
//   POST /<id>.git/git-receive-pack                               (Slice 3)
//
// The listener has already enforced auth and URL-regex-validated <id>. These
// handlers re-validate (defense-in-depth), check the bare repo exists, then
// spawn `git {upload-pack|receive-pack} --stateless-rpc` with PARANOID_GIT_ENV
// and stream bytes between the request and the child.
//
// Argv shape comes from the plan, "Git protocol surface" / "Spawn policy":
//   git -c protocol.allow=never -c safe.directory=<repo> <subcmd> --stateless-rpc [--advertise-refs] <repo>
//
// Discovery wraps the response in a pkt-line preamble per RFC 5816 (mirrors
// v1 http-server.js:118-127). Pack exchange streams stdout straight to the
// response. EPIPE on git stdin is logged + swallowed (mirrors v1
// http-server.js:107-109).
// ---------------------------------------------------------------------------

const VALID_SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

let _spawn: SpawnFn = spawn as unknown as SpawnFn;

export function __setSpawnForTest(fn: SpawnFn | null): void {
  _spawn = fn ?? (spawn as unknown as SpawnFn);
}

interface ResolveOk {
  ok: true;
  repoPath: string;
  workspaceId: string;
}
interface ResolveErr {
  ok: false;
}

/**
 * Defense-in-depth re-validate workspaceId, resolve the repo path, and
 * verify the bare repo exists on disk. Writes a 4xx/5xx response on failure
 * and returns { ok: false }; on success returns the resolved path.
 */
function resolveRepo(
  workspaceId: string,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): ResolveOk | ResolveErr {
  try {
    validateWorkspaceId(workspaceId);
  } catch (err) {
    if (err instanceof InvalidWorkspaceIdError) {
      writeError(res, 400, 'invalid_workspace_id', 'invalid workspaceId');
      return { ok: false };
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
    writeError(res, 500, 'internal_error', 'internal server error');
    return { ok: false };
  }

  if (!existsSync(repoPath)) {
    writeError(res, 404, 'workspace_not_found', 'workspace not found');
    return { ok: false };
  }
  return { ok: true, repoPath, workspaceId };
}

/**
 * Spawn `git` with the PARANOID env. Argv-array form only — never shell.
 * Caller picks stdio shape (discovery uses `'ignore'` for stdin; pack
 * exchange uses `'pipe'`).
 */
function spawnGit(
  args: readonly string[],
  stdio: SpawnOptions['stdio'],
): ChildProcess {
  return _spawn('git', [...args], {
    env: { ...PARANOID_GIT_ENV } as NodeJS.ProcessEnv,
    stdio,
  });
}

// ---- Discovery (Slice 1) -------------------------------------------------

/**
 * Build the 4-byte hex length prefix for a pkt-line. Length includes the 4
 * bytes of the prefix itself (per RFC 5816 / git smart-HTTP spec).
 */
function pktLineLengthPrefix(payload: string): string {
  const total = Buffer.byteLength(payload, 'utf8') + 4;
  return total.toString(16).padStart(4, '0');
}

export async function handleDiscovery(
  workspaceId: string,
  service: string,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): Promise<void> {
  // Defense-in-depth: the listener's match() already filters service to one of
  // the two valid values, but re-check here so this handler is safe in
  // isolation. The empty-string case (missing service= query) lands here too.
  if (!VALID_SERVICES.has(service)) {
    return writeError(res, 400, 'validation', 'invalid service parameter');
  }

  const resolved = resolveRepo(workspaceId, res, opts);
  if (!resolved.ok) return;
  const { repoPath } = resolved;

  const subcmd = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
  const advertisementCt = `application/x-${service}-advertisement`;

  let child: ChildProcess;
  try {
    child = spawnGit(
      [
        '-c',
        'protocol.allow=never',
        '-c',
        `safe.directory=${repoPath}`,
        subcmd,
        '--stateless-rpc',
        '--advertise-refs',
        repoPath,
      ],
      ['ignore', 'pipe', 'pipe'],
    );
  } catch (err) {
    process.stderr.write(
      `workspace-git-server: git ${subcmd} spawn failed: ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'git spawn failed');
  }

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[git ${subcmd}] ${chunk.toString('utf8')}`);
  });

  let headersWritten = false;

  child.on('error', (err) => {
    process.stderr.write(
      `workspace-git-server: git ${subcmd} child error: ${err.message}\n`,
    );
    if (!headersWritten && !res.headersSent) {
      headersWritten = true;
      writeError(res, 500, 'internal_error', 'git process error');
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* best-effort */
      }
    }
  });

  // Commit to a 200 + write the pkt-line preamble immediately, then pipe
  // git stdout into the response. v1 takes the same shape (http-server.js
  // :119-130). Deferring headers until first byte introduced an
  // ordering hazard between `once('data')` and `on('data')` that
  // duplicated the first chunk on the wire.
  res.writeHead(200, {
    'Content-Type': advertisementCt,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  headersWritten = true;
  const msg = `# service=${service}\n`;
  res.write(pktLineLengthPrefix(msg) + msg);
  res.write('0000');

  child.stdout!.pipe(res);

  child.on('close', (code) => {
    if (code !== 0) {
      process.stderr.write(
        `workspace-git-server: git ${subcmd} exited ${code}\n`,
      );
    }
    // res.end() is driven by stdout pipe close.
  });

  // Client disconnect: kill the child so we don't leak.
  res.once('close', () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* best-effort */
      }
    }
  });
}

// ---- Pack exchange (Slice 2 + Slice 3) -----------------------------------

/**
 * Shared implementation for upload-pack and receive-pack POST routes. Pipes
 * `req` body → git stdin, git stdout → response. The bare repo's locked-down
 * config (set at POST /repos time) enforces server-side policy; nothing per
 * spawn beyond `protocol.allow=never` + `safe.directory`.
 */
async function handlePackExchange(
  workspaceId: string,
  subcmd: 'upload-pack' | 'receive-pack',
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): Promise<void> {
  const resolved = resolveRepo(workspaceId, res, opts);
  if (!resolved.ok) return;
  const { repoPath } = resolved;

  const service = `git-${subcmd}`;
  const resultCt = `application/x-${service}-result`;

  let child: ChildProcess;
  try {
    child = spawnGit(
      [
        '-c',
        'protocol.allow=never',
        '-c',
        `safe.directory=${repoPath}`,
        subcmd,
        '--stateless-rpc',
        repoPath,
      ],
      ['pipe', 'pipe', 'pipe'],
    );
  } catch (err) {
    process.stderr.write(
      `workspace-git-server: git ${subcmd} spawn failed: ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'git spawn failed');
  }

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[git ${subcmd}] ${chunk.toString('utf8')}`);
  });

  // EPIPE on git stdin: log + ignore (mirrors v1 http-server.js:107-109).
  // Happens when git exits before reading the entire request body.
  child.stdin?.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
      process.stderr.write(
        `workspace-git-server: git ${subcmd} stdin error: ${err.message}\n`,
      );
    }
  });

  // Track whether we've already emitted a 5xx for an early error. After
  // headersWritten is true, we can't change the status anymore — best we can
  // do is end the response.
  let headersWritten = false;

  child.on('error', (err) => {
    process.stderr.write(
      `workspace-git-server: git ${subcmd} child error: ${err.message}\n`,
    );
    if (!headersWritten && !res.headersSent) {
      headersWritten = true;
      writeError(res, 500, 'internal_error', 'git process error');
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* best-effort */
      }
    }
  });

  req.on('error', (err) => {
    process.stderr.write(
      `workspace-git-server: request stream error: ${err.message}\n`,
    );
    try {
      child.stdin?.destroy();
    } catch {
      /* best-effort */
    }
  });

  // Commit to a 200 response immediately. Pack exchange virtually always
  // produces output; deferring headers until first byte adds buffering
  // complexity that interleaves badly with stream piping (and seems to be
  // the cause of "expected ACK/NAK" wire errors). v1 takes the same shape.
  res.writeHead(200, {
    'Content-Type': resultCt,
    'Cache-Control': 'no-cache',
  });
  headersWritten = true;

  // Stream req body → git stdin, git stdout → res. pipe() handles backpressure.
  req.pipe(child.stdin!);
  child.stdout!.pipe(res);

  child.on('close', (code) => {
    if (code !== 0) {
      // Already streamed 200 (pack exchange wrote bytes) or about to end with
      // empty stream — either way, log the non-zero exit. Can't change status
      // retroactively.
      process.stderr.write(
        `workspace-git-server: git ${subcmd} exited ${code}\n`,
      );
    }
    // res.end() is driven by the stdout-pipe close.
  });

  res.once('close', () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* best-effort */
      }
    }
  });
}

export async function handleUploadPack(
  workspaceId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): Promise<void> {
  return handlePackExchange(workspaceId, 'upload-pack', req, res, opts);
}

export async function handleReceivePack(
  workspaceId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { repoRoot: string },
): Promise<void> {
  return handlePackExchange(workspaceId, 'receive-pack', req, res, opts);
}

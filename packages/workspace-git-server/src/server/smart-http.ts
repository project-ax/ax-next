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

  // Buffer the child's stdout/stderr until we know the spawn succeeded; if it
  // exits non-zero before any bytes are written we want to emit a 5xx, not
  // half a 200 response.
  let headersWritten = false;
  let earlyError = false;

  // Track stderr for diagnostics only; never echo into the response.
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[git ${subcmd}] ${chunk.toString('utf8')}`);
  });

  child.on('error', (err) => {
    process.stderr.write(
      `workspace-git-server: git ${subcmd} child error: ${err.message}\n`,
    );
    if (!headersWritten && !res.headersSent) {
      earlyError = true;
      writeError(res, 500, 'internal_error', 'git process error');
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* best-effort */
      }
    }
  });

  // We commit to a 200 + preamble as soon as the child produces ANY stdout
  // bytes. Until then, an exit with non-zero code can still emit a 5xx.
  const onFirstData = (firstChunk: Buffer): void => {
    if (earlyError || res.headersSent) return;
    res.writeHead(200, {
      'Content-Type': advertisementCt,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    headersWritten = true;
    // Pkt-line preamble: "# service=<service>\n" wrapped + flush packet.
    const msg = `# service=${service}\n`;
    res.write(pktLineLengthPrefix(msg) + msg);
    res.write('0000');
    res.write(firstChunk);
  };

  child.stdout?.once('data', onFirstData);
  child.stdout?.on('data', (chunk: Buffer) => {
    if (!headersWritten) return; // first-data handler will write
    if (res.writableEnded) return;
    res.write(chunk);
  });

  child.on('close', (code) => {
    if (earlyError) return;
    if (!headersWritten) {
      // Never produced any bytes. If exit is zero, write an empty-but-valid
      // advertisement (preamble + flush, no refs after); if non-zero, 500.
      if (code === 0) {
        res.writeHead(200, {
          'Content-Type': advertisementCt,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        const msg = `# service=${service}\n`;
        res.write(pktLineLengthPrefix(msg) + msg);
        res.write('0000');
        res.end();
      } else {
        writeError(res, 500, 'internal_error', 'git process failed');
      }
      return;
    }
    if (!res.writableEnded) {
      res.end();
    }
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

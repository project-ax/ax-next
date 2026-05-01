import * as http from 'node:http';
import { checkBearerToken } from './auth.js';
// repos.ts imports back from this module for writeError / writeJson; keep
// the import below the helpers' definitions to avoid TDZ on the named exports.
// (ESM bindings are live, but the function-level call is what matters.)
import { handleCreateRepo, handleGetRepo } from './repos.js';

// ---------------------------------------------------------------------------
// HTTP listener — TCP front for @ax/workspace-git-server.
//
// Slice 1 wires up the five-gate dispatch + /healthz + body parser. The
// lifecycle routes (POST /repos, GET /repos/<id>, DELETE /repos/<id>) and the
// smart-HTTP routes (*/info/refs, git-upload-pack, git-receive-pack) are
// recognized by the router but stubbed as 503 not_implemented; later slices
// fill them in.
//
// Five inbound gates (in order):
//   1. Method        — only GET / POST / DELETE. Other -> 405.
//   2. /healthz      — GET only, returned 200 BEFORE auth (probes work even
//                      without a configured token client-side).
//   3. Content-Type  — POST must carry application/json. Otherwise -> 415.
//   4. Auth          — Authorization: Bearer <token>, constant-time compare.
//                      Missing/malformed/wrong -> 401, token NEVER echoed.
//   5. Body size     — POST only. Cap is 1 MiB (this package's cap, NOT
//                      the sibling's 4 MiB MAX_FRAME). Fail-fast on declared
//                      Content-Length, mid-stream enforcement on chunked.
//                      Over -> 413; bad JSON -> 400; absent body -> 400.
//
// Idle timeout: 60 s, matching the sibling listener.
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 60_000;
const BODY_LIMIT_BYTES = 1 * 1024 * 1024; // 1 MiB

export interface WorkspaceGitServer {
  close(): Promise<void>;
  readonly host: string;
  readonly port: number;
}

export interface CreateWorkspaceGitServerOptions {
  /** Bare-repo root directory; must already exist. */
  repoRoot: string;
  /** e.g. '127.0.0.1' or '0.0.0.0'. */
  host: string;
  /** Pass 0 for OS-assigned, read back via .port. */
  port: number;
  /** Bearer auth token; constant-time compared. */
  token: string;
}

// ---- Error envelope ------------------------------------------------------

export type ErrorTag =
  | 'unauthorized'
  | 'invalid_workspace_id'
  | 'workspace_not_found'
  | 'workspace_already_exists'
  | 'body_too_large'
  | 'invalid_json'
  | 'validation'
  | 'unsupported_method'
  | 'unsupported_content_type'
  | 'internal_error'
  | 'not_implemented';

export function writeError(
  res: http.ServerResponse,
  status: number,
  error: ErrorTag,
  message: string,
): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify({ error, message });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---- Routing -------------------------------------------------------------

export type RouteMatch =
  | { kind: 'healthz' }
  | { kind: 'create-repo' }
  | { kind: 'get-repo'; workspaceId: string }
  | { kind: 'delete-repo'; workspaceId: string }
  | { kind: 'smart-http-discovery'; workspaceId: string; service: string }
  | { kind: 'smart-http-upload-pack'; workspaceId: string }
  | { kind: 'smart-http-receive-pack'; workspaceId: string }
  // "/repos/<bad-id>" — path shape recognized but the id segment fails the
  // regex. Listener emits 400 invalid_workspace_id for these (distinguishes
  // a malformed id from a totally-unknown path).
  | { kind: 'invalid-repo-id'; method: 'GET' | 'DELETE' | 'PUT' | 'OTHER' }
  | { kind: 'unknown' };

// URL extraction regexes — strict to defend against argv injection:
// the workspaceId class matches WORKSPACE_ID_REGEX from src/shared/workspace-id.ts.
const REPO_ID_RE = /^\/repos\/([a-z0-9][a-z0-9_-]{0,62})$/;
// "Loose" /repos/X pattern — matches any non-empty path under /repos/ so the
// listener can return 400 invalid_workspace_id instead of falling through to
// unknown. We use a permissive prefix match; the strict REPO_ID_RE has
// already had its shot above.
const REPO_ID_LOOSE_RE = /^\/repos\/.+/;
const SMART_HTTP_INFO_REFS_RE =
  /^\/([a-z0-9][a-z0-9_-]{0,62})\.git\/info\/refs$/;
const SMART_HTTP_UPLOAD_PACK_RE =
  /^\/([a-z0-9][a-z0-9_-]{0,62})\.git\/git-upload-pack$/;
const SMART_HTTP_RECEIVE_PACK_RE =
  /^\/([a-z0-9][a-z0-9_-]{0,62})\.git\/git-receive-pack$/;

export function matchRoute(method: string, url: string): RouteMatch {
  // Strip query string for path matching; preserve it for service= parsing.
  const qIdx = url.indexOf('?');
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
  const search = qIdx === -1 ? '' : url.slice(qIdx + 1);

  if (method === 'GET' && pathname === '/healthz') {
    return { kind: 'healthz' };
  }
  if (method === 'POST' && pathname === '/repos') {
    return { kind: 'create-repo' };
  }
  if (method === 'GET') {
    const m = REPO_ID_RE.exec(pathname);
    if (m !== null) return { kind: 'get-repo', workspaceId: m[1]! };
    if (REPO_ID_LOOSE_RE.test(pathname)) {
      return { kind: 'invalid-repo-id', method: 'GET' };
    }
    const sm = SMART_HTTP_INFO_REFS_RE.exec(pathname);
    if (sm !== null) {
      const params = new URLSearchParams(search);
      const service = params.get('service') ?? '';
      return { kind: 'smart-http-discovery', workspaceId: sm[1]!, service };
    }
  }
  if (method === 'DELETE') {
    const m = REPO_ID_RE.exec(pathname);
    if (m !== null) return { kind: 'delete-repo', workspaceId: m[1]! };
    if (REPO_ID_LOOSE_RE.test(pathname)) {
      return { kind: 'invalid-repo-id', method: 'DELETE' };
    }
  }
  if (method === 'PUT' || method === 'PATCH') {
    // Method gate already rejects PUT/PATCH (only GET/POST/DELETE allowed),
    // but if we ever loosen that, surface a method-aware response.
    if (REPO_ID_LOOSE_RE.test(pathname) || REPO_ID_RE.test(pathname)) {
      return { kind: 'invalid-repo-id', method: 'PUT' };
    }
  }
  if (method === 'POST') {
    const up = SMART_HTTP_UPLOAD_PACK_RE.exec(pathname);
    if (up !== null) {
      return { kind: 'smart-http-upload-pack', workspaceId: up[1]! };
    }
    const rp = SMART_HTTP_RECEIVE_PACK_RE.exec(pathname);
    if (rp !== null) {
      return { kind: 'smart-http-receive-pack', workspaceId: rp[1]! };
    }
  }
  return { kind: 'unknown' };
}

// ---- Body parser ---------------------------------------------------------

export class TooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'TooLargeError';
  }
}
export class BadJsonError extends Error {
  constructor(detail: string) {
    super(`invalid json: ${detail}`);
    this.name = 'BadJsonError';
  }
}
export class EmptyBodyError extends Error {
  constructor() {
    super('empty body');
    this.name = 'EmptyBodyError';
  }
}

/**
 * Read the entire IncomingMessage body, enforcing a hard cap. Fail-fast on
 * declared Content-Length over the cap (no bytes buffered); enforce mid-stream
 * for chunked transfer-encoding.
 *
 * - Over the cap -> TooLargeError.
 * - Empty body  -> EmptyBodyError (caller decides whether that's an error).
 * - Non-parseable JSON -> BadJsonError.
 */
export async function readJsonBody(
  req: http.IncomingMessage,
  limitBytes: number,
): Promise<unknown> {
  // Fail-fast on declared Content-Length over the cap. Never buffer a byte.
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > limitBytes) {
      throw new TooLargeError();
    }
  }

  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      cb();
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limitBytes) {
        // Mid-stream cap. Destroy the socket to stop further bytes; respond
        // before that destroy lands by settling the promise immediately.
        settle(() => {
          req.destroy();
          reject(new TooLargeError());
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      settle(() => {
        if (chunks.length === 0) {
          reject(new EmptyBodyError());
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(new BadJsonError((err as Error).message));
        }
      });
    });

    req.on('error', (err) => {
      settle(() => reject(err));
    });
  });
}

// ---- Listener ------------------------------------------------------------

interface DispatchContext {
  match: RouteMatch;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: unknown; // already parsed for POST routes
  opts: CreateWorkspaceGitServerOptions;
}

export async function createWorkspaceGitServer(
  opts: CreateWorkspaceGitServerOptions,
): Promise<WorkspaceGitServer> {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          writeError(res, 500, 'internal_error', 'internal server error');
        } else {
          res.end();
        }
      } catch {
        // best-effort; socket may already be torn down
      }
      process.stderr.write(
        `workspace-git-server: unhandled handler error: ${(err as Error).message}\n`,
      );
    });
  });

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const method = req.method ?? '';
    const url = req.url ?? '/';

    // 1. method gate
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      return writeError(res, 405, 'unsupported_method', 'method not allowed');
    }

    // 2. /healthz pre-auth — match BEFORE running auth so probes don't need
    //    the bearer token.
    const match = matchRoute(method, url);
    if (match.kind === 'healthz') {
      return writeJson(res, 200, { status: 'ok' });
    }

    // 3. content-type gate (POST only)
    if (method === 'POST') {
      const ct = (req.headers['content-type'] ?? '').toLowerCase();
      if (!ct.startsWith('application/json')) {
        return writeError(
          res,
          415,
          'unsupported_content_type',
          'content-type must be application/json',
        );
      }
    }

    // 4. auth gate
    const authResult = checkBearerToken(req.headers.authorization, opts.token);
    if (!authResult.ok) {
      return writeError(res, authResult.status, 'unauthorized', authResult.message);
    }

    // 5. body parse (POST only)
    let body: unknown = undefined;
    if (method === 'POST') {
      try {
        body = await readJsonBody(req, BODY_LIMIT_BYTES);
      } catch (err) {
        if (err instanceof TooLargeError) {
          return writeError(res, 413, 'body_too_large', 'request body too large');
        }
        if (err instanceof BadJsonError) {
          return writeError(res, 400, 'invalid_json', err.message);
        }
        if (err instanceof EmptyBodyError) {
          return writeError(res, 400, 'invalid_json', 'request body required');
        }
        throw err;
      }
    }

    // Dispatch.
    await dispatch({ match, req, res, body, opts });
  };

  // Idle timeout — match the sibling so long-polls aren't killed by Node's
  // default change.
  server.setTimeout(IDLE_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(opts.port, opts.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  // Permanent error listener so a stray server-level error doesn't crash the
  // process. Mirrors the sibling.
  server.on('error', (err) => {
    process.stderr.write(
      `workspace-git-server: server error: ${(err as Error).message}\n`,
    );
  });

  const addr = server.address();
  const boundPort =
    typeof addr === 'object' && addr !== null ? addr.port : opts.port;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    get host() {
      return opts.host;
    },
    get port() {
      return boundPort;
    },
    close,
  };
}

// Dispatch — Slice 2 wires create-repo to its handler; the rest are still
// 503 not_implemented stubs for B3 / Slices 3-4.
async function dispatch(ctx: DispatchContext): Promise<void> {
  switch (ctx.match.kind) {
    case 'healthz':
      // already handled above; defensive return
      return writeJson(ctx.res, 200, { status: 'ok' });
    case 'create-repo':
      return handleCreateRepo(ctx.body, ctx.res, { repoRoot: ctx.opts.repoRoot });
    case 'get-repo':
      return handleGetRepo(ctx.match.workspaceId, ctx.res, {
        repoRoot: ctx.opts.repoRoot,
      });
    case 'invalid-repo-id':
      return writeError(
        ctx.res,
        400,
        'invalid_workspace_id',
        'invalid workspaceId',
      );
    case 'delete-repo':
    case 'smart-http-discovery':
    case 'smart-http-upload-pack':
    case 'smart-http-receive-pack':
    case 'unknown':
      return writeError(
        ctx.res,
        503,
        'not_implemented',
        'route not implemented in this slice',
      );
  }
}

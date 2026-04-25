import * as http from 'node:http';
import { MAX_FRAME, PluginError } from '@ax/core';
import {
  BadJsonError,
  TooLargeError,
  readJsonBody,
  writeJsonOk,
} from '@ax/ipc-core';
import {
  WORKSPACE_ACTION_PATHS,
  WorkspaceApplyRequestSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceListRequestSchema,
  WorkspaceReadRequestSchema,
} from '@ax/workspace-protocol';
import type { z } from 'zod';
import { checkBearerToken } from './auth.js';
import {
  handleApply,
  handleDiff,
  handleList,
  handleRead,
} from './handlers.js';

// ---------------------------------------------------------------------------
// HTTP listener — TCP front for the four workspace.* actions on a single
// repoRoot. Mirrors @ax/ipc-http's listener structurally (five inbound gates,
// boot-time error handler, idle timeout) but swaps the IPC dispatcher for a
// path-keyed handler map. There is no session resolution: auth is a static
// shared bearer token (from the Helm `gitServerAuth` Secret).
//
// Five inbound gates (in order):
//   1. Method        — only POST / GET. Other -> 405.
//   2. /healthz      — GET only, returned 200 BEFORE auth so a probe can
//                      succeed even when no token is configured client-side.
//   3. Content-Type  — POST must carry application/json. Otherwise -> 415.
//   4. Auth          — Authorization: Bearer <token>, constant-time compare
//                      vs. opts.token. Missing/malformed/wrong -> 401
//                      (token value NEVER echoed — invariant I9).
//   5. Body size     — readJsonBody enforces MAX_FRAME (4 MiB) — fail-fast on
//                      Content-Length, mid-stream enforcement on chunked.
//                      Over -> 413; bad JSON -> 400.
//
// PluginError mapping (pod-side workspace ops):
//   - parent-mismatch -> 409, with structured `actualParent` parsed from the
//     core's error message. Defensive: if parsing fails we still return 409
//     with code+message and omit the structured fields.
//   - unknown-version -> 404
//   - invalid-path    -> 400
//   - other PluginError -> 500 with the error's code
//   - any other thrown -> 500 INTERNAL (logged to stderr)
//
// I12: idle-timeout 60 s, matching the IPC HTTP listener so any future host
// long-poll isn't killed by a Node default change.
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 60_000;

export interface WorkspaceGitListener {
  close(): Promise<void>;
  readonly host: string;
  readonly port: number;
}

export interface CreateWorkspaceGitListenerOptions {
  repoRoot: string;
  host: string;
  /** Pass 0 to let the OS assign a free port; readback via `listener.port`. */
  port: number;
  token: string;
}

// Action-path -> { request schema, handler } table. Polymorphic schema map:
// we use ZodTypeAny to keep the entries homogeneous. Every entry pairs a
// schema with a handler that accepts that exact schema's inferred type — we
// safeParse with the schema before calling the handler, so the runtime
// contract holds even though TS can't see through the unification.
type AnyHandler = (
  repoRoot: string,
  req: never,
) => Promise<unknown>;

interface Route {
  schema: z.ZodTypeAny;
  handle: AnyHandler;
}

const ROUTES: ReadonlyMap<string, Route> = new Map<string, Route>([
  [WORKSPACE_ACTION_PATHS['workspace.apply'], {
    schema: WorkspaceApplyRequestSchema,
    handle: handleApply as unknown as AnyHandler,
  }],
  [WORKSPACE_ACTION_PATHS['workspace.read'], {
    schema: WorkspaceReadRequestSchema,
    handle: handleRead as unknown as AnyHandler,
  }],
  [WORKSPACE_ACTION_PATHS['workspace.list'], {
    schema: WorkspaceListRequestSchema,
    handle: handleList as unknown as AnyHandler,
  }],
  [WORKSPACE_ACTION_PATHS['workspace.diff'], {
    schema: WorkspaceDiffRequestSchema,
    handle: handleDiff as unknown as AnyHandler,
  }],
]);

// Custom error writer — the wire envelope schema (WorkspaceErrorEnvelopeSchema)
// allows arbitrary string codes plus optional expectedParent/actualParent
// fields. @ax/ipc-core's writeJsonError is constrained to the closed
// IpcErrorCode enum, so we don't reuse it here.
function writeWireError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  detail?: { expectedParent?: string | null; actualParent?: string | null },
): void {
  const errBody: {
    code: string;
    message: string;
    expectedParent?: string | null;
    actualParent?: string | null;
  } = { code, message };
  if (detail !== undefined) {
    if (detail.expectedParent !== undefined) errBody.expectedParent = detail.expectedParent;
    if (detail.actualParent !== undefined) errBody.actualParent = detail.actualParent;
  }
  const body = JSON.stringify({ error: errBody });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Parse the parent-mismatch message that @ax/workspace-git-core throws:
//   `expected parent ${currentVersion ?? 'null'}, got ${input.parent ?? 'null'}`
// The currentVersion IS the actualParent; input.parent is the expectedParent
// from the client's POV. Defensive: returns null if parsing fails.
const PARENT_MISMATCH_RE = /^expected parent (\S+), got (\S+)$/;
function parseParentMismatch(message: string): {
  expectedParent: string | null;
  actualParent: string | null;
} | null {
  const m = PARENT_MISMATCH_RE.exec(message);
  if (m === null) return null;
  const [, actual, expected] = m;
  return {
    actualParent: actual === 'null' ? null : actual!,
    expectedParent: expected === 'null' ? null : expected!,
  };
}

export async function createWorkspaceGitListener(
  opts: CreateWorkspaceGitListenerOptions,
): Promise<WorkspaceGitListener> {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          writeWireError(res, 500, 'INTERNAL', 'internal server error');
        } else {
          res.end();
        }
      } catch {
        // Best-effort — socket may already be dead.
      }
      process.stderr.write(
        `workspace-git-http: unhandled handler error: ${(err as Error).message}\n`,
      );
    });
  });

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    // 1. method gate
    if (req.method !== 'POST' && req.method !== 'GET') {
      return writeWireError(res, 405, 'VALIDATION', 'method not allowed');
    }

    // 2. /healthz pre-auth — GET only, 200 unconditionally.
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 3. content-type gate (POST only)
    if (req.method === 'POST') {
      const ct = req.headers['content-type'] ?? '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        return writeWireError(
          res,
          415,
          'VALIDATION',
          'content-type must be application/json',
        );
      }
    }

    // 4. auth gate — static bearer token compare. Token never echoed (I9).
    const authResult = checkBearerToken(req.headers.authorization, opts.token);
    if (!authResult.ok) {
      return writeWireError(res, authResult.status, 'unauthorized', authResult.message);
    }

    // GET on a non-/healthz path: nothing else to do here, treat as 404.
    if (req.method !== 'POST') {
      return writeWireError(res, 404, 'NOT_FOUND', 'not found');
    }

    // Path-based routing: must be a known workspace action.
    const route = req.url !== undefined ? ROUTES.get(req.url) : undefined;
    if (route === undefined) {
      return writeWireError(res, 404, 'NOT_FOUND', 'not found');
    }

    // 5. body cap — readJsonBody enforces MAX_FRAME.
    let raw: unknown;
    try {
      const result = await readJsonBody(req, MAX_FRAME);
      raw = result.value;
    } catch (err) {
      if (err instanceof TooLargeError) {
        return writeWireError(res, 413, 'VALIDATION', 'request body too large');
      }
      if (err instanceof BadJsonError) {
        return writeWireError(res, 400, 'VALIDATION', `invalid json: ${err.message}`);
      }
      throw err;
    }

    // Schema validation. Bad shape -> 400 with the Zod issue message.
    const parsed = route.schema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const message =
        first !== undefined
          ? `${first.path.join('.') || '<root>'}: ${first.message}`
          : 'invalid request';
      return writeWireError(res, 400, 'VALIDATION', message);
    }

    // Dispatch. PluginError (and only PluginError) gets the structured
    // mapping; everything else bubbles to the top-level catch as 500.
    let response: unknown;
    try {
      response = await route.handle(opts.repoRoot, parsed.data as never);
    } catch (err) {
      if (err instanceof PluginError) {
        if (err.code === 'parent-mismatch') {
          const detail = parseParentMismatch(err.message);
          if (detail !== null) {
            return writeWireError(res, 409, err.code, err.message, detail);
          }
          return writeWireError(res, 409, err.code, err.message);
        }
        if (err.code === 'unknown-version') {
          return writeWireError(res, 404, err.code, err.message);
        }
        if (err.code === 'invalid-path') {
          return writeWireError(res, 400, err.code, err.message);
        }
        return writeWireError(res, 500, err.code, err.message);
      }
      throw err;
    }

    writeJsonOk(res, 200, response);
  };

  // I12: bump idle timeout so 30 s long-polls aren't killed.
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
  // process. Mirrors @ax/ipc-http's listener.
  server.on('error', (err) => {
    process.stderr.write(
      `workspace-git-http: server error: ${(err as Error).message}\n`,
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

import * as http from 'node:http';
import { z } from 'zod';
import { MAX_FRAME, PluginError } from '@ax/core';
import {
  WORKSPACE_ACTION_PATHS,
  WORKSPACE_TIMEOUTS_MS,
  WorkspaceApplyRequestSchema,
  WorkspaceApplyResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
  WorkspaceErrorEnvelopeSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceReadRequestSchema,
  WorkspaceReadResponseSchema,
  type WorkspaceActionName,
} from '@ax/workspace-protocol';
import { WorkspaceServerUnavailableError } from './errors.js';

// ---------------------------------------------------------------------------
// Host-side HTTP client for @ax/workspace-git-http. Sibling of
// `packages/ipc-protocol/src/ipc-client.ts` — same retry+timeout shape,
// but HTTP-only (no unix transport) and a static service-token auth model
// (no session token, no parseRunnerEndpoint).
//
// Per-action surface (apply/read/list/diff). Each method:
//   - POSTs JSON to /workspace.<action> on the configured baseUrl.
//   - Authorizes with `Authorization: Bearer ${token}`.
//   - Zod-parses the response against the matching schema from
//     @ax/workspace-protocol.
//   - Maps non-2xx → typed error (see error mapping below).
//
// Retry + timeout policy:
//   - Connection errors (ECONNREFUSED/RESET/EPIPE/ENOTFOUND/EHOSTUNREACH/
//     ENETUNREACH/ETIMEDOUT, plus AbortError as timeout) → retry with
//     exponential backoff (100, 200, 400, 800, ... cap 30 s).
//   - 5xx → retry with the same backoff. The host plugin treats this as
//     "server's having a moment, try again."
//   - 4xx → never retry. Translates to PluginError inside the client so the
//     host plugin / orchestrator can react (e.g., parent-mismatch → rebase).
//   - Per-action timeout from WORKSPACE_TIMEOUTS_MS, overridable via opts.
//
// Error mapping (4xx → PluginError):
//   - 409 → code='parent-mismatch' with cause: { actualParent, expectedParent }.
//     The orchestrator keys off this code to drive the rebase flow.
//   - other 4xx → code = envelope.error.code (e.g., 'unknown-version',
//     'invalid-path', 'VALIDATION'). Whatever the server sent.
//
// Error mapping (5xx + connect errors → WorkspaceServerUnavailableError):
//   - The host plugin maps this to a retryable-at-orchestrator-level error.
//   - The cause carries the underlying socket error / 5xx envelope for logs.
//
// Response cap: MAX_FRAME (4 MiB). Bigger → drop the connection and surface
// WorkspaceServerUnavailableError('response body exceeded cap'). Defensive —
// the server doesn't intentionally produce >4 MiB bodies, but a malicious
// or compromised server shouldn't be able to OOM the host either.
// ---------------------------------------------------------------------------

export interface WorkspaceGitHttpClient {
  apply(
    req: z.infer<typeof WorkspaceApplyRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceApplyResponseSchema>>;
  read(
    req: z.infer<typeof WorkspaceReadRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceReadResponseSchema>>;
  list(
    req: z.infer<typeof WorkspaceListRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceListResponseSchema>>;
  diff(
    req: z.infer<typeof WorkspaceDiffRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceDiffResponseSchema>>;
}

export interface CreateWorkspaceGitHttpClientOptions {
  /**
   * Base URL of the git-server (e.g. `http://ax-git-server.ax-next:7780`).
   * Must use the `http:` scheme — TLS isn't available on this transport
   * today; we lean on the cluster network policy + bearer token for trust.
   * Path/query/fragment on the URL are ignored (we always hit /workspace.*).
   */
  baseUrl: string;
  /** Static service token; sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Defaults from WORKSPACE_TIMEOUTS_MS. Tests override per-action. */
  timeouts?: Partial<Record<WorkspaceActionName, number>>;
  /** Max retry attempts on connection errors / 5xx. Default: 5. */
  maxRetries?: number;
}

// Connection-level errnos that should trigger retry. Same set as
// ipc-protocol/src/ipc-client.ts minus ENOENT (no unix sockets here).
const TRANSIENT_ERRNOS = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function isTransientConnectionError(err: unknown): boolean {
  if (err instanceof WorkspaceServerUnavailableError) return true;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_ERRNOS.has(code);
}

function defaultBackoff(attempt: number): number {
  // 100, 200, 400, 800, 1600, ... cap 30 s. attempt is 0-indexed.
  return Math.min(100 * 2 ** attempt, 30_000);
}

interface RawResponse {
  status: number;
  body: Buffer;
}

interface TcpTarget {
  host: string;
  port: number;
}

function parseBaseUrl(baseUrl: string): TcpTarget {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (err) {
    throw new Error(`workspace-git-http: invalid baseUrl: ${(err as Error).message}`);
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(
      `workspace-git-http: baseUrl scheme must be http:, got ${parsed.protocol}`,
    );
  }
  // URL.port is '' for the default port; for http: that's 80. Coerce.
  const port = parsed.port === '' ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`workspace-git-http: baseUrl has invalid port: ${parsed.port}`);
  }
  return { host: parsed.hostname, port };
}

function requestOnce(opts: {
  target: TcpTarget;
  pathName: string;
  token: string;
  body: Buffer;
  timeoutMs: number;
}): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, opts.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      'Content-Length': String(opts.body.length),
    };

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = http.request(
      {
        host: opts.target.host,
        port: opts.target.port,
        path: opts.pathName,
        method: 'POST',
        headers,
        signal: controller.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let overflowed = false;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_FRAME) {
            if (!overflowed) {
              overflowed = true;
              // Destroying with an error funnels through res.on('error').
              res.destroy(new Error('response body too large'));
            }
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settle(() =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
        });
        res.on('error', (err) => {
          const message = overflowed
            ? 'response body exceeded cap'
            : 'response stream error';
          settle(() => reject(new WorkspaceServerUnavailableError(message, err)));
        });
      },
    );

    req.on('error', (err) => {
      const errno = (err as NodeJS.ErrnoException).code;
      if ((err as Error).name === 'AbortError' || errno === 'ABORT_ERR') {
        settle(() => reject(new WorkspaceServerUnavailableError('timeout', err)));
        return;
      }
      if (errno !== undefined && TRANSIENT_ERRNOS.has(errno)) {
        settle(() =>
          reject(
            new WorkspaceServerUnavailableError(`connect failed: ${errno}`, err),
          ),
        );
        return;
      }
      settle(() =>
        reject(
          new WorkspaceServerUnavailableError(
            `request failed: ${(err as Error).message}`,
            err,
          ),
        ),
      );
    });

    req.write(opts.body);
    req.end();
  });
}

// hookName mapping for PluginError construction. Kept literal so the union
// stays narrow (no `string` widening).
const HOOK_NAMES: Record<WorkspaceActionName, string> = {
  'workspace.apply': 'workspace:apply',
  'workspace.read': 'workspace:read',
  'workspace.list': 'workspace:list',
  'workspace.diff': 'workspace:diff',
};

type ParsedEnvelope = z.infer<typeof WorkspaceErrorEnvelopeSchema>['error'];

function parseEnvelope(body: Buffer): ParsedEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new WorkspaceServerUnavailableError(
      `invalid error envelope: ${(err as Error).message}`,
    );
  }
  const result = WorkspaceErrorEnvelopeSchema.safeParse(json);
  if (!result.success) {
    throw new WorkspaceServerUnavailableError(
      `invalid error envelope: ${result.error.message}`,
    );
  }
  return result.data.error;
}

export function createWorkspaceGitHttpClient(
  opts: CreateWorkspaceGitHttpClientOptions,
): WorkspaceGitHttpClient {
  const target = parseBaseUrl(opts.baseUrl);
  const maxRetries = opts.maxRetries ?? 5;

  const timeoutFor = (action: WorkspaceActionName): number => {
    if (opts.timeouts?.[action] !== undefined) return opts.timeouts[action]!;
    return WORKSPACE_TIMEOUTS_MS[action];
  };

  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        // Only transient (connection / 5xx-translated-as-WorkspaceServerUnavailableError)
        // errors retry. PluginError (4xx mapping) breaks out immediately.
        if (!isTransientConnectionError(err) || attempt === maxRetries) throw err;
        const wait = defaultBackoff(attempt);
        if (wait > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, wait));
        }
      }
    }
    // Unreachable — loop either returns or throws. Defensive throw for the
    // control-flow analyzer.
    throw lastErr;
  };

  // The single per-action request path. Caller passes the action name (for
  // routing + timeout + hookName + schema lookup) and a payload; we hand back
  // the parsed response.
  const callAction = async <Req, Res>(
    action: WorkspaceActionName,
    requestSchema: z.ZodType<Req>,
    responseSchema: z.ZodType<Res>,
    payload: Req,
  ): Promise<Res> => {
    // Defensive: validate the outbound body too. Cheap insurance against a
    // caller passing the wrong shape — surface it as a local error instead
    // of letting the server return 400.
    const reqCheck = requestSchema.safeParse(payload);
    if (!reqCheck.success) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: '@ax/workspace-git-http',
        hookName: HOOK_NAMES[action],
        message: `request shape invalid: ${reqCheck.error.message}`,
      });
    }

    const body = Buffer.from(JSON.stringify(reqCheck.data), 'utf8');
    const timeoutMs = timeoutFor(action);
    const pathName = WORKSPACE_ACTION_PATHS[action];

    return withRetry(async () => {
      const raw = await requestOnce({
        target,
        pathName,
        token: opts.token,
        body,
        timeoutMs,
      });

      if (raw.status === 200) {
        let json: unknown;
        try {
          json = JSON.parse(raw.body.toString('utf8'));
        } catch (err) {
          throw new WorkspaceServerUnavailableError(
            `response shape invalid: ${(err as Error).message}`,
          );
        }
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success) {
          throw new WorkspaceServerUnavailableError(
            `response shape invalid: ${parsed.error.message}`,
          );
        }
        return parsed.data;
      }

      if (raw.status >= 400 && raw.status < 500) {
        const env = parseEnvelope(raw.body);
        if (raw.status === 409) {
          // Structured cause carries the rebase coordinates. Only set fields
          // we actually got from the envelope so the cause is unambiguous —
          // a missing field is meaningfully different from `null` (which the
          // server uses for "no parent yet, the repo was empty").
          const cause: Record<string, string | null> = {};
          if (env.actualParent !== undefined) cause.actualParent = env.actualParent;
          if (env.expectedParent !== undefined) cause.expectedParent = env.expectedParent;
          throw new PluginError({
            code: 'parent-mismatch',
            plugin: '@ax/workspace-git-http',
            hookName: HOOK_NAMES[action],
            message: env.message,
            cause,
          });
        }
        throw new PluginError({
          code: env.code,
          plugin: '@ax/workspace-git-http',
          hookName: HOOK_NAMES[action],
          message: env.message,
        });
      }

      if (raw.status >= 500) {
        // Best-effort envelope parse for the message; if it's malformed we
        // still surface a 5xx-flavored WorkspaceServerUnavailableError so the
        // retry loop kicks in.
        let message: string;
        try {
          const env = parseEnvelope(raw.body);
          message = `server returned 5xx ${raw.status}: ${env.message}`;
        } catch {
          message = `server returned 5xx ${raw.status}`;
        }
        throw new WorkspaceServerUnavailableError(message);
      }

      // 1xx/3xx/unexpected — treat as transport unavailable.
      throw new WorkspaceServerUnavailableError(
        `unexpected response status ${raw.status}`,
      );
    });
  };

  return {
    apply: (req) =>
      callAction(
        'workspace.apply',
        WorkspaceApplyRequestSchema,
        WorkspaceApplyResponseSchema,
        req,
      ),
    read: (req) =>
      callAction(
        'workspace.read',
        WorkspaceReadRequestSchema,
        WorkspaceReadResponseSchema,
        req,
      ),
    list: (req) =>
      callAction(
        'workspace.list',
        WorkspaceListRequestSchema,
        WorkspaceListResponseSchema,
        req,
      ),
    diff: (req) =>
      callAction(
        'workspace.diff',
        WorkspaceDiffRequestSchema,
        WorkspaceDiffResponseSchema,
        req,
      ),
  };
}

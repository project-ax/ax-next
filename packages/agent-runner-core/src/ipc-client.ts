import * as http from 'node:http';
import { z } from 'zod';
import {
  IPC_TIMEOUTS_MS,
  IpcErrorEnvelopeSchema,
  LlmCallResponseSchema,
  SessionNextMessageResponseSchema,
  ToolExecuteHostResponseSchema,
  ToolListResponseSchema,
  ToolPreCallResponseSchema,
  WorkspaceCommitNotifyResponseSchema,
  parseRunnerEndpoint,
  RunnerEndpointError,
  type IpcActionName,
  type TransportTarget,
} from '@ax/ipc-protocol';
import {
  HostUnavailableError,
  IpcRequestError,
  SessionInvalidError,
} from './errors.js';

// ---------------------------------------------------------------------------
// Sandbox-side IPC client. Speaks HTTP over either a unix socket OR a TCP
// connection — the caller hands us a `runnerEndpoint` URI and we pick the
// transport from the scheme.
//
// Supported schemes today:
//   - `unix:///abs/path/ipc.sock` — the in-host subprocess sandbox provider.
//                                   Connects via http.request({ socketPath }).
//   - `http://host:port`          — RESERVED for the k8s pod sandbox
//                                   provider (Task 14). NOT IMPLEMENTED YET:
//                                   passing one will throw at construction
//                                   time. The pod's HTTP server side is the
//                                   missing half of this story; once it
//                                   exists, the unix:// branch and the http://
//                                   branch share the same retry/backoff/cap
//                                   logic — only the http.request options
//                                   differ.
//
// Three methods:
//
//   call(action, payload)    — POST /<action> with a JSON body. Response is
//                              Zod-parsed using the matching schema from
//                              @ax/ipc-protocol (lookup table below).
//
//   callGet(action, query)   — GET /<action>?k=v&.... Only used for
//                              session.next-message today; typed narrowly
//                              so misuse is a compile error.
//
//   event(name, payload)     — POST /<name> fire-and-forget. Resolves on
//                              202; connection-level errors reject, but
//                              callers usually log and move on.
//
// Retry and timeout policy lives in this file:
//   - 5xx + connection errors → retry, exponential backoff, cap maxRetries.
//   - 401 → SessionInvalidError (terminal).
//   - 400/404/409 → IpcRequestError (don't retry).
//   - Per-action timeout from IPC_TIMEOUTS_MS (overridable for tests).
//
// Response-body cap: we drain into a Buffer capped at MAX_RESPONSE_BYTES.
// @ax/core has a MAX_FRAME of 4 MiB, but this package must not import the
// kernel (sandbox-side), so we redeclare the same ceiling here. Task 14
// may unify if that boundary shifts.
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Dispatch table: action → Zod schema for the successful response body.
// Event endpoints have no response body (just {accepted: true} on 202) and
// are handled separately in `event()`.
const RESPONSE_SCHEMAS: Record<IpcActionName, z.ZodTypeAny> = {
  'llm.call': LlmCallResponseSchema,
  'tool.pre-call': ToolPreCallResponseSchema,
  'tool.execute-host': ToolExecuteHostResponseSchema,
  'tool.list': ToolListResponseSchema,
  'workspace.commit-notify': WorkspaceCommitNotifyResponseSchema,
  'session.next-message': SessionNextMessageResponseSchema,
};

export interface IpcClientOptions {
  /**
   * Opaque URI the runner uses to reach the host. Schemes:
   *   - `unix:///abs/path` — connects to a Unix domain socket at the path.
   *   - `http://host:port` — TCP HTTP. NOT IMPLEMENTED YET (Task 14).
   *
   * The runner doesn't pick the scheme — the sandbox provider does, and
   * sets AX_RUNNER_ENDPOINT in the runner's env. See @ax/sandbox-subprocess
   * (`unix://`) and @ax/sandbox-k8s (`http://`).
   */
  runnerEndpoint: string;
  token: string;
  /** Defaults from @ax/ipc-protocol IPC_TIMEOUTS_MS. Tests override. */
  timeouts?: Partial<Record<IpcActionName, number>>;
  /** Defaults to an exponential-backoff schedule (100 → 30_000 ms cap). */
  retryBackoff?: (attempt: number) => number;
  /** Max retry attempts on connection-level errors / 5xx. Default: 5. */
  maxRetries?: number;
  /** Testable seam. */
  now?: () => number;
}

export interface IpcClient {
  call<Action extends IpcActionName>(
    action: Action,
    payload: unknown,
  ): Promise<unknown>;

  callGet<Action extends 'session.next-message'>(
    action: Action,
    query: Record<string, string>,
  ): Promise<unknown>;

  event(eventName: string, payload: unknown): Promise<void>;

  close(): Promise<void>;
}

// Connection-level errors that should be treated as HostUnavailableError.
// We also catch the unix-socket-file-missing case (ENOENT on connect).
const TRANSIENT_ERRNOS = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOENT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function isTransientConnectionError(err: unknown): boolean {
  if (err instanceof HostUnavailableError) return true;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_ERRNOS.has(code);
}

function defaultBackoff(attempt: number): number {
  // 100, 200, 400, 800, 1600, ... capped at 30s. `attempt` is 0-indexed so
  // the first retry waits 100 ms.
  return Math.min(100 * 2 ** attempt, 30_000);
}

interface RawResponse {
  status: number;
  body: Buffer;
}

/**
 * One attempt — issues the HTTP request, returns the raw status+body, or
 * throws a HostUnavailableError for connection-level / timeout failures.
 *
 * Does NOT apply retry policy. Does NOT Zod-parse. Caller wraps.
 */
function requestOnce(
  opts: {
    target: TransportTarget;
    method: 'GET' | 'POST';
    pathWithQuery: string;
    token: string;
    body?: Buffer;
    timeoutMs: number;
  },
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, opts.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(opts.body.length);
    }

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // Defensive: parseRunnerEndpoint rejects http:// at construction time
    // today; if a future caller adds a new scheme we want a loud,
    // localized error rather than a confusing connect failure deep in
    // node:http.
    if (opts.target.kind !== 'unix') {
      settle(() =>
        reject(
          new HostUnavailableError(
            `transport ${opts.target.kind} not implemented`,
          ),
        ),
      );
      return;
    }

    const req = http.request(
      {
        socketPath: opts.target.socketPath,
        path: opts.pathWithQuery,
        method: opts.method,
        headers,
        signal: controller.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let overflowed = false;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            if (!overflowed) {
              overflowed = true;
              // Destroying the response ends the stream; we'll surface a
              // HostUnavailableError on 'error' (NOT 'end' — res.destroy(err)
              // emits 'error' and 'close', not 'end').
              res.destroy(new Error('response body too large'));
            }
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          // By the time 'end' fires, no destroy has run — resolve normally.
          settle(() =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
        });
        res.on('error', (err) => {
          // Overflow path funnels through here (res.destroy was called with
          // a 'response body too large' error). Translate to a specific
          // HostUnavailableError message so callers see the real reason
          // instead of a generic "stream error."
          const message = overflowed
            ? 'response body exceeded cap'
            : 'response stream error';
          settle(() => reject(new HostUnavailableError(message, err)));
        });
      },
    );

    req.on('error', (err) => {
      // AbortController.abort() surfaces as an 'AbortError' here; treat as
      // timeout specifically so the message is useful.
      const errno = (err as NodeJS.ErrnoException).code;
      if ((err as Error).name === 'AbortError' || errno === 'ABORT_ERR') {
        settle(() => reject(new HostUnavailableError('timeout', err)));
        return;
      }
      if (errno !== undefined && TRANSIENT_ERRNOS.has(errno)) {
        settle(() => reject(new HostUnavailableError(`connect failed: ${errno}`, err)));
        return;
      }
      settle(() => reject(new HostUnavailableError(`request failed: ${(err as Error).message}`, err)));
    });

    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function toQueryString(query: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) params.append(k, v);
  const s = params.toString();
  return s.length === 0 ? '' : `?${s}`;
}

function parseErrorEnvelope(
  status: number,
  body: Buffer,
): IpcRequestError | SessionInvalidError {
  // Best-effort — if the body isn't a valid error envelope, synthesize a
  // generic message so callers always get a useful error.
  let code = 'INTERNAL';
  let message = `request failed with status ${status}`;
  try {
    const parsed = IpcErrorEnvelopeSchema.parse(JSON.parse(body.toString('utf8')));
    code = parsed.error.code;
    message = parsed.error.message;
  } catch {
    // Leave defaults.
  }
  if (status === 401) return new SessionInvalidError(message);
  return new IpcRequestError(code, status, message);
}

export function createIpcClient(opts: IpcClientOptions): IpcClient {
  const maxRetries = opts.maxRetries ?? 5;
  const backoff = opts.retryBackoff ?? defaultBackoff;
  // Resolve the transport target ONCE at construction. parseRunnerEndpoint
  // (in @ax/ipc-protocol) throws RunnerEndpointError on an invalid URI;
  // we re-wrap as HostUnavailableError so the runner-side public surface
  // stays unchanged.
  let target: TransportTarget;
  try {
    target = parseRunnerEndpoint(opts.runnerEndpoint);
  } catch (err) {
    if (err instanceof RunnerEndpointError) {
      throw new HostUnavailableError(err.message, err.cause);
    }
    throw err;
  }

  const timeoutFor = (action: IpcActionName): number => {
    if (opts.timeouts?.[action] !== undefined) return opts.timeouts[action]!;
    // For long-poll endpoints, the server-side deadline IS IPC_TIMEOUTS_MS
    // (the server holds the request open for that long). If the client aborts
    // at the same value, a race window exists where the client's abort fires
    // just as the server is about to return `{type:'timeout'}` — producing a
    // spurious HostUnavailableError instead of a clean timeout response the
    // inbox loop knows how to handle. Add a grace period on top so the
    // server always responds first.
    if (action === 'session.next-message') {
      return IPC_TIMEOUTS_MS[action] + 5_000;
    }
    return IPC_TIMEOUTS_MS[action];
  };

  // Retry loop. `shouldRetry` decides whether the error is transient and
  // another attempt is warranted. We run up to `maxRetries + 1` total
  // attempts (the initial + N retries).
  const withRetry = async <T>(
    shouldRetry: (err: unknown) => boolean,
    fn: () => Promise<T>,
  ): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!shouldRetry(err) || attempt === maxRetries) throw err;
        const wait = backoff(attempt);
        if (wait > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, wait));
        }
      }
    }
    // Unreachable — the for-loop either returns or throws before falling out.
    // The `throw` here is defensive to satisfy the control-flow analyzer.
    throw lastErr;
  };

  const parseSuccessBody = (action: IpcActionName, body: Buffer): unknown => {
    const schema = RESPONSE_SCHEMAS[action];
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch (err) {
      // Malformed JSON from the host is a host-side bug, not a client bug.
      // We don't classify it as retryable — surfacing quickly is the point.
      throw new IpcRequestError(
        'INTERNAL',
        0,
        `invalid json response: ${(err as Error).message}`,
      );
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new IpcRequestError(
        'INTERNAL',
        0,
        `response validation failed: ${result.error.message}`,
      );
    }
    return result.data;
  };

  const call = async <Action extends IpcActionName>(
    action: Action,
    payload: unknown,
  ): Promise<unknown> => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const timeoutMs = timeoutFor(action);

    return withRetry(
      // Retry on transient (connection-level / timeout) + 5xx responses.
      (err) => {
        if (isTransientConnectionError(err)) return true;
        if (err instanceof IpcRequestError && err.status >= 500) return true;
        return false;
      },
      async () => {
        const raw = await requestOnce({
          target,
          method: 'POST',
          pathWithQuery: `/${action}`,
          token: opts.token,
          body,
          timeoutMs,
        });
        if (raw.status >= 200 && raw.status < 300) {
          return parseSuccessBody(action, raw.body);
        }
        throw parseErrorEnvelope(raw.status, raw.body);
      },
    );
  };

  const callGet = async <Action extends 'session.next-message'>(
    action: Action,
    query: Record<string, string>,
  ): Promise<unknown> => {
    const timeoutMs = timeoutFor(action);
    const pathWithQuery = `/${action}${toQueryString(query)}`;

    return withRetry(
      (err) => {
        if (isTransientConnectionError(err)) return true;
        if (err instanceof IpcRequestError && err.status >= 500) return true;
        return false;
      },
      async () => {
        const raw = await requestOnce({
          target,
          method: 'GET',
          pathWithQuery,
          token: opts.token,
          timeoutMs,
        });
        if (raw.status >= 200 && raw.status < 300) {
          return parseSuccessBody(action, raw.body);
        }
        throw parseErrorEnvelope(raw.status, raw.body);
      },
    );
  };

  const event = async (eventName: string, payload: unknown): Promise<void> => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    // Events are fire-and-forget on the wire (202). They still need a
    // timeout so a wedged socket doesn't hang the runner forever. Pick a
    // sane short ceiling — 10 s matches tool.pre-call.
    const timeoutMs = 10_000;
    const raw = await requestOnce({
      target,
      method: 'POST',
      pathWithQuery: `/${eventName}`,
      token: opts.token,
      body,
      timeoutMs,
    });
    if (raw.status === 202) return;
    if (raw.status >= 200 && raw.status < 300) return; // tolerate other 2xx
    throw parseErrorEnvelope(raw.status, raw.body);
  };

  const close = async (): Promise<void> => {
    // No persistent agent held — each request creates/tears down its own
    // http.ClientRequest. Close is a no-op today but reserved for a future
    // keep-alive agent if we ever need it.
  };

  return { call, callGet, event, close };
}

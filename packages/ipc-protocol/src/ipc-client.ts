import * as http from 'node:http';
import { z } from 'zod';
import {
  ConversationStoreRunnerSessionResponseSchema,
  IPC_TIMEOUTS_MS,
  IpcErrorEnvelopeSchema,
  SessionGetConfigResponseSchema,
  SessionNextMessageResponseSchema,
  ToolExecuteHostResponseSchema,
  ToolListResponseSchema,
  ToolPreCallResponseSchema,
  WorkspaceCommitNotifyResponseSchema,
  WorkspaceMaterializeResponseSchema,
  WorkspaceReadResponseSchema,
  parseRunnerEndpoint,
  RunnerEndpointError,
  type IpcActionName,
  type TransportTarget,
} from './index.js';
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
//   - `http://host:port`          — the k8s pod sandbox provider. Connects
//                                   via http.request({ host, port }).
//                                   `host:port` points at the host's IPC
//                                   listener (cluster Service DNS), NOT the
//                                   runner pod itself.
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
// kernel (sandbox-side), so we redeclare the same ceiling here. We may
// unify if that boundary shifts.
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Dispatch table: action → Zod schema for the successful response body.
// Event endpoints have no response body (just {accepted: true} on 202) and
// are handled separately in `event()`.
const RESPONSE_SCHEMAS: Record<IpcActionName, z.ZodTypeAny> = {
  'tool.pre-call': ToolPreCallResponseSchema,
  'tool.execute-host': ToolExecuteHostResponseSchema,
  'tool.list': ToolListResponseSchema,
  'workspace.commit-notify': WorkspaceCommitNotifyResponseSchema,
  'workspace.materialize': WorkspaceMaterializeResponseSchema,
  'workspace.read': WorkspaceReadResponseSchema,
  'session.next-message': SessionNextMessageResponseSchema,
  'session.get-config': SessionGetConfigResponseSchema,
  'conversation.store-runner-session': ConversationStoreRunnerSessionResponseSchema,
};

export interface IpcClientOptions {
  /**
   * Opaque URI the runner uses to reach the host. Schemes:
   *   - `unix:///abs/path` — connects to a Unix domain socket at the path.
   *   - `http://host:port` — TCP HTTP to the host's IPC listener.
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
  /**
   * Hard cap on retry attempts (on top of the first try) for connection-level
   * errors / 5xx. When set, the loop stops after this many retries regardless
   * of the wall-clock deadline. When UNSET it defaults to effectively
   * unbounded (Number.MAX_SAFE_INTEGER) so `maxElapsedMs` is the binding
   * constraint — that's what lets the runner ride out a host restart. Existing
   * callers that pass a number keep their exact attempt-count semantics.
   */
  maxRetries?: number;
  /**
   * Wall-clock ceiling (ms) for the transient-error retry SERIES. Retries on
   * connection-level / 5xx errors keep going (at the backoff cadence, capped
   * at 30 s/attempt) until this much real time has elapsed since the first
   * attempt, then the final error is rethrown. This is the knob that lets the
   * runner survive a host OOMKill → reschedule → boot instead of giving up
   * after the old ~3 s / 6-attempt budget and dropping the turn (commit-notify)
   * or crashing (session.next-message poll). Default 120_000 (2 min). Distinct
   * from the per-attempt wire timeout in IPC_TIMEOUTS_MS — that bounds ONE
   * request; this bounds the whole retry series.
   */
  maxElapsedMs?: number;
  /** Testable seam. */
  now?: () => number;
  /**
   * Test-only override of the single-request transport (`requestOnce`).
   * Underscore-prefixed so it stays off the real surface. When set, the
   * retry loop calls THIS instead of issuing a real HTTP request — lets tests
   * drive the loop's retry/deadline/retryable-classification logic without a
   * live server. Production code never sets it.
   */
  __requestOnce?: (opts: {
    method: 'GET' | 'POST';
    pathWithQuery: string;
    timeoutMs: number;
  }) => Promise<{ status: number; body: Buffer }>;
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
  // A HostUnavailableError is retryable UNLESS it flagged itself otherwise
  // (e.g. a deterministic over-cap response body — retrying just re-transfers
  // the same too-large bytes).
  if (err instanceof HostUnavailableError) return err.retryable;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_ERRNOS.has(code);
}

function defaultBackoff(attempt: number): number {
  // 100, 200, 400, 800, 1600, ... capped at 30s. `attempt` is 0-indexed so
  // the first retry waits 100 ms.
  return Math.min(100 * 2 ** attempt, 30_000);
}

/** Default wall-clock ceiling for the transient-error retry series: 2 min.
 *  Long enough to ride out a host OOMKill → pod reschedule → boot. */
const DEFAULT_MAX_ELAPSED_MS = 120_000;

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

    const requestOptions: http.RequestOptions =
      opts.target.kind === 'unix'
        ? {
            socketPath: opts.target.socketPath,
            path: opts.pathWithQuery,
            method: opts.method,
            headers,
            signal: controller.signal,
          }
        : {
            host: opts.target.host,
            port: opts.target.port,
            path: opts.pathWithQuery,
            method: opts.method,
            headers,
            signal: controller.signal,
          };
    const req = http.request(
      requestOptions,
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
          // An over-cap response is DETERMINISTIC — retrying re-fetches the
          // same too-large bytes and fails identically, so mark it
          // non-retryable. Otherwise the 2-min retry deadline would stall the
          // runner re-transferring a large workspace.read for the full window
          // (Codex). A bare stream error stays retryable (could be transient).
          settle(() =>
            reject(new HostUnavailableError(message, err, { retryable: !overflowed })),
          );
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
  // Default to effectively-unbounded attempts so `maxElapsedMs` (the 2-min
  // wall-clock deadline) is the binding constraint for callers (like the
  // runner) that don't set an explicit cap. Callers that DO pass maxRetries
  // keep their exact attempt-count semantics — the loop exits on whichever of
  // {count, deadline} fires first.
  const maxRetries = opts.maxRetries ?? Number.MAX_SAFE_INTEGER;
  const maxElapsedMs = opts.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const now = opts.now ?? Date.now;
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
  // another attempt is warranted. The loop stops on whichever fires first:
  //   - a non-transient error (incl. 4xx PluginError) → throw immediately;
  //   - the attempt-count cap `maxRetries` (defaults to unbounded);
  //   - the wall-clock deadline `maxElapsedMs` (default 2 min) — the next
  //     retry's backoff would land us at/past the deadline, so give up now.
  // The deadline is what lets the runner survive a host restart: a transient
  // ECONNREFUSED keeps retrying at ≤30 s cadence for up to 2 min instead of
  // bailing after the old ~3 s budget.
  const withRetry = async <T>(
    shouldRetry: (err: unknown) => boolean,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const start = now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        // Non-transient (incl. PluginError 4xx) → throw immediately.
        // Attempt-count cap reached → exhausted, rethrow.
        if (!shouldRetry(err) || attempt === maxRetries) throw err;
        // Wall-clock deadline: if the next backoff would push us at/past the
        // ceiling, don't take it — rethrow the last transient error now.
        const wait = backoff(attempt);
        if (now() - start + wait >= maxElapsedMs) throw err;
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
        const raw = opts.__requestOnce
          ? await opts.__requestOnce({
              method: 'POST',
              pathWithQuery: `/${action}`,
              timeoutMs,
            })
          : await requestOnce({
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

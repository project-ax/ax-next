import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
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
// Response-body cap (JSON path): we drain into a Buffer capped at
// MAX_RESPONSE_BYTES. @ax/core has a MAX_FRAME of 4 MiB, but this package must
// not import the kernel (sandbox-side), so we redeclare the same ceiling here.
// We may unify if that boundary shifts.
//
// The ONE exception is `workspace.materialize` (BUG-W3): its body is a raw
// `git bundle` (octet-stream, not JSON) that grows unbounded with workspace
// age. It does NOT go through the Buffer-capped JSON path — `callBinary`
// streams it straight to a temp file under the far larger, disk-bounded
// MAX_BINARY_RESPONSE_BYTES. Hence materialize is absent from RESPONSE_SCHEMAS
// below (there's no JSON body to Zod-parse).
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Hard ceiling for a streamed binary response (workspace.materialize). Drains
// to disk, so the real bound is the runner's /tmp space; this guards against a
// runaway/broken host shipping unbounded bytes (the host is the trust root, so
// this is a sanity wall, not an adversary defense). Set far above any realistic
// pack-compressed workspace bundle — orders of magnitude over the old 4 MiB
// JSON cap that crashed the runner.
const MAX_BINARY_RESPONSE_BYTES = 512 * 1024 * 1024;

// Dispatch table: action → Zod schema for the successful response body.
// Event endpoints have no response body (just {accepted: true} on 202) and
// are handled separately in `event()`. `workspace.materialize` is absent —
// its response is raw binary (see callBinary), not a Zod-parsed JSON body.
const RESPONSE_SCHEMAS: Partial<Record<IpcActionName, z.ZodTypeAny>> = {
  'tool.pre-call': ToolPreCallResponseSchema,
  'tool.execute-host': ToolExecuteHostResponseSchema,
  'tool.list': ToolListResponseSchema,
  'workspace.commit-notify': WorkspaceCommitNotifyResponseSchema,
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
  /**
   * Test-only override of the binary-response disk cap (MAX_BINARY_RESPONSE_BYTES).
   * Underscore-prefixed so it stays off the real surface — lets tests exercise
   * the over-cap path with a tiny ceiling instead of streaming 512 MiB.
   * Production code never sets it.
   */
  __maxBinaryResponseBytes?: number;
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

  /**
   * POST a JSON request and drain the RAW octet-stream response body to a temp
   * file, returning its path. For the one binary action (`workspace.materialize`,
   * a git bundle that grows unbounded with workspace age — BUG-W3): bypasses the
   * 4 MiB JSON Buffer cap by streaming to disk under MAX_BINARY_RESPONSE_BYTES.
   * The CALLER owns the returned file and must delete it. On any error the temp
   * file is cleaned up before the error propagates.
   */
  callBinary<Action extends 'workspace.materialize'>(
    action: Action,
    payload: unknown,
  ): Promise<{ path: string; bytes: number }>;

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

/** Small finite cap for HTTP 5xx (host application error) retries. These are
 *  often DETERMINISTIC (a tool internal error, schema drift) and won't heal by
 *  waiting, so they get a few quick attempts — NOT the 2-min wall-clock window
 *  the connection-failure path uses (which would stall the runner for minutes
 *  on a persistent app error). */
const MAX_5XX_RETRIES = 3;

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

interface BinaryFileResponse {
  status: number;
  /** Bytes streamed to the file on a 2xx; 0 otherwise. */
  bytesWritten: number;
  /** On a non-2xx, the (small, in-memory) JSON error envelope; null on 2xx. */
  errorBody: Buffer | null;
}

/**
 * One attempt for a binary action: issues the HTTP request, and on a 2xx
 * STREAMS the response body to `filePath` (backpressure-aware, capped at
 * `maxBytes`) instead of buffering it in memory. A non-2xx response is a small
 * JSON error envelope — drained into memory (capped at the JSON ceiling) so the
 * caller can parse it. Throws a HostUnavailableError for connection / timeout /
 * over-cap failures (over-cap is non-retryable: re-fetching the same too-large
 * body fails identically). Does NOT apply retry policy or clean up the file —
 * the caller wraps and owns cleanup.
 */
function requestOnceBinaryToFile(opts: {
  target: TransportTarget;
  pathWithQuery: string;
  token: string;
  body: Buffer;
  timeoutMs: number;
  filePath: string;
  maxBytes: number;
}): Promise<BinaryFileResponse> {
  return new Promise<BinaryFileResponse>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, opts.timeoutMs);

    let settled = false;
    let ws: ReturnType<typeof createWriteStream> | null = null;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      'Content-Length': String(opts.body.length),
    };
    const requestOptions: http.RequestOptions =
      opts.target.kind === 'unix'
        ? {
            socketPath: opts.target.socketPath,
            path: opts.pathWithQuery,
            method: 'POST',
            headers,
            signal: controller.signal,
          }
        : {
            host: opts.target.host,
            port: opts.target.port,
            path: opts.pathWithQuery,
            method: 'POST',
            headers,
            signal: controller.signal,
          };

    const req = http.request(requestOptions, (res) => {
      const status = res.statusCode ?? 0;

      // Non-2xx: a small JSON error envelope. Buffer in memory (capped) so the
      // caller can parse it — no temp file is created.
      if (status < 200 || status >= 300) {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            // Settle deterministically rather than via res.destroy()→'error'
            // (destroying the socket races a req 'error' that could settle
            // first with the wrong classification — see the 2xx note below).
            res.destroy();
            settle(() =>
              reject(
                new HostUnavailableError('error body exceeded cap', undefined, {
                  retryable: false,
                }),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settle(() =>
            resolve({ status, bytesWritten: 0, errorBody: Buffer.concat(chunks) }),
          );
        });
        res.on('error', (err) => {
          settle(() =>
            reject(new HostUnavailableError('response stream error', err)),
          );
        });
        return;
      }

      // 2xx: stream the raw bytes to the temp file with backpressure + cap.
      // Capture the declared length so a truncated transfer (host killed
      // mid-send) is caught here as a RETRYABLE fault rather than slipping
      // through as a short-but-nonzero file that `git clone` later rejects with
      // an opaque, non-retryable bootstrap error.
      const declaredLength = res.headers['content-length'];
      const expectedBytes =
        typeof declaredLength === 'string' && declaredLength.length > 0
          ? Number(declaredLength)
          : undefined;
      ws = createWriteStream(opts.filePath);
      let written = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        written += chunk.length;
        if (written > opts.maxBytes) {
          // Settle the rejection IMMEDIATELY (deterministic), then tear down the
          // streams. Routing this through res.destroy(err)→'error' instead would
          // race the socket-reset 'error' on `req` (ECONNRESET, classified
          // RETRYABLE) — whichever fired first would win the settle latch, so
          // the over-cap error could wrongly come back retryable and the runner
          // would re-transfer the same too-large body. Over-cap is DETERMINISTIC,
          // so we mark it non-retryable here and stop.
          ws?.destroy();
          res.destroy();
          settle(() =>
            reject(
              new HostUnavailableError('response body exceeded cap', undefined, {
                retryable: false,
              }),
            ),
          );
          return;
        }
        if (!ws!.write(chunk)) {
          res.pause();
          ws!.once('drain', () => res.resume());
        }
      });
      res.on('end', () => {
        // Truncation guard: if the host declared a Content-Length and we drained
        // fewer bytes, the transfer was cut short (host crash / connection
        // reset that still emitted 'end'). Treat as a RETRYABLE fault so the
        // runner re-fetches the full body, rather than handing a partial bundle
        // to `git clone`. ws is destroyed (not end()ed) so the partial file
        // isn't presented as complete.
        if (expectedBytes !== undefined && Number.isFinite(expectedBytes) && written !== expectedBytes) {
          ws?.destroy();
          settle(() =>
            reject(
              new HostUnavailableError(
                `truncated response body: drained ${written} of ${expectedBytes} declared bytes`,
                undefined,
                { retryable: true },
              ),
            ),
          );
          return;
        }
        // Flush the write stream before resolving so the file is complete on
        // disk by the time the caller clones from it.
        ws!.end(() => {
          settle(() =>
            resolve({ status, bytesWritten: written, errorBody: null }),
          );
        });
      });
      res.on('error', (err) => {
        ws?.destroy();
        // A bare stream error (not the handled over-cap path above) stays
        // retryable — it could be a transient connection blip.
        settle(() =>
          reject(new HostUnavailableError('response stream error', err)),
        );
      });
      ws.on('error', (err) => {
        res.destroy();
        // A write-to-disk failure (ENOSPC, EROFS, EACCES on the runner's tmp)
        // is DETERMINISTIC — re-streaming the same bytes hits the identical
        // error. Mark non-retryable so we fail fast instead of re-transferring
        // the whole bundle for the full 2-min retry window.
        settle(() =>
          reject(
            new HostUnavailableError(
              `write to temp file failed: ${(err as Error).message}`,
              err,
              { retryable: false },
            ),
          ),
        );
      });
    });

    req.on('error', (err) => {
      ws?.destroy();
      const errno = (err as NodeJS.ErrnoException).code;
      if ((err as Error).name === 'AbortError' || errno === 'ABORT_ERR') {
        settle(() => reject(new HostUnavailableError('timeout', err)));
        return;
      }
      if (errno !== undefined && TRANSIENT_ERRNOS.has(errno)) {
        settle(() => reject(new HostUnavailableError(`connect failed: ${errno}`, err)));
        return;
      }
      settle(() =>
        reject(new HostUnavailableError(`request failed: ${(err as Error).message}`, err)),
      );
    });

    req.write(opts.body);
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

  // Per-action wall-clock budget for the CONNECTION-error retry series.
  //
  // The long (2-min) restart-survival budget is ONLY for actions where a retry
  // after a host restart is safe to replay:
  //   - workspace.commit-notify  — parentVersion-idempotent host-side;
  //   - session.next-message     — a cursor poll, no side effect;
  //   - workspace.materialize / workspace.read / session.get-config /
  //     conversation.store-runner-session — reads / idempotent upserts.
  // `tool.execute-host` is NON-IDEMPOTENT: a host tool (MCP mutation,
  // memory_note write, …) may have completed its external side effect before
  // the response was lost, so replaying it across a 2-min window would DUPLICATE
  // the action (Codex). It (and the cheap veto `tool.pre-call` / `tool.list`)
  // keep a SHORT budget — a couple of quick connection retries, no long wait.
  const SHORT_BUDGET_ACTIONS: ReadonlySet<IpcActionName> = new Set<IpcActionName>([
    'tool.execute-host',
    'tool.pre-call',
    'tool.list',
  ]);
  const SHORT_ELAPSED_BUDGET_MS = 3_000;
  const elapsedBudgetFor = (action: IpcActionName): number =>
    SHORT_BUDGET_ACTIONS.has(action) ? SHORT_ELAPSED_BUDGET_MS : maxElapsedMs;

  // Retry loop. `classify` decides whether/how an error retries:
  //   - 'no'        → not retryable; throw immediately (incl. 4xx, schema
  //                   drift, deterministic over-cap responses).
  //   - 'connection'→ a host-unavailable / connection-level failure. Bounded by
  //                   the WALL-CLOCK budget `elapsedBudgetMs`: for the
  //                   runner-lifecycle actions (commit-notify, the inbox poll,
  //                   reads) it's the full 2 min so the runner rides out a host
  //                   OOMKill→reschedule→boot; for the NON-IDEMPOTENT
  //                   `tool.execute-host` it's SHORT (a tool that completed an
  //                   external side effect host-side but lost the response must
  //                   NOT be replayed across a 2-min window — Codex).
  //   - '5xx'       → a host APPLICATION error (HTTP 5xx envelope). DETERMINISTIC
  //                   failures (tool internal error, schema drift) live here —
  //                   they won't self-heal by waiting, so we cap them to a SMALL
  //                   attempt count rather than stretching to the deadline.
  // The loop also honors `maxRetries` as a hard attempt cap (default unbounded
  // so the budget / 5xx-cap govern; explicit callers keep exact counts).
  const withRetry = async <T>(
    classify: (err: unknown) => 'no' | 'connection' | '5xx',
    elapsedBudgetMs: number,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const start = now();
    let lastErr: unknown;
    let fiveXxAttempts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const kind = classify(err);
        // Not retryable (incl. 4xx PluginError) OR the hard attempt cap is
        // reached → throw immediately.
        if (kind === 'no' || attempt === maxRetries) throw err;
        const wait = backoff(attempt);
        if (kind === '5xx') {
          // Deterministic application error → small finite cap, not the
          // wall-clock window.
          fiveXxAttempts += 1;
          if (fiveXxAttempts > MAX_5XX_RETRIES) throw err;
        } else {
          // 'connection' → wall-clock bounded: if the next backoff would push
          // us at/past the budget, give up now.
          if (now() - start + wait >= elapsedBudgetMs) throw err;
        }
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
    if (schema === undefined) {
      // The only action without a JSON schema is workspace.materialize, which
      // is served via callBinary — reaching here means a JSON `call()` was made
      // for it by mistake. Surface loudly rather than silently mis-parsing.
      throw new IpcRequestError(
        'INTERNAL',
        0,
        `no JSON response schema for action '${action}' (binary action?)`,
      );
    }
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

  // Classify a failed attempt for the retry loop. Connection-level failures
  // are wall-clock-bounded (ride out a host restart); 5xx app errors get a
  // small finite cap (deterministic, won't heal by waiting); everything else
  // (4xx, schema drift, deterministic over-cap responses) is not retried.
  const classifyRetry = (err: unknown): 'no' | 'connection' | '5xx' => {
    if (isTransientConnectionError(err)) return 'connection';
    if (err instanceof IpcRequestError && err.status >= 500) return '5xx';
    return 'no';
  };

  const call = async <Action extends IpcActionName>(
    action: Action,
    payload: unknown,
  ): Promise<unknown> => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const timeoutMs = timeoutFor(action);

    return withRetry(
      classifyRetry,
      elapsedBudgetFor(action),
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
      classifyRetry,
      elapsedBudgetFor(action),
      async () => {
        const raw = opts.__requestOnce
          ? await opts.__requestOnce({ method: 'GET', pathWithQuery, timeoutMs })
          : await requestOnce({
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

  const callBinary = async <Action extends 'workspace.materialize'>(
    action: Action,
    payload: unknown,
  ): Promise<{ path: string; bytes: number }> => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const timeoutMs = timeoutFor(action);
    // One temp file for the whole retry series — each attempt truncates it
    // (createWriteStream defaults to 'w'), so a retry never appends to a partial
    // body. The caller owns the file on success; we clean it up on failure.
    const filePath = path.join(
      os.tmpdir(),
      `ax-ipc-binary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`,
    );
    try {
      return await withRetry(
        classifyRetry,
        elapsedBudgetFor(action),
        async () => {
          const raw = await requestOnceBinaryToFile({
            target,
            pathWithQuery: `/${action}`,
            token: opts.token,
            body,
            timeoutMs,
            filePath,
            maxBytes: opts.__maxBinaryResponseBytes ?? MAX_BINARY_RESPONSE_BYTES,
          });
          if (raw.status >= 200 && raw.status < 300) {
            return { path: filePath, bytes: raw.bytesWritten };
          }
          // Non-2xx → parse the buffered error envelope (small JSON) and throw.
          throw parseErrorEnvelope(raw.status, raw.errorBody ?? Buffer.alloc(0));
        },
      );
    } catch (err) {
      // Best-effort cleanup of any partial temp file before propagating — the
      // caller only owns the file on a successful return.
      await unlink(filePath).catch(() => {
        /* never created, or already gone */
      });
      throw err;
    }
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

  return { call, callGet, callBinary, event, close };
}

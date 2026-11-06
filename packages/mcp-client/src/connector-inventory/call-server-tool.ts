// ---------------------------------------------------------------------------
// One-shot `tools/call` against a connector's http MCP server (TASK-1046).
//
// The host makes this call only after a person approved exactly this call,
// so it is built to send AT MOST ONCE and to say honestly what it knows:
//   - One `tools/call` per invocation. Nothing retries it: no 401 renewal, no
//     resumption of a dropped stream (`maxRetries: 0`), no loop.
//   - `failed` only on a definite answer. Nothing completed when the call was
//     never sent (a refused URL, a failed connect, a budget spent before the
//     send) or the transport answered it with an HTTP 4xx (401/403 is
//     `needs-auth`, the rest `rejected`). The one `failed` that is NOT
//     "nothing completed" is `tool-error`: the tool answered `isError`, or
//     the server answered with ANY JSON-RPC error object after the send
//     (review r3 S1). Nothing in such an answer proves the tool did not run:
//     a relay puts whatever its upstream threw on the wire, and some SDKs
//     throw only after running the callback (see `classifyCallError`). It has
//     its own closed code so no caller can mistake it for a refusal.
//   - `unknown` when it was sent and no reliable answer came back: a timeout,
//     a reset, a 5xx, a closed connection, a redirect, an oversize or
//     unreadable reply. A caller must never read that as "nothing happened",
//     or a person re-approves and the call lands twice.
//
// Everything the server sends is UNTRUSTED. The reply is read only for the
// boolean `isError`, through a minimal local schema. We never use
// `client.callTool()` or `CallToolResultSchema`: those validate content
// blocks, and `callTool` can compile a server-supplied output schema. Errors
// are classified on `code`, `name` and class only, because the SDK puts the
// server's response body into the error MESSAGE. A message is never read,
// matched, logged or returned. This file logs nothing; the caller logs codes.
//
// Reach is the inventory's guarded fetch (safe-fetch.ts): https only, one
// origin, no redirects, connect-time IP vetting, a per-request deadline and
// a body cap. Each request through it also carries the call's budget.
// ---------------------------------------------------------------------------

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createGuardedFetch, type AllAddressesResolver, type FetchLike, type GuardedFetch } from './safe-fetch.js';

/** Hard bounds on one approved call. */
export const CALL_LIMITS = {
  /** Deadline for the `initialize` handshake. */
  connectTimeoutMs: 10_000,
  /** Per-HTTP-request deadline, and the `tools/call` request's own. */
  requestTimeoutMs: 30_000,
  /** Wall-clock budget for the whole call, connect included. */
  budgetMs: 45_000,
  /** Per-response body cap. */
  maxResponseBytes: 2 * 1024 * 1024,
} as const;

export type ServerCallOutcome =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; reason: 'needs-auth' | 'unreachable' | 'rejected' | 'tool-error' }
  | { outcome: 'unknown'; reason: 'timeout' | 'interrupted' };

export interface CallServerToolOptions {
  url: string;
  headers: Record<string, string>;
  /** The tool's name as the server knows it (no `mcp.<ns>.` prefix). */
  tool: string;
  /** The tool's arguments, sent exactly as given. */
  input: Record<string, unknown>;
  /** Test seams. */
  resolver?: AllAddressesResolver;
  baseFetch?: (url: string, init: Record<string, unknown>) => Promise<Response>;
  /** Tighter bounds (the caller's remaining budget, or a test's). Numbers, not
   *  `Partial<typeof CALL_LIMITS>`, whose `as const` literals admit only the defaults. */
  limits?: Partial<{ [K in keyof typeof CALL_LIMITS]: number }>;
}

/** The one field of a `tools/call` result we read. The rest is never looked at. */
const CallResultView = z.object({ isError: z.boolean().optional() }).passthrough();

function errorName(err: unknown): string {
  if (err === null || typeof err !== 'object') return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/** A failure during connect: `tools/call` was never sent, so it is definite. */
function classifyConnectError(err: unknown): ServerCallOutcome {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 401 || code === 403 || errorName(err) === 'UnauthorizedError') {
    return { outcome: 'failed', reason: 'needs-auth' };
  }
  return { outcome: 'failed', reason: 'unreachable' };
}

/** A failure after `tools/call` was sent: definite only when the answer says so. */
function classifyCallError(err: unknown): ServerCallOutcome {
  // An HTTP status, as the transport saw it. Only these mean the request
  // itself was turned away, and that is an ASSUMPTION (review r3 S2): a
  // conformant server sends a 4xx only when it cannot accept the request. A
  // gateway or WAF that rewrites an answered call's RESPONSE into a 4xx would
  // make a call that ran read as refused: an accepted residual, invisible here.
  if (err instanceof StreamableHTTPError) {
    const status = err.code;
    if (status === 401 || status === 403) return { outcome: 'failed', reason: 'needs-auth' };
    if (status !== undefined && status >= 400 && status <= 499) return { outcome: 'failed', reason: 'rejected' };
    return { outcome: 'unknown', reason: 'interrupted' };
  }
  // A JSON-RPC error. No code means "refused, nothing ran" once the call is
  // out (review r3 S1), so there is no rejected set here any more. The server
  // picks the number, and the number says nothing about whether the tool ran:
  //   - an McpServer on SDK 1.12-1.20 runs the callback and then throws
  //     -32602 (InvalidParams) for "output schema but no structured content"
  //     (review r2 R1);
  //   - SDK 1.32.1's own `Client.callTool` throws -32600 (InvalidRequest)
  //     AFTER getting such a result, and a low-level `Server` relay puts
  //     whatever its upstream threw on the wire, so -32600, -32700 or -32601
  //     can come back for a call that already completed.
  // So any JSON-RPC error object is the server's answer to a call it had:
  // `tool-error`, the same answer as `isError`.
  //
  // Except the two codes the SDK raises ITSELF after the send, with no answer
  // at all: -32001 RequestTimeout (our own deadline, or a budget abort it
  // wraps) and -32000 ConnectionClosed (the transport closed with the call
  // pending). By code, a server sending either number reads the same, and
  // "no reliable answer" is the honest reading of both: `unknown`.
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return { outcome: 'unknown', reason: 'timeout' };
    if (err.code === ErrorCode.ConnectionClosed) return { outcome: 'unknown', reason: 'interrupted' };
    return { outcome: 'failed', reason: 'tool-error' };
  }
  const name = errorName(err);
  if (name === 'TimeoutError' || name === 'AbortError') return { outcome: 'unknown', reason: 'timeout' };
  return { outcome: 'unknown', reason: 'interrupted' };
}

/**
 * Connect to one http MCP server through the guarded fetch, send exactly one
 * `tools/call`, and close. Never throws: every failure is an outcome.
 */
export async function callServerTool(opts: CallServerToolOptions): Promise<ServerCallOutcome> {
  const limits = { ...CALL_LIMITS, ...(opts.limits ?? {}) };
  const oversize = new AbortController();
  let budget: AbortSignal;
  let guarded: GuardedFetch;
  try {
    budget = AbortSignal.any([AbortSignal.timeout(limits.budgetMs), oversize.signal]);
    guarded = createGuardedFetch({
      serverUrl: opts.url,
      timeoutMs: limits.requestTimeoutMs,
      maxResponseBytes: limits.maxResponseBytes,
      onOversize: (error) => oversize.abort(error),
      ...(opts.resolver !== undefined ? { resolver: opts.resolver } : {}),
      ...(opts.baseFetch !== undefined ? { baseFetch: opts.baseFetch } : {}),
    });
  } catch {
    // The URL broke policy (not https, userinfo, a private address literal),
    // or the limits were unusable. Nothing was sent.
    return { outcome: 'failed', reason: 'unreachable' };
  }
  // The budget rides on every request the transport makes, beside that
  // request's own signal. The SDK passes our signal only to `initialize` and
  // `tools/call`. Without this, `notifications/initialized` (which connect
  // awaits), the optional GET stream and cancellations would answer only to
  // the per-request deadline, and the call could outlive its budget.
  const budgeted: FetchLike = (url, init) =>
    guarded.fetch(url, {
      ...(init ?? {}),
      signal: init?.signal !== undefined && init.signal !== null ? AbortSignal.any([init.signal, budget]) : budget,
    });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    fetch: budgeted,
    requestInit: { headers: opts.headers },
    // One shot: never resume a dropped stream in the background.
    reconnectionOptions: {
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: '@ax/mcp-client', version: '0.0.0' }, { capabilities: {} });
  // The SDK reports background-stream errors (e.g. a 405 on the optional GET
  // stream, a dropped SSE reply) via onerror. The request's own promise is
  // the only answer we use.
  client.onerror = () => {};
  try {
    try {
      // exactOptionalPropertyTypes: the SDK's own transport class is wider than
      // its `Transport` interface on `sessionId`; identical at runtime.
      await client.connect(transport as unknown as Parameters<Client['connect']>[0], {
        signal: budget,
        timeout: limits.connectTimeoutMs,
      });
    } catch (err) {
      return classifyConnectError(err);
    }
    // An answer can land just after the budget runs out (an abort cannot
    // recall a response already on its way), so connect can return late.
    // `tools/call` has not reached the transport yet, so this is definite.
    // From `client.request` on, the call may be out.
    if (budget.aborted) return { outcome: 'failed', reason: 'unreachable' };
    try {
      const reply = await client.request(
        { method: 'tools/call', params: { name: opts.tool, arguments: opts.input } },
        CallResultView,
        { signal: budget, timeout: limits.requestTimeoutMs },
      );
      // `isError` is the service's answer once the call went out (review F3):
      // not a refusal. The tool may have run and done part of the work.
      return reply.isError === true ? { outcome: 'failed', reason: 'tool-error' } : { outcome: 'succeeded' };
    } catch (err) {
      // An oversize reply aborts the budget, which the SDK reports as a
      // request timeout, so the size check comes first.
      return oversize.signal.aborted ? { outcome: 'unknown', reason: 'interrupted' } : classifyCallError(err);
    }
  } finally {
    await client.close().catch(() => {});
    await guarded.close();
  }
}

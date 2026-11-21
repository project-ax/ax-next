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
//     the server answered with any JSON-RPC error object after the send
//     except -32001/-32000, which read `unknown` (review r3 S1). Nothing in such an answer proves the tool did not run:
//     a relay puts whatever its upstream threw on the wire, and some SDKs
//     throw only after running the callback (see `classifyCallError`). It has
//     its own closed code so no caller can mistake it for a refusal.
//   - `unknown` when it was sent and no reliable answer came back: a timeout,
//     a reset, a 5xx, a closed connection, a redirect, an oversize or
//     unreadable reply. A caller must never read that as "nothing happened",
//     or a person re-approves and the call lands twice.
//
// Everything the server sends is UNTRUSTED. `callServerTool` reads the reply
// only for the boolean `isError`, through a minimal local schema.
// `callServerToolWithContent` (for `connectors:call-tool-result`) also hands
// back its `content` blocks, checked against a local schema and capped by the
// body limit. We never use `client.callTool()` or `CallToolResultSchema`:
// those validate content blocks, and `callTool` can compile a server-supplied
// output schema. Errors
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
import { loggableCode } from './loggable-code.js';
import { createGuardedFetch, type AllAddressesResolver, type FetchLike, type GuardedFetch } from './safe-fetch.js';
import { ConnectorResultContentBlockSchema, type ConnectorResultContentBlock } from './types.js';

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

export type ServerCallFailed = { outcome: 'failed'; reason: 'needs-auth' | 'unreachable' | 'rejected' | 'tool-error' };
export type ServerCallUnknown = { outcome: 'unknown'; reason: 'timeout' | 'interrupted' };
export type ServerCallOutcome = { outcome: 'succeeded' } | ServerCallFailed | ServerCallUnknown;
/** `callServerToolWithContent`'s answer: the reply's content on success and on a tool error. */
export type ServerCallResultOutcome =
  | { outcome: 'succeeded'; content: ConnectorResultContentBlock[] }
  | { outcome: 'failed'; reason: 'tool-error'; content: ConnectorResultContentBlock[] }
  | { outcome: 'failed'; reason: 'needs-auth' | 'unreachable' | 'rejected' }
  | ServerCallUnknown;

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

/** The one field of a `tools/call` result every caller reads. The rest is passed to `onReply` unvalidated. */
const CallResultView = z.object({ isError: z.boolean().optional() }).passthrough();

/** A reply's `content`, as `callServerToolWithContent` accepts it. */
const ContentView = z.array(ConnectorResultContentBlockSchema);

/**
 * Answers `sendOneCall` made up because its own `onReply` failed, with the
 * failure's loggable code when it has one. Identity-keyed, so the mark never
 * rides on the answer's shape: the hook's `returns` schema still sees a plain
 * `unknown`/`interrupted`.
 */
const unforeseen = new WeakMap<object, { code?: string }>();

/**
 * The answer when `onReply` failed: the call went out, so `unknown`, and
 * marked so the caller's log line can say it was unforeseen (the same
 * `unexpected: true` the handler's catch-all logs).
 */
export function unforeseenInterruption(err: unknown): ServerCallUnknown {
  const out: ServerCallUnknown = { outcome: 'unknown', reason: 'interrupted' };
  const code = loggableCode(err);
  unforeseen.set(out, code !== undefined ? { code } : {});
  return out;
}

/** The mark `unforeseenInterruption` left on this answer, or `undefined` for a genuine one. */
export function unforeseenMark(out: unknown): { code?: string } | undefined {
  return out !== null && typeof out === 'object' ? unforeseen.get(out) : undefined;
}

function errorName(err: unknown): string {
  if (err === null || typeof err !== 'object') return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/** A failure during connect: `tools/call` was never sent, so it is definite. */
function classifyConnectError(err: unknown): ServerCallFailed {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 401 || code === 403 || errorName(err) === 'UnauthorizedError') {
    return { outcome: 'failed', reason: 'needs-auth' };
  }
  return { outcome: 'failed', reason: 'unreachable' };
}

/** A failure after `tools/call` was sent: definite only when the answer says so. */
function classifyCallError(err: unknown): ServerCallFailed | ServerCallUnknown {
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
  // -32000 is defensive: on SDK 1.32.1 the transport only fires onclose from
  // close(), which we call after the request settles, so mid-call it can only
  // come from the server. -32001 is load-bearing (our timeouts and budget).
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
 *
 * `onReply` turns the server's answer into the caller's success shape. It
 * sees the reply only as `CallResultView` let it through (`isError`, the rest
 * unvalidated and untrusted). It runs before `close()`, in a try of its own
 * and awaited, so a throw or a rejection from it is caught there. It runs
 * after the call went out, so such a failure is `unknown`/`interrupted`,
 * never `failed`: it never goes through `classifyCallError`, which would read
 * an McpError-shaped throw as an answer from the server. The answer is
 * marked (`unforeseenMark`) so the caller can log it as unforeseen.
 */
export async function sendOneCall<S>(
  opts: CallServerToolOptions,
  onReply: (reply: { isError?: boolean | undefined } & Record<string, unknown>) => S | Promise<S>,
): Promise<S | ServerCallFailed | ServerCallUnknown> {
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
    let reply: { isError?: boolean | undefined } & Record<string, unknown>;
    try {
      reply = await client.request(
        { method: 'tools/call', params: { name: opts.tool, arguments: opts.input } },
        CallResultView,
        { signal: budget, timeout: limits.requestTimeoutMs },
      );
    } catch (err) {
      // An oversize reply aborts the budget, which the SDK reports as a
      // request timeout, so the size check comes first.
      return oversize.signal.aborted ? { outcome: 'unknown', reason: 'interrupted' } : classifyCallError(err);
    }
    try {
      return await onReply(reply);
    } catch (err) {
      return unforeseenInterruption(err);
    }
  } finally {
    await client.close().catch(() => {});
    await guarded.close();
  }
}

/** `sendOneCall`, answering the outcome only: nothing the server said comes back. */
export function callServerTool(opts: CallServerToolOptions): Promise<ServerCallOutcome> {
  // `isError` is the service's answer once the call went out (review F3):
  // not a refusal. The tool may have run and done part of the work.
  return sendOneCall<ServerCallOutcome>(opts, (reply) =>
    reply.isError === true ? { outcome: 'failed', reason: 'tool-error' } : { outcome: 'succeeded' },
  );
}

/**
 * `sendOneCall`, answering the outcome and the reply's content blocks (for
 * `connectors:call-tool-result`). The blocks are UNTRUSTED. They are
 * checked against `ContentView` and handed back as the reply's own array,
 * never zod's copy.
 *   - Not `isError`: no `content` is success with no blocks; readable content
 *     is success with it; anything else is `unknown`/`interrupted` (the call
 *     went out and the answer could not be read).
 *   - `isError`: `tool-error` with the content when it is readable, else
 *     none. The service did say it failed, so an unreadable error body does
 *     not turn into `unknown`.
 *   - A `tool-error` from a JSON-RPC error object has no reply body: no
 *     content. Its message is never read.
 */
export async function callServerToolWithContent(opts: CallServerToolOptions): Promise<ServerCallResultOutcome> {
  const out = await sendOneCall<ServerCallResultOutcome>(opts, (reply) => {
    const content = reply.content;
    const readable = ContentView.safeParse(content).success;
    if (reply.isError === true) {
      return {
        outcome: 'failed',
        reason: 'tool-error',
        content: readable ? (content as ConnectorResultContentBlock[]) : [],
      };
    }
    if (content === undefined) return { outcome: 'succeeded', content: [] };
    if (readable) return { outcome: 'succeeded', content: content as ConnectorResultContentBlock[] };
    return { outcome: 'unknown', reason: 'interrupted' };
  });
  if (out.outcome === 'failed' && out.reason === 'tool-error' && !('content' in out)) {
    return { outcome: 'failed', reason: 'tool-error', content: [] };
  }
  // Every other answer already has one of ServerCallResultOutcome's shapes:
  // the shared classification's `tool-error` (the one without content) is
  // handled above. Returned as is, so an unforeseen mark survives.
  return out as ServerCallResultOutcome;
}

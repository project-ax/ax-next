// Shared test harness: a REAL HookBus with the plugin initialized on it, plus
// a minimal AgentContext. Every suite drives the hooks through `bus.call`
// rather than calling a handler directly — the bus is where the payload
// actually arrives from another plugin, and it is also what turns a thrown
// non-PluginError into a `code: 'unknown'` one. Testing the handler in
// isolation would not see either.

import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';
import { createEmbeddingsPlugin, type EmbeddingsConfig } from '../plugin.js';

export const ctx: AgentContext = makeAgentContext({
  sessionId: 's',
  agentId: 'a',
  userId: 'u',
  workspace: { rootPath: '/tmp' },
});

/** A ctx for a specific user — `''` exercises the userId-less path. */
export function ctxForUser(userId: string): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId, workspace: { rootPath: '/tmp' } });
}

/** The `credentials:get` payload, declared locally (Invariant 2), as the plugin sends it. */
export interface CredentialsGetInput {
  ref: string;
  userId: string;
}

export interface HarnessOptions {
  /**
   * Register a stub `credentials:get` producer. A string is returned as-is; a
   * function may return anything (or throw) so a suite can exercise the
   * "credential store said no" paths. Omit it entirely to leave the hook
   * unregistered.
   */
  credential?: string | ((input: CredentialsGetInput) => unknown);
}

/** A bus with `@ax/embeddings` initialized on it, and optionally a stub credential store. */
export async function busWithPlugin(
  config?: EmbeddingsConfig,
  opts: HarnessOptions = {},
): Promise<HookBus> {
  const bus = new HookBus();
  if (opts.credential !== undefined) {
    const { credential } = opts;
    bus.registerService<CredentialsGetInput, unknown>(
      'credentials:get',
      'test:creds',
      async (_ctx, input) => (typeof credential === 'string' ? credential : credential(input)),
    );
  }
  await createEmbeddingsPlugin(config).init({ bus, config: {} });
  return bus;
}

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The JSON-parsed request body, or `undefined` when there wasn't one. */
  body: unknown;
  /** The raw request body, so a suite can assert a token is NOT in it. */
  rawBody: string;
  signal: AbortSignal | undefined;
}

export interface FetchStub {
  impl: typeof fetch;
  calls: RecordedCall[];
}

function headerRecord(init: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (init === undefined) return out;
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * A `fetch` that never touches a network: it records every request and hands
 * the call to `respond`, which decides what comes back. `calls.length` is the
 * assertion that matters most in this suite — several tests exist purely to
 * prove we did NOT dial out.
 */
export function fetchStub(
  respond: (call: RecordedCall, index: number) => Response | Promise<Response>,
): FetchStub {
  const calls: RecordedCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const call: RecordedCall = {
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      body: rawBody === '' ? undefined : JSON.parse(rawBody),
      rawBody,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { impl, calls };
}

/** A 200 whose body is `JSON.stringify(value)`. */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A 200 whose `json()` resolves to `value` AS GIVEN — no JSON round trip.
 *
 * JSON has no `NaN` and no `Infinity`, so those two can only be smuggled past
 * a real `Response`; a provider SDK, a proxy that rewrites bodies, or a future
 * non-JSON transport can still hand us one. The finiteness checks exist for
 * that, and this is the only way to aim a test at them.
 */
export function rawJsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response;
}

/** A response that never arrives, and rejects when the driver's deadline aborts it. */
export function neverResponds(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function l2(v: readonly number[]): number {
  return Math.hypot(...v);
}

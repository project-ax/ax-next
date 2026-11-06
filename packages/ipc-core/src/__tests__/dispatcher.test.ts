import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PluginError, reject, hold } from '@ax/core';
import type {
  ToolCall,
  ToolDescriptor,
} from '@ax/ipc-protocol';
import { PRE_CALL_REJECT_REASON_MAX } from '@ax/ipc-protocol';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionCreateInput,
  SessionCreateOutput,
  SessionClaimWorkOutput,
  SessionQueueWorkInput,
  SessionQueueWorkOutput,
} from '@ax/session-inmemory';
// The dispatcher test exercises a real unix-socket listener end-to-end —
// the listener lives in @ax/ipc-server (transport-specific), not in
// @ax/ipc-core. Tests are exempt from cross-plugin import lint rules
// (eslint.config.mjs allowlists `packages/*/src/__tests__/**`).
import { createListener, type Listener } from '@ax/ipc-server';

// ---------------------------------------------------------------------------
// Dispatcher tests
//
// End-to-end over a real unix socket: each test builds a bus with a session
// plugin plus the mock services the handler under test needs, spins up a
// listener, and hits it with a node http client. The request signs itself
// with the mint-token path from @ax/session-inmemory so we exercise the
// five inbound gates every run.
//
// For events, a Promise is used to wait until a registered subscriber fires
// before asserting — events return 202 immediately and the subscriber runs
// asynchronously (see dispatcher.ts fire-and-forget shape).
// ---------------------------------------------------------------------------

interface Setup {
  listener: Listener;
  token: string;
  socketPath: string;
  harness: TestHarness;
  cleanup: () => Promise<void>;
}

interface SetupOptions {
  sessionId?: string;
  services?: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>;
  subscribers?: Array<{
    hook: string;
    plugin?: string;
    handler: (ctx: unknown, payload: unknown) => Promise<unknown>;
  }>;
  /** Extra plugins to bootstrap alongside the in-memory session plugin. */
  plugins?: Parameters<typeof createTestHarness>[0] extends infer O
    ? O extends { plugins?: infer P }
      ? P
      : never
    : never;
}

async function setup(opts: SetupOptions = {}): Promise<Setup> {
  const sessionId = opts.sessionId ?? 's-dispatch';
  const harness = await createTestHarness({
    plugins: [createSessionInmemoryPlugin(), ...(opts.plugins ?? [])],
    // Inject mock services BEFORE plugins bootstrap; the test-harness
    // `services` param registers them first and plugins run after.
    services: opts.services,
  });
  for (const sub of opts.subscribers ?? []) {
    harness.bus.subscribe(
      sub.hook,
      sub.plugin ?? 'mock',
      sub.handler as never,
    );
  }
  const ctx = harness.ctx();
  const { token } = await harness.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    ctx,
    { sessionId, workspaceRoot: '/tmp/ws' },
  );
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-disp-'));
  const socketPath = path.join(tempDir, 'ipc.sock');
  const listener = await createListener({ socketPath, sessionId, bus: harness.bus });
  return {
    listener,
    token,
    socketPath,
    harness,
    cleanup: async () => {
      await listener.close();
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

interface Response {
  status: number;
  body: string;
}

function doRequest(
  socketPath: string,
  method: string,
  reqPath: string,
  token: string,
  body?: string,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body ?? '', 'utf8'));
    }
    const req = http.request(
      { socketPath, path: reqPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (method === 'POST' && body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Records every chunk written to `stream`, and still writes it through.
 * The listener's per-request ctx logs with the default core logger, which
 * writes one JSON line per entry to process.stdout — so this sees the real
 * serialization, Error bindings included. Same shape as ipc-http's
 * listener.test.ts (TASK-1018).
 */
function captureWrites(stream: NodeJS.WriteStream): {
  chunks: string[];
  restore: () => void;
} {
  const chunks: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stream.write);
  return { chunks, restore: () => spy.mockRestore() };
}

/** The JSON log entries among captured chunks; anything else is skipped. */
function parsedEntries(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

describe('dispatcher', () => {
  const setups: Setup[] = [];

  afterEach(async () => {
    for (const s of setups) await s.cleanup();
    setups.length = 0;
  });

  // -------------------------------------------------------------------------
  // /tool.pre-call
  // -------------------------------------------------------------------------

  it('POST /tool.pre-call — pass-through → {verdict: allow, modifiedCall}', async () => {
    const s = await setup({});
    setups.push(s);
    const call: ToolCall = { id: 'c1', name: 'bash', input: { cmd: 'ls' } };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/tool.pre-call',
      s.token,
      JSON.stringify({ call }),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.verdict).toBe('allow');
    expect(parsed.modifiedCall).toEqual(call);
  });

  it('POST /tool.pre-call — subscriber rewrites input', async () => {
    const s = await setup({
      subscribers: [
        {
          hook: 'tool:pre-call',
          handler: async (_ctx, payload) => {
            const call = payload as ToolCall;
            return { ...call, input: { cmd: 'echo rewritten' } };
          },
        },
      ],
    });
    setups.push(s);
    const call: ToolCall = { id: 'c1', name: 'bash', input: { cmd: 'ls' } };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/tool.pre-call',
      s.token,
      JSON.stringify({ call }),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.verdict).toBe('allow');
    expect(parsed.modifiedCall.input).toEqual({ cmd: 'echo rewritten' });
  });

  it('POST /tool.pre-call — subscriber rejects → 200 with verdict: reject', async () => {
    const s = await setup({
      subscribers: [
        {
          hook: 'tool:pre-call',
          handler: async () => reject({ reason: 'rm -rf blocked' }),
        },
      ],
    });
    setups.push(s);
    const call: ToolCall = { id: 'c1', name: 'bash', input: { cmd: 'rm -rf /' } };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/tool.pre-call',
      s.token,
      JSON.stringify({ call }),
    );
    expect(res.status).toBe(200); // NOT 409 — reject is a valid verdict
    const parsed = JSON.parse(res.body);
    expect(parsed.verdict).toBe('reject');
    expect(parsed.reason).toBe('rm -rf blocked');
  });

  it('POST /tool.pre-call — an over-long deny reason is shortened, and is still that deny', async () => {
    // A subscriber can put any string in `reason`. Too long must come back as
    // the same "no", cut to the wire ceiling — not a 500 that the runner turns
    // into a generic gate-failed message.
    const long = 'Not allowed: ' + 'blocked because '.repeat(400);
    expect(long.length).toBeGreaterThan(PRE_CALL_REJECT_REASON_MAX);
    const s = await setup({
      subscribers: [{ hook: 'tool:pre-call', handler: async () => reject({ reason: long }) }],
    });
    setups.push(s);
    const call: ToolCall = { id: 'c1', name: 'bash', input: { cmd: 'rm -rf /' } };
    const res = await doRequest(s.socketPath, 'POST', '/tool.pre-call', s.token, JSON.stringify({ call }));
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.verdict).toBe('reject');
    expect(parsed.reason).toBe(long.slice(0, PRE_CALL_REJECT_REASON_MAX));
  });

  it('POST /tool.pre-call — shortening a deny reason never splits an emoji in half', async () => {
    // Puts a surrogate pair straddling the cut: code units 1999 and 2000.
    const long = 'x'.repeat(PRE_CALL_REJECT_REASON_MAX - 1) + '\u{1F6AB}' + 'tail';
    const s = await setup({
      subscribers: [{ hook: 'tool:pre-call', handler: async () => reject({ reason: long }) }],
    });
    setups.push(s);
    const call: ToolCall = { id: 'c1', name: 'bash', input: {} };
    const res = await doRequest(s.socketPath, 'POST', '/tool.pre-call', s.token, JSON.stringify({ call }));
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.verdict).toBe('reject');
    expect(parsed.reason).toBe('x'.repeat(PRE_CALL_REJECT_REASON_MAX - 1));
  });

  it('POST /tool.pre-call — subscriber holds → 200 with verdict: hold, not reject', async () => {
    const s = await setup({
      subscribers: [
        {
          hook: 'tool:pre-call',
          handler: async () => hold({ decisionId: 'dec_42', note: 'Held for approval' }),
        },
      ],
    });
    setups.push(s);
    const call: ToolCall = { id: 'c1', name: 'gmail_send', input: {} };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/tool.pre-call',
      s.token,
      JSON.stringify({ call }),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      verdict: 'hold',
      decisionId: 'dec_42',
      note: 'Held for approval',
    });
    expect(parsed.verdict).not.toBe('reject');
  });

  // -------------------------------------------------------------------------
  // /tool.execute-host
  // -------------------------------------------------------------------------

  it('POST /tool.execute-host with no registered tool → 404 VALIDATION', async () => {
    const s = await setup({});
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/tool.execute-host',
      s.token,
      JSON.stringify({ call: { id: 'c1', name: 'nobody', input: {} } }),
    );
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.message).toContain("no host-side tool for 'nobody'");
  });

  it('a host tool throwing a PluginError → redacted to a generic 500 (no message leak)', async () => {
    // A host tool's PluginError is mapped generically by mapPluginError; the
    // message is never painted onto the wire (I9), since codes/plugin are
    // plugin-supplied and could carry a host-side secret.
    const s = await setup({
      services: {
        'tool:execute:sometool': async () => {
          throw new PluginError({
            code: 'timeout',
            plugin: '@ax/some-plugin',
            message: 'connected to internal-host:5432 with password hunter2',
          });
        },
      },
    });
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/tool.execute-host',
      s.token,
      JSON.stringify({ call: { id: 'c1', name: 'sometool', input: {} } }),
    );
    expect(res.status).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('INTERNAL');
    expect(parsed.error.message).toBe('internal server error');
    expect(res.body).not.toContain('hunter2');
  });

  // -------------------------------------------------------------------------
  // /tool.list
  // -------------------------------------------------------------------------

  it('POST /tool.list — happy path', async () => {
    const descriptors: ToolDescriptor[] = [
      { name: 'bash', inputSchema: { type: 'object' }, executesIn: 'sandbox' },
    ];
    const s = await setup({
      services: {
        'tool:list': async () => ({ tools: descriptors }),
      },
    });
    setups.push(s);
    const res = await doRequest(s.socketPath, 'POST', '/tool.list', s.token, '{}');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ tools: descriptors });
  });

  // -------------------------------------------------------------------------
  // /session.next-message
  // -------------------------------------------------------------------------

  it('GET /session.next-message?cursor=0 — returns user-message when queued', async () => {
    const s = await setup({ sessionId: 's-claim' });
    setups.push(s);
    // Queue a message so claim-work returns immediately.
    const ctx = s.harness.ctx({ sessionId: 's-claim' });
    await s.harness.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctx,
      {
        sessionId: 's-claim',
        entry: {
          type: 'user-message',
          payload: { role: 'user', content: 'hi' },
          reqId: 'r-claim',
        },
      },
    );
    const res = await doRequest(
      s.socketPath,
      'GET',
      '/session.next-message?cursor=0',
      s.token,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as SessionClaimWorkOutput;
    expect(parsed.type).toBe('user-message');
    if (parsed.type === 'user-message') {
      expect(parsed.payload).toEqual({ role: 'user', content: 'hi' });
      expect(parsed.reqId).toBe('r-claim');
      expect(parsed.cursor).toBe(1);
    }
  });

  it('GET /session.next-message — delivers an interrupt entry as { type: interrupt, cursor } (TASK-688)', async () => {
    // The handler re-validates the claim result against the wire schema (its
    // own outbound drift guard). An `interrupt` missing from that closed union
    // would come back as a 500 INTERNAL here — and Stop would silently do
    // nothing, because the runner never receives the entry.
    const s = await setup({ sessionId: 's-interrupt' });
    setups.push(s);
    const ctx = s.harness.ctx({ sessionId: 's-interrupt' });
    await s.harness.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctx,
      { sessionId: 's-interrupt', entry: { type: 'interrupt' } },
    );
    const res = await doRequest(
      s.socketPath,
      'GET',
      '/session.next-message?cursor=0',
      s.token,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ type: 'interrupt', cursor: 1 });
  });

  it('GET /session.next-message — missing cursor → 400 VALIDATION', async () => {
    const s = await setup({});
    setups.push(s);
    const res = await doRequest(s.socketPath, 'GET', '/session.next-message', s.token);
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('VALIDATION');
  });

  it('GET /session.next-message?cursor=-1 → 400 VALIDATION', async () => {
    const s = await setup({});
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'GET',
      '/session.next-message?cursor=-1',
      s.token,
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('VALIDATION');
  });

  // -------------------------------------------------------------------------
  // /event.tool-post-call
  // -------------------------------------------------------------------------

  it('POST /event.tool-post-call — fires tool:post-call subscriber', async () => {
    let received: unknown = null;
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'tool:post-call',
          handler: async (_ctx, payload) => {
            received = payload;
            resolved(payload);
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const eventBody = {
      call: { id: 'c1', name: 'bash', input: { cmd: 'ls' } },
      output: { stdout: 'a b c', stderr: '', exitCode: 0 },
    };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.tool-post-call',
      s.token,
      JSON.stringify(eventBody),
    );
    expect(res.status).toBe(202);
    await firePromise;
    expect(received).toMatchObject({
      toolCall: eventBody.call,
      output: eventBody.output,
    });
  });

  it('POST /event.tool-post-call — responds 202 promptly even with slow subscriber', async () => {
    // Regression guard for the fire-and-forget shape: if the dispatcher
    // awaited the subscriber, a slow one would hold the response open.
    let fireReleased = false;
    let releaseFire: () => void = () => {};
    const firedPromise = new Promise<void>((resolve) => {
      releaseFire = () => {
        fireReleased = true;
        resolve();
      };
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'tool:post-call',
          handler: async () => {
            // Hold open until the test releases us.
            await new Promise<void>((r) => setTimeout(r, 250));
            releaseFire();
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const start = Date.now();
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.tool-post-call',
      s.token,
      JSON.stringify({
        call: { id: 'c1', name: 'bash', input: {} },
        output: null,
      }),
    );
    const elapsed = Date.now() - start;
    expect(res.status).toBe(202);
    // Response arrived well before the 250 ms subscriber delay.
    expect(elapsed).toBeLessThan(200);
    // Subscriber hadn't fired yet when we got the response.
    expect(fireReleased).toBe(false);
    // Let the subscriber finish so cleanup is clean.
    await firedPromise;
  });

  // -------------------------------------------------------------------------
  // /event.connector-auth-failure (TASK-842)
  // -------------------------------------------------------------------------

  it('POST /event.connector-auth-failure — fires connectors:auth-failure-reported with one entry per namespace', async () => {
    let resolved: (v: { ctx: unknown; payload: unknown }) => void = () => {};
    const fired = new Promise<{ ctx: unknown; payload: unknown }>((r) => {
      resolved = r;
    });
    const s = await setup({
      sessionId: 's-auth-report',
      subscribers: [
        {
          hook: 'connectors:auth-failure-reported',
          handler: async (ctx, payload) => {
            resolved({ ctx, payload });
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.connector-auth-failure',
      s.token,
      JSON.stringify({
        servers: [
          { toolNamespace: 'c0123456789', status: 'needs-auth' },
          { toolNamespace: 'cabcdef0123', status: 'tool-error' },
          { toolNamespace: 'c0123456789', status: 'tool-error' },
        ],
      }),
    );
    expect(res.status).toBe(202);
    const { ctx, payload } = await fired;
    expect(payload).toEqual({
      servers: [
        { toolNamespace: 'c0123456789', status: 'needs-auth' },
        { toolNamespace: 'cabcdef0123', status: 'tool-error' },
      ],
    });
    // Who the report is about comes from the authenticated session, never the body.
    expect((ctx as { sessionId: string }).sessionId).toBe('s-auth-report');
  });

  it('POST /event.connector-auth-failure — refuses a payload carrying more than namespace + status', async () => {
    let fired = false;
    const s = await setup({
      subscribers: [
        {
          hook: 'connectors:auth-failure-reported',
          handler: async () => {
            fired = true;
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    for (const body of [
      { servers: [{ toolNamespace: 'c0123456789', status: 'failed', error: 'Bearer sk-live' }] },
      { servers: [{ toolNamespace: 'linear', status: 'failed' }] },
      { servers: [] },
    ]) {
      const res = await doRequest(
        s.socketPath,
        'POST',
        '/event.connector-auth-failure',
        s.token,
        JSON.stringify(body),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('VALIDATION');
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(false);
  });

  it('POST /event.connector-auth-failure — 202 with no subscriber (a deployment without the connector inventory)', async () => {
    const s = await setup();
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.connector-auth-failure',
      s.token,
      JSON.stringify({ servers: [{ toolNamespace: 'c0123456789', status: 'failed' }] }),
    );
    expect(res.status).toBe(202);
  });

  // -------------------------------------------------------------------------
  // /event.turn-end
  // -------------------------------------------------------------------------

  it('POST /event.turn-end — fires chat:turn-end subscriber', async () => {
    let received: unknown = null;
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'chat:turn-end',
          handler: async (_ctx, payload) => {
            received = payload;
            resolved(payload);
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const body = {
      reqId: 'r-1',
      reason: 'complete' as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.turn-end',
      s.token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await firePromise;
    expect(received).toEqual(body);
  });

  it('POST /event.turn-end — the runner-reported usage reaches chat:turn-end whole; unknown keys are stripped (TASK-692)', async () => {
    // The host meter reads `usage` off the chat:turn-end payload, so every field
    // the runner reports must survive validation. Before TASK-692 the schema
    // silently DROPPED `model` and the cache buckets on the way through.
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'chat:turn-end',
          handler: async (_ctx, payload) => {
            resolved(payload);
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const usage = {
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 850,
      cacheWriteTokens: 50,
    };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.turn-end',
      s.token,
      JSON.stringify({
        reqId: 'r-1',
        reason: 'user-message-wait',
        role: 'assistant',
        usage: { ...usage, costUsd: 0 },
      }),
    );
    expect(res.status).toBe(202);
    const received = (await firePromise) as { usage?: unknown };
    expect(received.usage).toEqual(usage);
  });

  it('POST /event.turn-end — foldedReqIds reaches chat:turn-end (TASK-708)', async () => {
    // agent-activity drains a folded message's turn off this field; the wire
    // schema strips undeclared keys, so it has to survive validation.
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'chat:turn-end',
          handler: async (_ctx, payload) => {
            resolved(payload);
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.turn-end',
      s.token,
      JSON.stringify({
        reqId: 'r-1',
        reason: 'user-message-wait',
        role: 'assistant',
        foldedReqIds: ['r-2'],
      }),
    );
    expect(res.status).toBe(202);
    const received = (await firePromise) as { reqId?: unknown; foldedReqIds?: unknown };
    expect(received.reqId).toBe('r-1');
    expect(received.foldedReqIds).toEqual(['r-2']);
  });

  it('POST /event.turn-end — a usage count over the ceiling is a 400, not a metered turn (TASK-692)', async () => {
    const s = await setup({});
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.turn-end',
      s.token,
      JSON.stringify({
        reason: 'complete',
        usage: { inputTokens: 1_000_000_001, outputTokens: 1 },
      }),
    );
    expect(res.status).toBe(400);
  });

  // Helper: open a conversation-bound session + its own listener so the
  // listener stamps ctx.conversationId (the persist guard keys off it).
  async function setupConvSession(
    convId: string,
    sessionId: string,
    services: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>,
  ): Promise<{ socketPath: string; token: string; close: () => Promise<void> }> {
    const s = await setup({ services });
    setups.push(s);
    const { token } = await s.harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', s.harness.ctx(), {
      sessionId,
      workspaceRoot: '/tmp/ws',
      owner: {
        userId: 'u-1',
        agentId: 'a-1',
        agentConfig: {
          displayName: 'Test Agent',
          systemPromptAugment: 'be helpful',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-sonnet-4-7',
          runner: 'claude-sdk',
        },
        conversationId: convId,
      },
    });
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-disp-pba-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const listener = await createListener({
      socketPath,
      sessionId,
      bus: s.harness.bus,
    });
    return {
      socketPath,
      token,
      close: async () => {
        await listener.close();
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  it('POST /event.turn-end — AWAITS the display-log persist BEFORE the 202 (persist-before-ack, TASK-66)', async () => {
    // For turn-end the dispatcher holds the ack open until the ISOLATED
    // conversations:append-event persist completes — the turn's frames are
    // durable in the display log before the runner sees the turn acked (B3).
    let persisted = false;
    const conv = await setupConvSession('conv-pba', 's-pba', {
      'conversations:append-event': async () => {
        await new Promise<void>((r) => setTimeout(r, 250));
        persisted = true;
        return undefined;
      },
    });
    try {
      const start = Date.now();
      const res = await doRequest(
        conv.socketPath,
        'POST',
        '/event.turn-end',
        conv.token,
        JSON.stringify({
          reqId: 'r-pba',
          reason: 'complete' as const,
          role: 'assistant' as const,
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(202);
      // The 202 arrived only AFTER the slow persist finished.
      expect(persisted).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(200);
    } finally {
      await conv.close();
    }
  });

  it('POST /event.turn-end — a slow chat:turn-end BROADCAST subscriber does NOT delay the 202 (TASK-66 P2a)', async () => {
    // Regression guard: the broadcast (titles/bump/clear-reqId/evictor) is
    // fire-and-forget AFTER the ack, so a slow observer (e.g. a title-LLM
    // subscriber) can't hold the runner's turn-end ack open.
    let broadcastReleased = false;
    const conv = await setupConvSession('conv-fast', 's-fast', {
      // Fast persist so only the broadcast latency is under test.
      'conversations:append-event': async () => undefined,
    });
    // Slow broadcast subscriber on the shared bus.
    const slowBus = setups[setups.length - 1]!.harness.bus;
    slowBus.subscribe('chat:turn-end', 'slow-observer', async () => {
      await new Promise<void>((r) => setTimeout(r, 250));
      broadcastReleased = true;
      return undefined;
    });
    try {
      const start = Date.now();
      const res = await doRequest(
        conv.socketPath,
        'POST',
        '/event.turn-end',
        conv.token,
        JSON.stringify({
          reqId: 'r-fast',
          reason: 'complete' as const,
          role: 'assistant' as const,
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(202);
      // The ack came back well before the slow broadcast subscriber finished.
      expect(elapsed).toBeLessThan(200);
      expect(broadcastReleased).toBe(false);
    } finally {
      await conv.close();
    }
  });

  it('POST /event.turn-end — persists the turn into the display log via conversations:append-event (TASK-66)', async () => {
    const appendCalls: unknown[] = [];
    const s = await setup({
      // Session bound to a conversation so the listener stamps ctx.conversationId.
      sessionId: 's-disp-conv',
      services: {
        'conversations:append-event': async (_ctx, input) => {
          appendCalls.push(input);
          return undefined;
        },
      },
    });
    setups.push(s);
    // Re-mint a token whose session carries a conversationId.
    const { token } = await s.harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', s.harness.ctx(), {
      sessionId: 's-disp-conv2',
      workspaceRoot: '/tmp/ws',
      owner: {
        userId: 'u-1',
        agentId: 'a-1',
        agentConfig: {
          displayName: 'Test Agent',
          systemPromptAugment: 'be helpful',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-sonnet-4-7',
          runner: 'claude-sdk',
        },
        conversationId: 'conv-66',
      },
    });
    // Point the listener's expected sessionId at the bound session by opening a
    // fresh listener — simplest is to reuse the existing one with the new token
    // only if sessionId matches; instead assert via a direct second listener.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-disp-c-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const listener = await createListener({
      socketPath,
      sessionId: 's-disp-conv2',
      bus: s.harness.bus,
    });
    try {
      const res = await doRequest(
        socketPath,
        'POST',
        '/event.turn-end',
        token,
        JSON.stringify({
          reqId: 'r1',
          reason: 'complete' as const,
          role: 'assistant' as const,
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      );
      expect(res.status).toBe(202);
      expect(appendCalls).toHaveLength(1);
      expect(appendCalls[0]).toMatchObject({
        conversationId: 'conv-66',
        kind: 'turn',
        role: 'assistant',
        payload: { blocks: [{ type: 'text', text: 'hi' }] },
      });

      // A heartbeat turn-end (no contentBlocks) does NOT persist.
      const res2 = await doRequest(
        socketPath,
        'POST',
        '/event.turn-end',
        token,
        JSON.stringify({ reqId: 'r1', reason: 'user-message-wait' as const }),
      );
      expect(res2.status).toBe(202);
      expect(appendCalls).toHaveLength(1);
    } finally {
      await listener.close();
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('POST /event.turn-end — a persist failure yields 500, NOT a false 202 (no-omission, TASK-66)', async () => {
    const s = await setup({
      sessionId: 's-disp-fail',
      services: {
        'conversations:append-event': async () => {
          throw new Error('db unavailable');
        },
      },
    });
    setups.push(s);
    const { token } = await s.harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', s.harness.ctx(), {
      sessionId: 's-disp-fail2',
      workspaceRoot: '/tmp/ws',
      owner: {
        userId: 'u-1',
        agentId: 'a-1',
        agentConfig: {
          displayName: 'Test Agent',
          systemPromptAugment: 'be helpful',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-sonnet-4-7',
          runner: 'claude-sdk',
        },
        conversationId: 'conv-fail',
      },
    });
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-disp-f-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const listener = await createListener({
      socketPath,
      sessionId: 's-disp-fail2',
      bus: s.harness.bus,
    });
    try {
      const res = await doRequest(
        socketPath,
        'POST',
        '/event.turn-end',
        token,
        JSON.stringify({
          reqId: 'r1',
          reason: 'complete' as const,
          role: 'assistant' as const,
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      );
      // The persist threw → the turn must NOT be falsely acked.
      expect(res.status).toBe(500);
    } finally {
      await listener.close();
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('POST /event.turn-end — a persist failure logs one code-only line (TASK-1059)', async () => {
    // The bus wraps a service's throw as "service hook '…' threw: <its
    // message>", and the core logger writes an Error binding's message whole.
    // A database's message can quote a host, a user or a row value, so the
    // give-up line carries codes only.
    const s = await setup({
      sessionId: 's-disp-codes',
      services: {
        'conversations:append-event': async () => {
          throw new Error('PRIVATE row text from 10.0.0.7');
        },
      },
    });
    setups.push(s);
    const { token } = await s.harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', s.harness.ctx(), {
      sessionId: 's-disp-codes2',
      workspaceRoot: '/tmp/ws',
      owner: {
        userId: 'u-1',
        agentId: 'a-1',
        agentConfig: {
          displayName: 'Test Agent',
          systemPromptAugment: 'be helpful',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-sonnet-4-7',
          runner: 'claude-sdk',
        },
        conversationId: 'conv-codes',
      },
    });
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-disp-c-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const listener = await createListener({
      socketPath,
      sessionId: 's-disp-codes2',
      bus: s.harness.bus,
    });
    const stdout = captureWrites(process.stdout);
    try {
      const res = await doRequest(
        socketPath,
        'POST',
        '/event.turn-end',
        token,
        JSON.stringify({
          reqId: 'r1',
          reason: 'complete' as const,
          role: 'assistant' as const,
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      );
      expect(res.status).toBe(500);

      // The line is written before the 500, so it is already captured here.
      const failures = parsedEntries(stdout.chunks).filter(
        (entry) => entry.msg === 'event_persist_failed',
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        level: 'error',
        hook: '/event.turn-end',
        code: 'unknown',
        name: 'PluginError',
        causeName: 'Error',
        hookName: 'conversations:append-event',
        plugin: 'mock',
      });
      expect(failures[0]).not.toHaveProperty('err');
      expect(stdout.chunks.filter((chunk) => chunk.includes('PRIVATE'))).toEqual([]);
    } finally {
      stdout.restore();
      await listener.close();
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // /event.chat-end
  // -------------------------------------------------------------------------

  it('POST /event.chat-end — fires chat:end subscriber with outcome', async () => {
    let received: unknown = null;
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'chat:end',
          handler: async (_ctx, payload) => {
            received = payload;
            resolved(payload);
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const outcome = {
      kind: 'complete' as const,
      messages: [{ role: 'user' as const, content: 'hi' }],
    };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.chat-end',
      s.token,
      JSON.stringify({ outcome }),
    );
    expect(res.status).toBe(202);
    await firePromise;
    expect(received).toEqual({ outcome });
  });

  it('POST /event.chat-end — malformed body → 400 VALIDATION', async () => {
    const s = await setup({});
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.chat-end',
      s.token,
      JSON.stringify({ outcome: { kind: 'nope' } }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('VALIDATION');
  });

  // -------------------------------------------------------------------------
  // TASK-995 — the save-refused notices are gone (TASK-731 wrote one per
  // refused workspace save). A runner from the previous release can still put
  // `saveRefused` on its turn-end or chat-end during a rolling deploy. The
  // event must still be acked and broadcast (losing a turn-end loses the turn;
  // losing a chat-end loses the reply's outcome), the field must be dropped
  // before any subscriber sees it, and nothing may be persisted for it.
  // -------------------------------------------------------------------------

  const outcome995 = { kind: 'complete' as const, messages: [] };

  it('POST /event.turn-end from an older runner still carrying saveRefused — 202, only the turn row persists, the broadcast has no saveRefused (TASK-995)', async () => {
    const appendCalls: unknown[] = [];
    const conv = await setupConvSession('conv-995a', 's-995a', {
      'conversations:append-event': async (_ctx, input) => {
        appendCalls.push(input);
        return undefined;
      },
    });
    let broadcast!: (v: unknown) => void;
    const turnEndPayload = new Promise<unknown>((r) => {
      broadcast = r;
    });
    setups[setups.length - 1]!.harness.bus.subscribe('chat:turn-end', 'probe', async (_ctx, payload) => {
      broadcast(payload);
      return undefined;
    });
    try {
      const res = await doRequest(
        conv.socketPath,
        'POST',
        '/event.turn-end',
        conv.token,
        JSON.stringify({
          reqId: 'r-995a',
          reason: 'complete' as const,
          role: 'assistant' as const,
          contentBlocks: [{ type: 'text', text: 'hi' }],
          saveRefused: 'storage-full',
        }),
      );
      expect(res.status).toBe(202);
      expect(appendCalls).toEqual([
        {
          conversationId: 'conv-995a',
          kind: 'turn',
          role: 'assistant',
          payload: { blocks: [{ type: 'text', text: 'hi' }] },
        },
      ]);
      const payload = (await turnEndPayload) as Record<string, unknown>;
      expect(payload).toMatchObject({ reqId: 'r-995a', reason: 'complete' });
      expect('saveRefused' in payload).toBe(false);
    } finally {
      await conv.close();
    }
  });

  it('POST /event.turn-end carrying only a saveRefused the old schema refused (prose) — 202 and nothing persisted (TASK-995)', async () => {
    // Before TASK-995 a non-code value was a 400 (and a code with no blocks
    // still wrote a notice row). Now the field is simply not part of the event.
    const appendCalls: unknown[] = [];
    const conv = await setupConvSession('conv-995b', 's-995b', {
      'conversations:append-event': async (_ctx, input) => {
        appendCalls.push(input);
        return undefined;
      },
    });
    try {
      const res = await doRequest(
        conv.socketPath,
        'POST',
        '/event.turn-end',
        conv.token,
        JSON.stringify({
          reason: 'user-message-wait' as const,
          saveRefused: 'Storage is full; tell the person.',
        }),
      );
      expect(res.status).toBe(202);
      expect(appendCalls).toEqual([]);
    } finally {
      await conv.close();
    }
  });

  it('POST /event.chat-end from an older runner still carrying saveRefused — 202, nothing persisted, chat:end fires with the outcome only (TASK-995)', async () => {
    const appendCalls: unknown[] = [];
    const conv = await setupConvSession('conv-995c', 's-995c', {
      'conversations:append-event': async (_ctx, input) => {
        appendCalls.push(input);
        return undefined;
      },
    });
    let ended!: (v: unknown) => void;
    const endPayload = new Promise<unknown>((r) => {
      ended = r;
    });
    setups[setups.length - 1]!.harness.bus.subscribe('chat:end', 'probe', async (_ctx, payload) => {
      ended(payload);
      return undefined;
    });
    try {
      const res = await doRequest(
        conv.socketPath,
        'POST',
        '/event.chat-end',
        conv.token,
        JSON.stringify({ outcome: outcome995, saveRefused: 'too-large' }),
      );
      expect(res.status).toBe(202);
      expect(await endPayload).toEqual({ outcome: outcome995 });
      expect(appendCalls).toEqual([]);
    } finally {
      await conv.close();
    }
  });

  // -------------------------------------------------------------------------
  // /event.stream-chunk
  // -------------------------------------------------------------------------

  it('POST /event.stream-chunk — fires chat:stream-chunk subscriber (kind=text)', async () => {
    let received: unknown = null;
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'chat:stream-chunk',
          handler: async (_ctx, payload) => {
            received = payload;
            resolved(payload);
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const body = { reqId: 'r1', text: 'hello', kind: 'text' as const };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.stream-chunk',
      s.token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await firePromise;
    // Pass-through: subscribers see the EventStreamChunkSchema shape exactly.
    expect(received).toEqual(body);
  });

  it('POST /event.stream-chunk — fires chat:stream-chunk subscriber (kind=thinking)', async () => {
    let received: unknown = null;
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const s = await setup({
      subscribers: [
        {
          hook: 'chat:stream-chunk',
          handler: async (_ctx, payload) => {
            received = payload;
            resolved(payload);
            return undefined;
          },
        },
      ],
    });
    setups.push(s);
    const body = { reqId: 'r2', text: 'pondering...', kind: 'thinking' as const };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.stream-chunk',
      s.token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await firePromise;
    expect(received).toEqual(body);
  });

  it('POST /event.stream-chunk — malformed body (missing kind) → 400 VALIDATION', async () => {
    const s = await setup({});
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/event.stream-chunk',
      s.token,
      JSON.stringify({ reqId: 'r1', text: 'hello' }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('VALIDATION');
  });

  // -------------------------------------------------------------------------
  // Unknown path
  // -------------------------------------------------------------------------

  it('POST /nope → 404 NOT_FOUND unknown path', async () => {
    const s = await setup({});
    setups.push(s);
    const res = await doRequest(s.socketPath, 'POST', '/nope', s.token, '{}');
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.message).toMatch(/unknown path/);
  });

  // -------------------------------------------------------------------------
  // Per-request AgentContext carries real workspaceRoot after auth
  // -------------------------------------------------------------------------

  it('per-request AgentContext carries workspaceRoot from auth, not listener default', async () => {
    // Register a handler that inspects ctx.workspace.rootPath via the mock
    // tool:list service hook; whichever workspace the auth result carried is
    // what the dispatcher should hand to handlers.
    let seenWorkspace: string | null = null;
    const s = await setup({
      services: {
        'tool:list': async (ctx) => {
          // @ts-expect-error ctx is typed as unknown in the services helper
          seenWorkspace = ctx.workspace.rootPath;
          return { tools: [] };
        },
      },
    });
    setups.push(s);
    // session:create in setup() used workspaceRoot '/tmp/ws' — auth must carry
    // that through to the handler's ctx.
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/tool.list',
      s.token,
      '{}',
    );
    expect(res.status).toBe(200);
    expect(seenWorkspace).toBe('/tmp/ws');
  });

  // -------------------------------------------------------------------------
  // TASK-68: blob.put (raw octet-stream REQUEST body) + content-type gate.
  // -------------------------------------------------------------------------

  /** POST a raw octet-stream body (the REQUEST-direction binary channel). */
  function doRawUpload(
    socketPath: string,
    reqPath: string,
    token: string,
    body: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': String(body.length),
      };
      const req = http.request({ socketPath, path: reqPath, method: 'POST', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      });
      req.on('error', reject);
      req.on('socket', (sock) => sock.on('error', () => {}));
      req.write(body);
      req.end();
    });
  }

  it('POST /blob.put — reads the raw octet-stream body and forwards it to blob:put', async () => {
    const VALID_SHA = 'a'.repeat(64);
    // A body LARGER than the 4 MiB JSON MAX_FRAME — proves the raw-body path
    // admits bodies the JSON reader would reject (the point of the channel).
    const body = Buffer.alloc(5 * 1024 * 1024, 0x42);
    let seenLen = -1;
    const s = await setup({
      services: {
        'blob:put': async (_ctx, input) => {
          seenLen = (input as { bytes: Uint8Array }).bytes.length;
          return { sha256: VALID_SHA, size: seenLen };
        },
      },
    });
    setups.push(s);
    const res = await doRawUpload(s.socketPath, '/blob.put', s.token, body);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sha256: VALID_SHA, size: body.length });
    expect(seenLen).toBe(body.length);
  });

  it('POST /blob.put with application/json content-type → 415 (gate requires octet-stream)', async () => {
    const s = await setup({
      services: {
        'blob:put': async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      },
    });
    setups.push(s);
    // doRequest sends application/json — the binary action requires octet-stream.
    const res = await doRequest(s.socketPath, 'POST', '/blob.put', s.token, '{}');
    expect(res.status).toBe(415);
  });

  it('POST /blob.get with octet-stream content-type → 415 (JSON action requires json)', async () => {
    const s = await setup({
      services: {
        'blob:get': async () => ({ found: false }),
      },
    });
    setups.push(s);
    const res = await doRawUpload(
      s.socketPath,
      '/blob.get',
      s.token,
      Buffer.from('{}'),
      'application/octet-stream',
    );
    expect(res.status).toBe(415);
  });

  // -------------------------------------------------------------------------
  // TASK-995 — the git workspace tier's six actions are gone. A runner from
  // the previous release can still call them during a rolling deploy. Each gets
  // the same clear 404 any unknown path gets (never a 415, a 5xx, a hang or a
  // crash), and no hook behind the old route is reached. The producers below
  // are registered on purpose: a route that still existed would call one.
  // -------------------------------------------------------------------------

  function retiredHookProbes(called: string[]): Record<
    string,
    (ctx: unknown, input: unknown) => Promise<unknown>
  > {
    const probe = (hook: string, out: unknown) => async () => {
      called.push(hook);
      return out;
    };
    return {
      'workspace:read': probe('workspace:read', { found: false }),
      'workspace:list': probe('workspace:list', { paths: [] }),
      'workspace:apply-bundle': probe('workspace:apply-bundle', {}),
      'workspace:export-baseline-bundle': probe('workspace:export-baseline-bundle', {
        bundleBytes: '',
      }),
      'conversations:drain-save-refusals': probe('conversations:drain-save-refusals', {
        refusals: [],
      }),
    };
  }

  it.each([
    ['/workspace.materialize', {}],
    ['/workspace.commit-notify', { parentVersion: null, reason: 'turn', bundleBytes: '' }],
    ['/workspace.commit-bundle', {}],
    ['/workspace.export-baseline-bundle', { version: 'v1' }],
    ['/workspace.read', { path: 'notes.md' }],
    ['/conversation.drain-save-refusals', {}],
  ])('POST %s (removed in TASK-995) → 404 NOT_FOUND unknown path, no hook reached', async (reqPath, body) => {
    const called: string[] = [];
    const s = await setup({ services: retiredHookProbes(called) });
    setups.push(s);
    const res = await doRequest(s.socketPath, 'POST', reqPath, s.token, JSON.stringify(body));
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.message).toBe(`unknown path: ${reqPath}`);
    expect(called).toEqual([]);
  });

  it('POST /workspace.commit-bundle with the octet-stream body an older runner sends → the same 404, not a 415 (TASK-995)', async () => {
    // The previous release's runner streamed its end-of-turn save as a raw
    // octet-stream body. The content-type gate keys on the routing table, so
    // a path that is no longer routed must not be judged by the rule of the
    // route it used to be: it falls through to the dispatcher's 404.
    const called: string[] = [];
    const s = await setup({ services: retiredHookProbes(called) });
    setups.push(s);
    const res = await doRawUpload(
      s.socketPath,
      '/workspace.commit-bundle?reason=turn',
      s.token,
      Buffer.from('PACK-bundle-bytes', 'utf8'),
    );
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.message).toBe('unknown path: /workspace.commit-bundle');
    expect(called).toEqual([]);
  });

  it('an unrouted path with a non-JSON content type still meets the auth gate first (TASK-995)', async () => {
    // Letting an unrouted path past the content-type gate must not let it past
    // auth: without a valid token it is a 401, exactly as for a routed path.
    const s = await setup({});
    setups.push(s);
    const res = await doRawUpload(
      s.socketPath,
      '/workspace.commit-bundle',
      'not-a-real-token',
      Buffer.from('x'),
    );
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('not-a-real-token');
  });

  // -------------------------------------------------------------------------
  // /session.append-transcript — REQUEST-direction binary channel
  //
  // Regression (PDF-read crash): a turn that Reads a large attachment inflates
  // the SDK jsonl past the 4 MiB JSON MAX_FRAME, so the per-turn delta-ship
  // must ride the raw octet-stream channel (like replace-transcript) instead
  // of the capped JSON reader. Otherwise the host rejected the append with
  // `body too large`, the runner re-threw the 4xx as fatal, and the pod died.
  // `fromSeq`/`prefixHash` travel as query params; the delta lines are the
  // raw body. conversationId is STILL resolved host-side (never trusted from
  // the wire).
  // -------------------------------------------------------------------------

  it('POST /session.append-transcript — admits a delta larger than the 4 MiB JSON cap (binary; fromSeq/prefixHash in query)', async () => {
    const PREFIX = 'a'.repeat(64);
    let forwarded: Record<string, unknown> | undefined;
    const s = await setup({
      sessionId: 's-append-big',
      services: {
        'conversations:append-transcript': async (_ctx, input) => {
          forwarded = input as Record<string, unknown>;
          return { outcome: 'appended', maxSeq: 1 };
        },
      },
    });
    setups.push(s);
    // Mint a token whose session is bound to a conversation — the handler
    // resolves conversationId host-side from session:get-config.
    const { token } = await s.harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', s.harness.ctx(), {
      sessionId: 's-append-big2',
      workspaceRoot: '/tmp/ws',
      owner: {
        userId: 'u-1',
        agentId: 'a-1',
        agentConfig: {
          displayName: 'Test Agent',
          systemPromptAugment: '',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-sonnet-4-7',
          runner: 'claude-sdk',
        },
        conversationId: 'cnv_big',
      },
    });
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-append-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const listener = await createListener({
      socketPath,
      sessionId: 's-append-big2',
      bus: s.harness.bus,
    });
    try {
      // A single jsonl line > 4 MiB — the shape a Read-of-a-PDF tool_result
      // takes (one `user` line carrying base64 image blocks).
      const bigLine = JSON.stringify({
        type: 'user',
        message: { content: 'x'.repeat(5 * 1024 * 1024) },
      });
      const body = Buffer.from(bigLine + '\n', 'utf8');
      expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
      const res = await doRawUpload(
        socketPath,
        `/session.append-transcript?fromSeq=0&prefixHash=${PREFIX}`,
        token,
        body,
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ outcome: 'appended', maxSeq: 1 });
      expect(forwarded).toEqual({
        conversationId: 'cnv_big',
        fromSeq: 0,
        prefixHash: PREFIX,
        lines: [bigLine],
      });
    } finally {
      await listener.close();
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('POST /session.append-transcript — empty-delta prefix probe (zero lines) still round-trips', async () => {
    const PREFIX = 'b'.repeat(64);
    let forwarded: Record<string, unknown> | undefined;
    const s = await setup({
      sessionId: 's-append-probe',
      services: {
        'conversations:append-transcript': async (_ctx, input) => {
          forwarded = input as Record<string, unknown>;
          return { outcome: 'appended', maxSeq: 7 };
        },
      },
    });
    setups.push(s);
    const { token } = await s.harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', s.harness.ctx(), {
      sessionId: 's-append-probe2',
      workspaceRoot: '/tmp/ws',
      owner: {
        userId: 'u-1',
        agentId: 'a-1',
        agentConfig: {
          displayName: 'Test Agent',
          systemPromptAugment: '',
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-sonnet-4-7',
          runner: 'claude-sdk',
        },
        conversationId: 'cnv_probe',
      },
    });
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-probe-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const listener = await createListener({
      socketPath,
      sessionId: 's-append-probe2',
      bus: s.harness.bus,
    });
    try {
      const res = await doRawUpload(
        socketPath,
        `/session.append-transcript?fromSeq=7&prefixHash=${PREFIX}`,
        token,
        Buffer.alloc(0),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ outcome: 'appended', maxSeq: 7 });
      expect(forwarded).toEqual({
        conversationId: 'cnv_probe',
        fromSeq: 7,
        prefixHash: PREFIX,
        lines: [],
      });
    } finally {
      await listener.close();
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

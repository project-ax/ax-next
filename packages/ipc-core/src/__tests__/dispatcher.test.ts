import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PluginError, reject } from '@ax/core';
import type {
  AgentMessage,
  LlmCallRequest,
  LlmCallResponse,
  ToolCall,
  ToolDescriptor,
} from '@ax/ipc-protocol';
import {
  createMockWorkspacePlugin,
  createTestHarness,
  type TestHarness,
} from '@ax/test-harness';
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

describe('dispatcher', () => {
  const setups: Setup[] = [];

  afterEach(async () => {
    for (const s of setups) await s.cleanup();
    setups.length = 0;
  });

  // -------------------------------------------------------------------------
  // /llm.call
  // -------------------------------------------------------------------------

  it('POST /llm.call — happy path (mock llm:call echoes response)', async () => {
    const canned: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'hello' },
      toolCalls: [],
      stopReason: 'end_turn',
    };
    const s = await setup({
      services: {
        'llm:call': async () => canned,
      },
    });
    setups.push(s);
    const req: LlmCallRequest = {
      messages: [{ role: 'user', content: 'hi' }],
    };
    const res = await doRequest(s.socketPath, 'POST', '/llm.call', s.token, JSON.stringify(req));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(canned);
  });

  it('POST /llm.call — llm:pre-call subscriber modifies the request', async () => {
    // The pre-call subscriber injects a system message; we assert the
    // mock llm:call saw the modified request.
    let seen: LlmCallRequest | null = null;
    const s = await setup({
      services: {
        'llm:call': async (_ctx, input) => {
          seen = input as LlmCallRequest;
          return {
            assistantMessage: { role: 'assistant', content: 'ok' },
            toolCalls: [],
          };
        },
      },
      subscribers: [
        {
          hook: 'llm:pre-call',
          handler: async (_ctx, payload) => {
            const req = payload as LlmCallRequest;
            return {
              ...req,
              messages: [
                { role: 'system', content: 'be brief' } as AgentMessage,
                ...req.messages,
              ],
            };
          },
        },
      ],
    });
    setups.push(s);
    const req: LlmCallRequest = { messages: [{ role: 'user', content: 'hi' }] };
    const res = await doRequest(s.socketPath, 'POST', '/llm.call', s.token, JSON.stringify(req));
    expect(res.status).toBe(200);
    expect(seen).not.toBeNull();
    expect(seen!.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(seen!.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('POST /llm.call — llm:pre-call rejection → 409 HOOK_REJECTED', async () => {
    const s = await setup({
      services: {
        'llm:call': async () => ({
          assistantMessage: { role: 'assistant', content: '' },
          toolCalls: [],
        }),
      },
      subscribers: [
        {
          hook: 'llm:pre-call',
          handler: async () => reject({ reason: 'policy veto' }),
        },
      ],
    });
    setups.push(s);
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/llm.call',
      s.token,
      JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(409);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('HOOK_REJECTED');
    expect(parsed.error.message).toContain('policy veto');
  });

  it('POST /llm.call — llm:call throws PluginError → 500 INTERNAL (sanitized)', async () => {
    // Spy on ctx.logger.error by wiring a custom stderr-less logger via the
    // harness ctx override. But we actually want to assert that the
    // sanitized message reaches the client AND the real message is logged.
    // The listener's makeAgentContext creates its own logger per-request —
    // we observe the wire response is sanitized here.
    const thrown = new PluginError({
      code: 'unknown',
      plugin: 'llm-fake',
      hookName: 'llm:call',
      message: 'upstream exploded with secret details',
    });
    const s = await setup({
      services: {
        'llm:call': async () => {
          throw thrown;
        },
      },
    });
    setups.push(s);
    // Swallow listener's unhandled-error stderr writer so test output stays clean.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Also swallow the dispatcher's structured logger (stdout JSON).
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const res = await doRequest(
          s.socketPath,
          'POST',
          '/llm.call',
          s.token,
          JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        );
        expect(res.status).toBe(500);
        const parsed = JSON.parse(res.body);
        expect(parsed.error.code).toBe('INTERNAL');
        expect(parsed.error.message).toBe('internal server error');
        // Wire response must NOT contain the upstream's detailed message.
        expect(res.body).not.toContain('secret details');
        // The logger should have recorded the detailed error at error level.
        const loggedLines = stdoutSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes('ipc_dispatch_internal_error'));
        expect(loggedLines.length).toBeGreaterThanOrEqual(1);
        // The structured log contains the real message.
        expect(loggedLines.some((l) => l.includes('secret details'))).toBe(true);
      } finally {
        stdoutSpy.mockRestore();
      }
    } finally {
      stderrSpy.mockRestore();
    }
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
  // /workspace.commit-notify
  // -------------------------------------------------------------------------

  it('POST /workspace.commit-notify — happy path through real bus + MockWorkspace', async () => {
    const s = await setup({ plugins: [createMockWorkspacePlugin()] });
    setups.push(s);
    const helloB64 = Buffer.from('hello world', 'utf8').toString('base64');
    const req = {
      parentVersion: null,
      commitRef: 'ref-1',
      message: 'initial',
      changes: [{ path: 'a.txt', kind: 'put', content: helloB64 }],
    };
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/workspace.commit-notify',
      s.token,
      JSON.stringify(req),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      accepted: true;
      version: string;
      delta: null;
    };
    expect(parsed.accepted).toBe(true);
    // Wire response NEVER carries the delta payload (Invariant I5).
    expect(parsed.delta).toBeNull();
    expect(typeof parsed.version).toBe('string');
    expect(parsed.version.length).toBeGreaterThan(0);
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
    // llm:call service hook; whichever workspace the auth result carried is
    // what the dispatcher should hand to handlers.
    let seenWorkspace: string | null = null;
    const s = await setup({
      services: {
        'llm:call': async (ctx) => {
          // @ts-expect-error ctx is typed as unknown in the services helper
          seenWorkspace = ctx.workspace.rootPath;
          return {
            assistantMessage: { role: 'assistant', content: 'ok' },
            toolCalls: [],
          };
        },
      },
    });
    setups.push(s);
    // session:create in setup() used workspaceRoot '/tmp/ws' — auth must carry
    // that through to the handler's ctx.
    const res = await doRequest(
      s.socketPath,
      'POST',
      '/llm.call',
      s.token,
      JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    expect(seenWorkspace).toBe('/tmp/ws');
  });
});

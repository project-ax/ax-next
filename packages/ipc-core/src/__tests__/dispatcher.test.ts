import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { PluginError, reject } from '@ax/core';
import type {
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
import type { Plugin } from '@ax/core';
import type {
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '@ax/workspace-bundle-protocol';
import { buildBaselineBundle } from '../handlers/workspace-materialize.js';

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

interface RawResponse {
  status: number;
  contentType: string | undefined;
  body: Buffer;
}

/** Like doRequest but preserves raw bytes + content-type (for binary responses). */
function doRequestRaw(
  socketPath: string,
  method: string,
  reqPath: string,
  token: string,
  body?: string,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body ?? '', 'utf8'));
    }
    const req = http.request({ socketPath, path: reqPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'],
          body: Buffer.concat(chunks),
        });
      });
    });
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
  // /workspace.commit-notify
  // -------------------------------------------------------------------------

  it('POST /workspace.commit-notify — empty-bundle short-circuit (Phase 3)', async () => {
    // The full bundle round-trip (verify → walk → pre-apply → apply →
    // applied) is exercised in detail by the handler-level tests at
    // packages/ipc-core/src/handlers/__tests__/workspace-commit-notify.test.ts.
    // Here we just smoke-test the dispatcher routing + schema +
    // empty-bundle short-circuit against a real socket.
    const s = await setup({ plugins: [createMockWorkspacePlugin()] });
    setups.push(s);
    const req = {
      parentVersion: 'v-existing',
      reason: 'turn',
      bundleBytes: '',
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
    expect(parsed.version).toBe('v-existing');
    expect(parsed.delta).toBeNull();
  });

  // -------------------------------------------------------------------------
  // /workspace.materialize — binary octet-stream response (BUG-W3)
  // -------------------------------------------------------------------------

  it('POST /workspace.materialize — streams a raw git-bundle octet-stream body', async () => {
    // BUG-W3: the materialize response is no longer JSON {bundleBytes:<base64>}.
    // The dispatcher writes the raw bundle bytes with Content-Type
    // application/octet-stream so the runner can stream it straight to disk
    // (bypassing the 4 MiB JSON response cap that crashed the runner on an aged
    // workspace). Here we assert the dispatcher's binary write path end-to-end
    // over a real socket: octet-stream content-type + a real git-bundle body
    // (the bundle magic header), NOT a JSON envelope.
    const s = await setup({ plugins: [createMockWorkspacePlugin()] });
    setups.push(s);
    const res = await doRequestRaw(
      s.socketPath,
      'POST',
      '/workspace.materialize',
      s.token,
      '{}',
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('application/octet-stream');
    expect(res.body.length).toBeGreaterThan(0);
    // A git bundle starts with the `# v2 git bundle` / `# v3 git bundle` magic.
    const head = res.body.toString('utf8', 0, 16);
    expect(head).toMatch(/^# v\d git bundle/);
    // It is NOT a JSON envelope.
    expect(() => JSON.parse(res.body.toString('utf8'))).toThrow();
  });

  // -------------------------------------------------------------------------
  // /workspace.export-baseline-bundle — binary octet-stream response (the
  // commit-notify re-sync fetch; same bug class as materialize BUG-W3)
  // -------------------------------------------------------------------------

  it('POST /workspace.export-baseline-bundle — streams a raw git-bundle octet-stream body', async () => {
    // The re-sync baseline bundle rides the binary octet-stream body (NOT a
    // base64-in-JSON field that blew the runner's 4 MiB response cap). Drive
    // the dispatcher's binary write path end-to-end over a real socket with a
    // backend that produces a real bundle for the requested version.
    const bundleB64 = await buildBaselineBundle({
      paths: ['.ax/CLAUDE.md'],
      read: async () => Buffer.from('# memory at the advanced head'),
    });
    const probe: Plugin = {
      manifest: {
        name: '@ax/test-dispatcher-ebb-backend',
        version: '0.0.0',
        registers: ['workspace:export-baseline-bundle'],
        calls: [],
        subscribes: [],
      },
      init({ bus }) {
        bus.registerService<
          WorkspaceExportBaselineBundleInput,
          WorkspaceExportBaselineBundleOutput
        >(
          'workspace:export-baseline-bundle',
          '@ax/test-dispatcher-ebb-backend',
          async () => ({ bundleBytes: bundleB64 }),
        );
      },
    };
    const s = await setup({ plugins: [probe] });
    setups.push(s);
    const res = await doRequestRaw(
      s.socketPath,
      'POST',
      '/workspace.export-baseline-bundle',
      s.token,
      JSON.stringify({ version: 'newhead' }),
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('application/octet-stream');
    expect(res.body.length).toBeGreaterThan(0);
    const head = res.body.toString('utf8', 0, 16);
    expect(head).toMatch(/^# v\d git bundle/);
    expect(() => JSON.parse(res.body.toString('utf8'))).toThrow();
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
          model: 'claude-sonnet-4-7',
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
          model: 'claude-sonnet-4-7',
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
          model: 'claude-sonnet-4-7',
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
          model: 'claude-sonnet-4-7',
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
          model: 'claude-sonnet-4-7',
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

import * as http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import {
  isOwnerlessId,
  ownerlessIdFor,
  type AgentContext,
  type AgentContextAudience,
  type AgentContextSource,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  AgentConfig,
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createHttpListener, type HttpListener } from '../listener.js';

// ---------------------------------------------------------------------------
// Regression: per-request AgentContext for the HTTP listener carries
// auth-resolved userId / agentId / conversationId — not hardcoded
// 'ipc-http' placeholders.
//
// Symptom this guards against (k8s e2e Bug 1, runner-owned-sessions-k8s-gap.
// test.ts:156): runner POSTed /conversation.store-runner-session, the
// handler dispatched bus.call('conversations:store-runner-session', ctx,
// ...), but ctx.userId was the string literal 'ipc-http'. The store does
// a userId-scoped UPDATE WHERE user_id = ctx.userId — so it never
// matched the real owner row → 404 not-found → runner threw → second
// turn lost the transcript.
//
// The Unix-socket sibling (@ax/ipc-server) was fixed in PR #18 final
// review (Week 10–12). The k8s preset runs over @ax/ipc-http (TCP), and
// the auth-stamping fix didn't propagate. This test pins the parity.
// ---------------------------------------------------------------------------

const OWNER: { userId: string; agentId: string; agentConfig: AgentConfig } = {
  userId: 'u-http-prop',
  agentId: 'a-http-prop',
  agentConfig: {
    displayName: 'Test Agent',
    systemPromptAugment: 'be helpful',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'anthropic/claude-sonnet-4-7',
    runner: 'claude-sdk',
  },
};

interface Harness {
  listener: HttpListener;
  port: number;
  token: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(opts: {
  sessionId: string;
  conversationId: string | null;
  onTurnEnd: (ctx: AgentContext, payload: unknown) => void;
}): Promise<Harness> {
  const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
  h.bus.subscribe(
    'chat:turn-end',
    'mock-observer',
    async (ctx, payload) => {
      opts.onTurnEnd(ctx, payload);
      return undefined;
    },
  );
  const ctx = h.ctx();
  const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    ctx,
    {
      sessionId: opts.sessionId,
      workspaceRoot: '/tmp/ws',
      owner: { ...OWNER, conversationId: opts.conversationId },
    },
  );
  const listener = await createHttpListener({
    host: '127.0.0.1',
    port: 0,
    bus: h.bus,
  });
  return {
    listener,
    port: listener.port,
    token,
    cleanup: async () => {
      await listener.close();
    },
  };
}

interface Response {
  status: number;
  body: string;
}

function postJson(
  port: number,
  path: string,
  token: string,
  body: string,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const buf = Buffer.from(body, 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(buf.length),
          Authorization: `Bearer ${token}`,
        },
      },
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
    req.write(buf);
    req.end();
  });
}

describe('@ax/ipc-http: auth-resolved ids propagate onto per-request ctx', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const h of harnesses) await h.cleanup();
    harnesses.length = 0;
  });

  it('stamps userId, agentId, and conversationId from auth onto ctx (full owner)', async () => {
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const h = await makeHarness({
      sessionId: 's-http-prop',
      conversationId: 'cnv_http_prop',
      onTurnEnd: (ctx) => {
        capturedCtx = ctx;
        resolveFire?.();
      },
    });
    harnesses.push(h);

    const body = {
      reqId: 'req-http-prop-1',
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    };
    const res = await postJson(
      h.port,
      '/event.turn-end',
      h.token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    const ctx = capturedCtx as AgentContext | null;
    // The whole point: per-request ctx must carry the resolved session's
    // userId/agentId/conversationId — not the 'ipc-http' placeholder
    // strings the listener used to hardcode.
    expect(ctx?.userId).toBe('u-http-prop');
    expect(ctx?.agentId).toBe('a-http-prop');
    expect(ctx?.conversationId).toBe('cnv_http_prop');
    expect(ctx?.sessionId).toBe('s-http-prop');
  });

  it('falls back to an OWNER-LESS marker when session has no owner (canary path)', async () => {
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    // Owner-less session: simulates the pre-9.5 / canary path where
    // session:resolve-token returns userId/agentId=null. The listener
    // must still build a valid ctx (userId/agentId are non-empty in
    // AgentContext) by substituting a stand-in. TASK-411 changed WHAT it
    // substitutes: the constant 'ipc-http' pooled every owner-less session
    // in the deployment into one agent-keyed partition. It is now
    // ownerlessIdFor(sessionId) — per-session and marked. See
    // ownerless-tenant-isolation.test.ts for the isolation assertions.
    const harness = await createTestHarness({
      plugins: [createSessionInmemoryPlugin()],
    });
    harness.bus.subscribe(
      'chat:turn-end',
      'mock-observer-canary',
      async (ctx) => {
        capturedCtx = ctx;
        resolveFire?.();
        return undefined;
      },
    );
    const ctx = harness.ctx();
    const { token } = await harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', ctx, {
      sessionId: 's-http-canary',
      workspaceRoot: '/tmp/ws',
      // no owner — canary
    });
    const listener = await createHttpListener({
      host: '127.0.0.1',
      port: 0,
      bus: harness.bus,
    });
    harnesses.push({
      listener,
      port: listener.port,
      token,
      cleanup: async () => {
        // Close listener before harness so the listener stops handling
        // requests against a torn-down bus. Harness close drains
        // plugin-held resources (session-inmemory's interval timers,
        // etc.) so test isolation holds across afterEach.
        await listener.close();
        await harness.close({ onError: () => {} });
      },
    });

    const body = {
      reqId: 'req-http-canary-1',
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'canary' }],
    };
    const res = await postJson(
      listener.port,
      '/event.turn-end',
      token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    const got = capturedCtx as AgentContext | null;
    // Canary sessions: userId/agentId fall back to the owner-less stand-in,
    // and conversationId is left off entirely (not stamped as null).
    expect(got?.userId).toBe(ownerlessIdFor('s-http-canary'));
    expect(got?.agentId).toBe(ownerlessIdFor('s-http-canary'));
    expect(isOwnerlessId(got?.agentId as string)).toBe(true);
    expect(got?.conversationId).toBeUndefined();
  });

  it('stamps host-derived source onto ctx for the happy-path chat:end (TASK-181, k8s/TCP transport)', async () => {
    // The k8s sandbox backend reaches the host over THIS TCP listener, so the
    // runner-completed chat:end for a k8s session lands here. A routine-opened
    // session must surface ctx.source='routine' so @ax/memory can store a
    // successful k8s routine turn's rows with no conversation (TASK-616) —
    // same property @ax/ipc-server provides for
    // the subprocess (unix-socket) transport.
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const harness = await createTestHarness({
      plugins: [createSessionInmemoryPlugin()],
    });
    harness.bus.subscribe('chat:end', 'mock-chat-end', async (ctx) => {
      capturedCtx = ctx;
      resolveFire?.();
      return undefined;
    });
    const ctx = harness.ctx();
    const { token } = await harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', ctx, {
      sessionId: 's-http-routine',
      workspaceRoot: '/tmp/ws',
      // Host stamps the origin at create-time (orchestrator forwards ctx.source).
      owner: { ...OWNER, source: 'routine' },
    });
    const listener = await createHttpListener({
      host: '127.0.0.1',
      port: 0,
      bus: harness.bus,
    });
    harnesses.push({
      listener,
      port: listener.port,
      token,
      cleanup: async () => {
        await listener.close();
        await harness.close({ onError: () => {} });
      },
    });

    // A runner that ALSO smuggles a forged source in the body must not flip ctx:
    // the listener derives source only from the session record, never the frame.
    const body = {
      outcome: { kind: 'complete', messages: [{ role: 'assistant', content: 'done' }] },
      source: 'user',
    };
    const res = await postJson(
      listener.port,
      '/event.chat-end',
      token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    const got = capturedCtx as AgentContext | null;
    expect(got?.source).toBe('routine');
    expect(got?.sessionId).toBe('s-http-routine');
  });

  // -------------------------------------------------------------------------
  // TASK-1091 — `'external'` and `audience` ride the same host-only chain on
  // the k8s (TCP) transport. A shared session's runner-side tool calls run on
  // this rebuilt ctx, so a lost `audience` would make them recall as private.
  // -------------------------------------------------------------------------

  /** Mints a session stamped as given, POSTs a chat-end body, returns the ctx. */
  async function chatEndCtx(
    opts: { sessionId: string; source?: AgentContextSource; audience?: AgentContextAudience },
    body: Record<string, unknown>,
  ): Promise<AgentContext> {
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const harness = await createTestHarness({
      plugins: [createSessionInmemoryPlugin()],
    });
    harness.bus.subscribe('chat:end', 'mock-chat-end', async (ctx) => {
      capturedCtx = ctx;
      resolveFire?.();
      return undefined;
    });
    const { token } = await harness.bus.call<
      SessionCreateInput,
      SessionCreateOutput
    >('session:create', harness.ctx(), {
      sessionId: opts.sessionId,
      workspaceRoot: '/tmp/ws',
      owner: {
        ...OWNER,
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      },
    });
    const listener = await createHttpListener({
      host: '127.0.0.1',
      port: 0,
      bus: harness.bus,
    });
    harnesses.push({
      listener,
      port: listener.port,
      token,
      cleanup: async () => {
        await listener.close();
        await harness.close({ onError: () => {} });
      },
    });
    const res = await postJson(listener.port, '/event.chat-end', token, JSON.stringify(body));
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    return capturedCtx as unknown as AgentContext;
  }

  const COMPLETE_CHAT_END = {
    outcome: { kind: 'complete', messages: [{ role: 'assistant', content: 'done' }] },
  };

  it('stamps source "external" and audience "shared" onto ctx for the happy-path runner-completed chat:end', async () => {
    const ctx = await chatEndCtx(
      { sessionId: 's-http-external', source: 'external', audience: 'shared' },
      COMPLETE_CHAT_END,
    );
    expect(ctx.source).toBe('external');
    expect(ctx.audience).toBe('shared');
    expect(ctx.sessionId).toBe('s-http-external');
  });

  it('leaves ctx.audience absent for a session created without one', async () => {
    const ctx = await chatEndCtx({ sessionId: 's-http-aud-absent' }, COMPLETE_CHAT_END);
    // Absent, not `undefined`: a private turn behaves exactly as before.
    expect('audience' in ctx).toBe(false);
    expect('source' in ctx).toBe(false);
  });

  it('SECURITY: a runner cannot forge source or audience via the chat-end frame', async () => {
    // Host-stamped external + shared. The runner claims the owner's private
    // mode in the body; the listener reads only the session record.
    const ctx = await chatEndCtx(
      { sessionId: 's-http-aud-forge', source: 'external', audience: 'shared' },
      {
        ...COMPLETE_CHAT_END,
        source: 'user',
        audience: 'private',
        owner: { source: 'user', audience: 'private' },
      },
    );
    expect(ctx.source).toBe('external');
    expect(ctx.audience).toBe('shared');
  });
});

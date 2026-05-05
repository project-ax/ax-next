import * as http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import type { AgentContext } from '@ax/core';
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
    systemPrompt: 'be helpful',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude-sonnet-4-7',
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

  it('falls back to ipc-http placeholder when session has no owner (canary path)', async () => {
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    // Owner-less session: simulates the pre-9.5 / canary path where
    // session:resolve-token returns userId/agentId=null. The listener
    // must still build a valid ctx (userId/agentId are non-empty in
    // AgentContext) by substituting the 'ipc-http' placeholder.
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
        await listener.close();
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
    // Canary sessions: userId/agentId fall back to placeholder, and
    // conversationId is left off entirely (not stamped as null).
    expect(got?.userId).toBe('ipc-http');
    expect(got?.agentId).toBe('ipc-http');
    expect(got?.conversationId).toBeUndefined();
  });
});

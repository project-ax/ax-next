import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { AgentContext } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  AgentConfig,
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createListener, type Listener } from '../listener.js';

// ---------------------------------------------------------------------------
// Regression test: conversationId propagation through session-token resolution
// (final review of PR #18, Week 10–12).
//
// Bug: when the runner emitted event.turn-end over IPC, the listener built a
// fresh AgentContext from the auth result — but the auth result didn't carry
// `conversationId`, so the resulting `chat:turn-end` bus fire had
// `ctx.conversationId === undefined`. That silently broke three subscribers:
//
//   1. @ax/conversations auto-append (assistant turns never persisted)
//   2. @ax/conversations clearActiveReqId (active_req_id stayed stale)
//   3. SSE per-connection turn-end subscriber (browser only learned the
//      stream was done via socket-close, not a clean done frame)
//
// The session record HAS the conversationId (Task 15 schema) — it just
// wasn't flowing through. This test fires POST /event.turn-end through the
// real listener with a session bound to a known conversationId and asserts
// the bus subscriber sees ctx.conversationId === that-id.
// ---------------------------------------------------------------------------

const OWNER: { userId: string; agentId: string; agentConfig: AgentConfig } = {
  userId: 'u-conv',
  agentId: 'a-conv',
  agentConfig: {
    systemPrompt: 'be helpful',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude-sonnet-4-7',
  },
};

interface Harness {
  listener: Listener;
  token: string;
  socketPath: string;
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
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-conv-prop-'));
  const socketPath = path.join(tempDir, 'ipc.sock');
  const listener = await createListener({
    socketPath,
    sessionId: opts.sessionId,
    bus: h.bus,
  });
  return {
    listener,
    token,
    socketPath,
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

function postJson(
  socketPath: string,
  reqPath: string,
  token: string,
  body: string,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const buf = Buffer.from(body, 'utf8');
    const req = http.request(
      {
        socketPath,
        path: reqPath,
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

describe('@ax/ipc-server: conversationId propagation through token resolution', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const h of harnesses) await h.cleanup();
    harnesses.length = 0;
  });

  it('propagates session.conversationId onto ctx for chat:turn-end fires', async () => {
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const h = await makeHarness({
      sessionId: 's-conv-prop',
      conversationId: 'cnv_test_prop',
      onTurnEnd: (ctx) => {
        capturedCtx = ctx;
        resolveFire?.();
      },
    });
    harnesses.push(h);

    const body = {
      reqId: 'req-prop-1',
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    };
    const res = await postJson(
      h.socketPath,
      '/event.turn-end',
      h.token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    // The whole point: the per-connection ctx the bus subscriber sees must
    // carry the session's conversationId, not undefined.
    expect((capturedCtx as AgentContext | null)?.conversationId).toBe(
      'cnv_test_prop',
    );
    expect((capturedCtx as AgentContext | null)?.sessionId).toBe('s-conv-prop');
  });

  it('leaves ctx.conversationId undefined when the session has no conversation (canary)', async () => {
    // The other half of the contract — a session minted WITHOUT a
    // conversationId still works; subscribers correctly skip the
    // persistence path for canary / admin probes.
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const h = await makeHarness({
      sessionId: 's-conv-canary',
      conversationId: null,
      onTurnEnd: (ctx) => {
        capturedCtx = ctx;
        resolveFire?.();
      },
    });
    harnesses.push(h);

    const body = {
      reqId: 'req-canary-1',
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'canary' }],
    };
    const res = await postJson(
      h.socketPath,
      '/event.turn-end',
      h.token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    expect((capturedCtx as AgentContext | null)?.conversationId).toBeUndefined();
  });
});

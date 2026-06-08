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
// Regression test: AgentContext.source propagation through session-token
// resolution (TASK-181, prerequisite for the skill-crystallization epic).
//
// Bug this guards: the happy-path runner-COMPLETED chat:end is fired by the
// IPC server (listener.ts) from a fresh AgentContext rebuilt off the auth
// result. Before TASK-181 the auth result didn't carry `source`, so that
// chat:end had `ctx.source === undefined` even for a session a routine fire
// opened. @ax/memory-strata's routine-fire guard (`ctx.source === 'routine'`
// → skip observer + consolidator) therefore fired on the orchestrator's
// synthesized error/terminated chat:end and in unit tests, but NEVER on a
// successful turn → a scheduled fire (e.g. the future skill-reflection
// routine) would pollute its own agent's memory and reflect on its own
// reflection turns.
//
// The session record HAS the host-derived `source` (set at session:create
// from the orchestrator's ctx.source) — it just wasn't flowing through token
// resolution. This test mints sessions with a known `source`, POSTs
// /event.chat-end through the REAL listener, and asserts the bus subscriber
// sees the matching ctx.source.
//
// SECURITY (load-bearing): `source` MUST come only from the session record,
// never from a runner-supplied frame field. The final test asserts a runner
// that smuggles `source: 'routine'` into the chat-end body for a session the
// host minted as a USER session CANNOT flip ctx.source — proving an untrusted
// runner can't forge the memory-suppression signal.
// ---------------------------------------------------------------------------

const OWNER: { userId: string; agentId: string; agentConfig: AgentConfig } = {
  userId: 'u-src',
  agentId: 'a-src',
  agentConfig: {
    displayName: 'Test Agent',
    systemPromptAugment: 'be helpful',
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
  source: 'routine' | 'user' | undefined;
  onChatEnd: (ctx: AgentContext, payload: unknown) => void;
}): Promise<Harness> {
  const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
  h.bus.subscribe(
    'chat:end',
    'mock-observer',
    async (ctx, payload) => {
      opts.onChatEnd(ctx, payload);
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
      // The host stamps source on the owner at create-time (the orchestrator
      // forwards ctx.source). Undefined = a user turn (key left off).
      owner: {
        ...OWNER,
        ...(opts.source !== undefined ? { source: opts.source } : {}),
      },
    },
  );
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-src-prop-'));
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

const HAPPY_PATH_CHAT_END = {
  outcome: { kind: 'complete', messages: [{ role: 'assistant', content: 'done' }] },
};

describe('@ax/ipc-server: AgentContext.source propagation through token resolution', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const h of harnesses) await h.cleanup();
    harnesses.length = 0;
  });

  it('stamps source="routine" onto ctx for the happy-path runner-completed chat:end', async () => {
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const h = await makeHarness({
      sessionId: 's-src-routine',
      source: 'routine',
      onChatEnd: (ctx) => {
        capturedCtx = ctx;
        resolveFire?.();
      },
    });
    harnesses.push(h);

    const res = await postJson(
      h.socketPath,
      '/event.chat-end',
      h.token,
      JSON.stringify(HAPPY_PATH_CHAT_END),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    // The whole point: the per-connection ctx the chat:end subscriber sees must
    // carry the session's host-derived source, so @ax/memory-strata's guard
    // fires on a SUCCESSFUL turn (not just error/terminated/unit paths).
    expect((capturedCtx as AgentContext | null)?.source).toBe('routine');
    expect((capturedCtx as AgentContext | null)?.sessionId).toBe('s-src-routine');
  });

  it('leaves ctx.source undefined for a user session (memory runs normally)', async () => {
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const h = await makeHarness({
      sessionId: 's-src-user',
      source: undefined, // a user turn leaves source unset
      onChatEnd: (ctx) => {
        capturedCtx = ctx;
        resolveFire?.();
      },
    });
    harnesses.push(h);

    const res = await postJson(
      h.socketPath,
      '/event.chat-end',
      h.token,
      JSON.stringify(HAPPY_PATH_CHAT_END),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    // unset (or 'user') → memory-strata's guard does NOT fire; memory runs.
    expect((capturedCtx as AgentContext | null)?.source).toBeUndefined();
  });

  it('SECURITY: an untrusted runner CANNOT forge source via the chat-end frame', async () => {
    // The host minted this as a USER session. A malicious/compromised runner
    // POSTs a chat-end body with `source: 'routine'` smuggled in, trying to
    // suppress its own memory extraction. The listener derives source ONLY
    // from the session record (via token resolution), never from the inbound
    // payload — so ctx.source must stay undefined and memory still runs.
    let capturedCtx: AgentContext | null = null;
    let resolveFire: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });
    const h = await makeHarness({
      sessionId: 's-src-forge',
      source: undefined, // host knows this is a user session
      onChatEnd: (ctx) => {
        capturedCtx = ctx;
        resolveFire?.();
      },
    });
    harnesses.push(h);

    // Forged frame: a runner-controlled `source` field riding alongside the
    // legitimate outcome. (`source` is deliberately absent from
    // @ax/ipc-protocol's EventChatEndSchema, so it's stripped at validation —
    // and even if it weren't, the handler never reads it.)
    const forgedBody = {
      ...HAPPY_PATH_CHAT_END,
      source: 'routine',
      owner: { source: 'routine' },
    };
    const res = await postJson(
      h.socketPath,
      '/event.chat-end',
      h.token,
      JSON.stringify(forgedBody),
    );
    expect(res.status).toBe(202);
    await fired;
    expect(capturedCtx).not.toBeNull();
    // The forged routine source did NOT take — the host's known user origin wins.
    expect((capturedCtx as AgentContext | null)?.source).toBeUndefined();
  });
});

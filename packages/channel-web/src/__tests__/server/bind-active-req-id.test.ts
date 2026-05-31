// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  PluginError,
  type AgentContext,
} from '@ax/core';
import { bindActiveReqIdAuthoritative } from '../../server/routes-chat';

// ---------------------------------------------------------------------------
// TASK-89 — the early bind of `active_req_id` is AUTHORITATIVE: it retries
// within a small budget, then signals failure (caller 503s the POST) rather
// than letting a reqId through whose `GET /api/chat/stream/:reqId` can never
// 200. These unit tests drive the helper against a real HookBus with a
// programmable `conversations:bind-session` so we can control fail-then-
// succeed / always-fail deterministically (the live-container route harness
// boots the REAL conversations plugin, which always binds first try — so the
// transient/never-establishes cases live here).
//
// Real timers: the whole budget is BIND_TOTAL_BUDGET_MS (400ms), so even the
// worst case (always-fail) returns well under a second.
// ---------------------------------------------------------------------------

const BIND = {
  conversationId: 'conv-1',
  sessionId: 'sess-1',
  reqId: 'req-abc',
};

function ctx(): AgentContext {
  return makeAgentContext({
    sessionId: 'sess-1',
    agentId: 'agt-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    reqId: 'req-abc',
  });
}

/** A HookBus with a `conversations:bind-session` whose handler is `impl`. */
function busWithBind(
  impl: (calls: number) => Promise<void>,
): { bus: HookBus; calls: () => number } {
  const bus = new HookBus();
  let n = 0;
  bus.registerService(
    'conversations:bind-session',
    'mock-conversations',
    async () => {
      n += 1;
      await impl(n);
    },
  );
  return { bus, calls: () => n };
}

describe('bindActiveReqIdAuthoritative (TASK-89)', () => {
  it('happy path: binds on the FIRST try → true, exactly one bind call', async () => {
    const { bus, calls } = busWithBind(async () => {
      // success
    });
    const ok = await bindActiveReqIdAuthoritative(bus, ctx(), BIND);
    expect(ok).toBe(true);
    expect(calls()).toBe(1);
  });

  it('transient-then-recovers: throws on first calls, succeeds within budget → true, 202-equivalent', async () => {
    // Fail the first two attempts (transient — e.g. read-after-write replica
    // lag right after the row was created/fetched in the same request), then
    // succeed. The helper must keep retrying within the budget and end true.
    const { bus, calls } = busWithBind(async (call) => {
      if (call < 3) {
        throw new PluginError({
          code: 'not-found',
          plugin: 'mock-conversations',
          hookName: 'conversations:bind-session',
          message: 'transient: row not visible yet',
        });
      }
      // 3rd call succeeds.
    });
    const ok = await bindActiveReqIdAuthoritative(bus, ctx(), BIND);
    expect(ok).toBe(true);
    expect(calls()).toBe(3);
  });

  it('never-establishes: the bind always throws → false within the budget (caller 503s)', async () => {
    const start = Date.now();
    const { bus, calls } = busWithBind(async () => {
      throw new PluginError({
        code: 'not-found',
        plugin: 'mock-conversations',
        hookName: 'conversations:bind-session',
        message: 'row genuinely absent',
      });
    });
    const ok = await bindActiveReqIdAuthoritative(bus, ctx(), BIND);
    expect(ok).toBe(false);
    // It retried more than once (bounded retry, not single best-effort)…
    expect(calls()).toBeGreaterThan(1);
    // …and it stayed bounded — well under a wall-second.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('service absent: hasService=false → false immediately, no call attempted', async () => {
    const bus = new HookBus(); // no conversations:bind-session registered
    const ok = await bindActiveReqIdAuthoritative(bus, ctx(), BIND);
    expect(ok).toBe(false);
  });

  it('passes through the conversationId / sessionId / reqId to the bind hook', async () => {
    const bus = new HookBus();
    let seen: unknown;
    bus.registerService(
      'conversations:bind-session',
      'mock-conversations',
      async (_c, input: unknown) => {
        seen = input;
      },
    );
    const ok = await bindActiveReqIdAuthoritative(bus, ctx(), BIND);
    expect(ok).toBe(true);
    expect(seen).toEqual({
      conversationId: 'conv-1',
      sessionId: 'sess-1',
      reqId: 'req-abc',
    });
  });
});

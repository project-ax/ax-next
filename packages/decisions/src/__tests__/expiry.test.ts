/**
 * `expiry.ts` — hermetic tests.
 *
 * No Postgres: a real `HookBus` from `@ax/core`, `createFakeStore()` for the
 * `DecisionStore`. The store's own conditional-update contract is covered
 * against real Postgres in `store.test.ts`; this file is about what
 * `sweepExpired`/`runDueReplays` decide to touch and how many times.
 */
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type ToolCall } from '@ax/core';
import { runDueReplays, sweepExpired } from '../expiry.js';
import type { Decision } from '../types.js';
import { createFakeStore } from './fake-store.js';

const NOW = new Date('2026-08-20T09:00:00.000Z');
const ONE_SEC = 1000;

const CALL: ToolCall = {
  id: 'call-1',
  name: 'request_capability',
  input: { reason: 'I need the Linear key' },
};

function base(over: Partial<Decision> = {}): Decision {
  return {
    id: 'dec_1',
    agentId: 'agent-1',
    ownerUserId: 'owner-1',
    conversationId: 'conv-1',
    kind: 'action',
    attendance: 'unattended',
    status: 'pending',
    call: CALL,
    callFingerprint: 'fp-1',
    ruleId: 'skills.request-capability',
    irreversible: true,
    freshness: null,
    summary: 'Wants to gain access to a new service or key',
    detail: 'It stopped before running request_capability.',
    preview: null,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No — I'll handle it",
    approvedText: 'You said yes, so it may gain access to a new service or key.',
    dismissedText: 'You turned this down. Nothing ran.',
    createdAt: '2026-08-18T09:00:00.000Z',
    expiresAt: '2026-08-22T09:00:00.000Z',
    resolvedAt: null,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayError: null,
    ...over,
  };
}

const logCtx = makeAgentContext({
  sessionId: 'sweep-session',
  agentId: 'sweep',
  userId: 'sweep',
});

describe('sweepExpired', () => {
  it('moves a row one second past expiresAt, leaves one a second short, and never touches a resolved row', async () => {
    const store = createFakeStore();

    const past = base({
      id: 'dec_past',
      status: 'pending',
      expiresAt: new Date(NOW.getTime() - ONE_SEC).toISOString(),
    });
    const notYet = base({
      id: 'dec_not_yet',
      status: 'pending',
      expiresAt: new Date(NOW.getTime() + ONE_SEC).toISOString(),
    });
    const resolved = base({
      id: 'dec_resolved',
      status: 'dismissed',
      expiresAt: new Date(NOW.getTime() - 10 * ONE_SEC).toISOString(),
      resolvedAt: new Date(NOW.getTime() - 20 * ONE_SEC).toISOString(),
    });
    store.rows.set(past.id, past);
    store.rows.set(notYet.id, notYet);
    store.rows.set(resolved.id, resolved);

    const moved = await sweepExpired(store, NOW);

    expect(moved).toBe(1);
    expect(store.rows.get('dec_past')!.status).toBe('expired');
    expect(store.rows.get('dec_not_yet')!.status).toBe('pending');
    expect(store.rows.get('dec_resolved')!.status).toBe('dismissed');
  });
});

describe('runDueReplays', () => {
  it('claims a due row, replays it through the registered executor, and returns 1', async () => {
    const bus = new HookBus();
    const received: unknown[] = [];
    bus.registerService('tool:execute:request_capability', 'test', async (_ctx, input) => {
      received.push(input);
      return { ok: true };
    });
    const store = createFakeStore();
    const due = base({
      id: 'dec_due',
      status: 'executed',
      replayDueAt: new Date(NOW.getTime() - ONE_SEC).toISOString(),
    });
    store.rows.set(due.id, due);

    const ran = await runDueReplays({ store, bus, now: NOW, logCtx });

    expect(ran).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(due.call);
    expect(store.rows.get('dec_due')!.status).toBe('executed');
    expect(store.rows.get('dec_due')!.replayDueAt).toBeNull();
  });

  it('does not pick up a row whose replayDueAt is still in the future', async () => {
    const bus = new HookBus();
    let calls = 0;
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      calls += 1;
      return {};
    });
    const store = createFakeStore();
    const notYet = base({
      id: 'dec_future',
      status: 'executed',
      replayDueAt: new Date(NOW.getTime() + ONE_SEC).toISOString(),
    });
    store.rows.set(notYet.id, notYet);

    const ran = await runDueReplays({ store, bus, now: NOW, logCtx });

    expect(ran).toBe(0);
    expect(calls).toBe(0);
    expect(store.rows.get('dec_future')!.replayDueAt).not.toBeNull();
  });

  it('is one-shot: calling it twice in a row executes the tool exactly once', async () => {
    const bus = new HookBus();
    let calls = 0;
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      calls += 1;
      return {};
    });
    const store = createFakeStore();
    const due = base({
      id: 'dec_due',
      status: 'executed',
      replayDueAt: new Date(NOW.getTime() - ONE_SEC).toISOString(),
    });
    store.rows.set(due.id, due);

    const first = await runDueReplays({ store, bus, now: NOW, logCtx });
    const second = await runDueReplays({ store, bus, now: NOW, logCtx });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(calls).toBe(1);
  });

  it('honours limit', async () => {
    const bus = new HookBus();
    let calls = 0;
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      calls += 1;
      return {};
    });
    const store = createFakeStore();
    for (const id of ['dec_a', 'dec_b', 'dec_c']) {
      store.rows.set(
        id,
        base({
          id,
          status: 'executed',
          replayDueAt: new Date(NOW.getTime() - ONE_SEC).toISOString(),
        }),
      );
    }

    const ran = await runDueReplays({ store, bus, now: NOW, limit: 2, logCtx });

    expect(ran).toBe(2);
    expect(calls).toBe(2);
  });

  it('returns 0 and calls nothing when there is nothing due', async () => {
    const bus = new HookBus();
    let calls = 0;
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      calls += 1;
      return {};
    });
    const store = createFakeStore();

    const ran = await runDueReplays({ store, bus, now: NOW, logCtx });

    expect(ran).toBe(0);
    expect(calls).toBe(0);
  });
});

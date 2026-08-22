/**
 * `replay.ts` — hermetic tests.
 *
 * No Postgres here: `HookBus` from `@ax/core` is real, `DecisionStore` is the
 * in-memory `createFakeStore()` used by the pre-call gate's own tests. The
 * store's OWN contract (conditional updates, the partial unique index) is
 * covered against real Postgres in `store.test.ts`; this file is about
 * `replay.ts`'s own logic: what it calls, what it never calls, and what it
 * writes when things go wrong.
 */
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext, type ToolCall } from '@ax/core';
import { emitExecuted, replayContext, replayOnApprove, settleReplay } from '../replay.js';
import { FAILED_RECEIPT, PENDING_AGENT_RECEIPT } from '../templates.js';
import type { Decision, DecisionExecutedPayload } from '../types.js';
import { createFakeStore } from './fake-store.js';

const T0 = '2026-08-20T09:00:00.000Z';
const EXPIRES = '2026-08-22T09:00:00.000Z';

const CALL: ToolCall = {
  id: 'call-1',
  name: 'request_capability',
  // Nested, so a re-serialisation on the way through would show up in a
  // `toEqual` comparison.
  input: { reason: 'I need the Linear key', nested: { b: 2, a: [1, 2] } },
};

function base(over: Partial<Decision> = {}): Decision {
  return {
    id: 'dec_1',
    agentId: 'agent-1',
    ownerUserId: 'owner-1',
    conversationId: 'conv-1',
    kind: 'action',
    attendance: 'unattended',
    status: 'executed',
    call: CALL,
    callFingerprint: 'fp-1',
    ruleId: 'skills.request-capability',
    irreversible: false,
    freshness: null,
    summary: 'Wants to gain access to a new service or key',
    detail: 'It stopped before running request_capability.',
    preview: null,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No — I'll handle it",
    approvedText: 'You said yes, so it may gain access to a new service or key.',
    dismissedText: 'You turned this down. Nothing ran.',
    createdAt: T0,
    expiresAt: EXPIRES,
    resolvedAt: T0,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayError: null,
    ...over,
  };
}

/** A caller ctx that deliberately does NOT match the decision's own fields. */
function callerCtx(over: Partial<Parameters<typeof makeAgentContext>[0]> = {}): AgentContext {
  return makeAgentContext({
    sessionId: 'approve-session',
    agentId: 'approver-agent',
    userId: 'approver-user',
    conversationId: 'approver-conv',
    ...over,
  });
}

describe('replayOnApprove — byte-identical replay', () => {
  it('calls the registered host executor with the recorded call, verbatim', async () => {
    const bus = new HookBus();
    const received: unknown[] = [];
    bus.registerService('tool:execute:request_capability', 'test', async (_ctx, input) => {
      received.push(input);
      return { ok: true };
    });

    const decision = base();
    const outcome = await replayOnApprove({ bus, ctx: callerCtx(), decision });

    expect(outcome).toEqual({ executed: true, path: 'host-replays', error: null });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(decision.call);
  });
});

describe('replayOnApprove — sandbox-only tool parks', () => {
  it('returns approved-pending-agent and calls nothing when no host executor is registered', async () => {
    const bus = new HookBus();
    const decision = base({
      call: { id: 'call-2', name: 'skill_propose', input: { skill: 'demo' } },
    });

    const outcome = await replayOnApprove({ bus, ctx: callerCtx(), decision });

    expect(outcome).toEqual({
      executed: false,
      path: null,
      error: null,
      status: 'approved-pending-agent',
    });
  });

  it('never touches the bus when there is no matching service', async () => {
    const bus = new HookBus();
    let calls = 0;
    // A DIFFERENT hook, to prove nothing at all fired — not even the wrong one.
    bus.registerService('tool:execute:some_other_tool', 'test', async () => {
      calls += 1;
      return {};
    });
    const decision = base({
      call: { id: 'call-2', name: 'skill_propose', input: {} },
    });

    await replayOnApprove({ bus, ctx: callerCtx(), decision });

    expect(calls).toBe(0);
  });
});

describe('replayOnApprove — failure is recorded, not claimed', () => {
  it('returns executed:false, path:null and a sanitised Error message', async () => {
    const bus = new HookBus();
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      throw new Error('upstream 503');
    });
    const decision = base();

    const outcome = await replayOnApprove({ bus, ctx: callerCtx(), decision });

    expect(outcome.executed).toBe(false);
    expect(outcome.path).toBeNull();
    expect(outcome.error).toContain('upstream 503');
  });

  it('sanitises a thrown non-Error value and never throws out of replayOnApprove', async () => {
    const bus = new HookBus();
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      throw 'boom' as unknown as Error;
    });
    const decision = base();

    // `HookBus.call` wraps a handler's throw in a `PluginError` before it
    // reaches `replayOnApprove` — even a thrown string arrives here as a real
    // `Error` whose message quotes the original value. The point of this test
    // is that a non-Error throw still comes back as a plain sanitised string
    // and never propagates as an exception.
    const outcome = await replayOnApprove({ bus, ctx: callerCtx(), decision });

    expect(outcome.executed).toBe(false);
    expect(outcome.path).toBeNull();
    expect(typeof outcome.error).toBe('string');
    expect(outcome.error).toContain('boom');
  });
});

describe('replayContext — built from the DECISION, never the caller', () => {
  it('takes agentId, userId and conversationId from the decision', () => {
    const decision = base({
      agentId: 'decision-agent',
      ownerUserId: 'decision-owner',
      conversationId: 'decision-conv',
    });

    const ctx = replayContext(decision);

    expect(ctx.agentId).toBe('decision-agent');
    expect(ctx.userId).toBe('decision-owner');
    expect(ctx.conversationId).toBe('decision-conv');
    // Never the shape an approving request's own ctx would carry.
    expect(ctx.agentId).not.toBe('approver-agent');
    expect(ctx.userId).not.toBe('approver-user');
  });

  it('omits conversationId entirely when the decision has none', () => {
    const decision = base({ conversationId: '' });

    const ctx = replayContext(decision);

    expect('conversationId' in ctx).toBe(false);
    expect(ctx.conversationId).toBeUndefined();
  });
});

describe('settleReplay — success', () => {
  it('fires decisions:executed with the approved receipt and leaves the row alone', async () => {
    const bus = new HookBus();
    bus.registerService('tool:execute:request_capability', 'test', async () => ({ ok: true }));
    const store = createFakeStore();
    const decision = base();
    store.rows.set(decision.id, decision);

    const fired: DecisionExecutedPayload[] = [];
    bus.subscribe('decisions:executed', 'test-subscriber', async (_ctx, payload) => {
      fired.push(payload as DecisionExecutedPayload);
      return undefined;
    });

    const outcome = await settleReplay({ store, bus, ctx: callerCtx(), decision });

    expect(outcome.executed).toBe(true);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      decisionId: decision.id,
      agentId: decision.agentId,
      conversationId: decision.conversationId,
      outcome: 'executed',
      receipt: decision.approvedText,
    });
    expect(store.rows.get(decision.id)!.status).toBe('executed');
  });
});

describe('settleReplay — failure', () => {
  it('marks the row failed, persists the sanitised error, and never leaks approvedText into the receipt', async () => {
    const bus = new HookBus();
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      throw new Error('upstream 503');
    });
    const store = createFakeStore();
    const decision = base();
    store.rows.set(decision.id, decision);

    const fired: DecisionExecutedPayload[] = [];
    bus.subscribe('decisions:executed', 'test-subscriber', async (_ctx, payload) => {
      fired.push(payload as DecisionExecutedPayload);
      return undefined;
    });

    await settleReplay({ store, bus, ctx: callerCtx(), decision });

    const row = store.rows.get(decision.id)!;
    expect(row.status).toBe('failed');
    expect(row.replayError).toContain('upstream 503');

    expect(fired).toHaveLength(1);
    expect(fired[0]!.outcome).toBe('failed');
    expect(fired[0]!.receipt).toBe(FAILED_RECEIPT);
    // Design H1: an action that did not happen must never carry a receipt that
    // claims it did.
    expect(fired[0]!.receipt).not.toContain(decision.approvedText);
    expect(fired[0]!.receipt).not.toBe(decision.approvedText);
  });
});

describe('settleReplay — executor vanished between approval and replay', () => {
  it('parks the row for the agent and emits the pending-agent receipt', async () => {
    const bus = new HookBus(); // no executor registered at all
    const store = createFakeStore();
    const decision = base();
    store.rows.set(decision.id, decision);

    const fired: DecisionExecutedPayload[] = [];
    bus.subscribe('decisions:executed', 'test-subscriber', async (_ctx, payload) => {
      fired.push(payload as DecisionExecutedPayload);
      return undefined;
    });

    const outcome = await settleReplay({ store, bus, ctx: callerCtx(), decision });

    expect(outcome.status).toBe('approved-pending-agent');
    const row = store.rows.get(decision.id)!;
    expect(row.status).toBe('approved-pending-agent');
    expect(row.replayDueAt).toBeNull();

    expect(fired).toHaveLength(1);
    expect(fired[0]!.outcome).toBe('pending-agent');
    expect(fired[0]!.receipt).toBe(PENDING_AGENT_RECEIPT);
  });
});

describe('settleReplay — a broken decisions:executed subscriber cannot break the replay', () => {
  it('still resolves and the row still reflects the outcome when a subscriber throws', async () => {
    const bus = new HookBus();
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      throw new Error('upstream 503');
    });
    const store = createFakeStore();
    const decision = base();
    store.rows.set(decision.id, decision);

    bus.subscribe('decisions:executed', 'broken-subscriber', async () => {
      throw new Error('activity feed exploded');
    });

    await expect(
      settleReplay({ store, bus, ctx: callerCtx(), decision }),
    ).resolves.toBeDefined();

    expect(store.rows.get(decision.id)!.status).toBe('failed');
  });
});

describe('settleReplay — a completed replay stops being a standing authorisation', () => {
  /**
   * The bug this pins: without `replayedAt`, a row the HOST already ran stayed
   * `executed` with `consumedAt` null — so the agent's next identical call
   * sailed through the pre-call gate on a yes the host had already spent, and
   * an undo could put the row back on the queue for a second run. One approval,
   * two executions, which is the exact failure this package exists to prevent.
   */
  async function replayOnce(): Promise<ReturnType<typeof createFakeStore>> {
    const bus = new HookBus();
    bus.registerService('tool:execute:request_capability', 'test', async () => ({ ok: true }));
    const store = createFakeStore();
    const decision = base();
    store.rows.set(decision.id, decision);
    await settleReplay({ store, bus, ctx: callerCtx(), decision, now: () => new Date(T0) });
    return store;
  }

  it('stamps replayedAt and leaves the status executed', async () => {
    const store = await replayOnce();
    const row = store.rows.get('dec_1')!;
    expect(row.status).toBe('executed');
    expect(row.replayedAt).toBe(T0);
    // The consume belongs to the AGENT-retry path. The host running the call is
    // a different fact, recorded in a different field.
    expect(row.consumedAt).toBeNull();
  });

  it('takeApproval no longer honours it, so an identical agent call is held again', async () => {
    const store = await replayOnce();
    expect(await store.takeApproval('agent-1', 'fp-1', T0)).toBeNull();
  });

  it('undo refuses it — the call was made and cannot be un-made', async () => {
    const store = await replayOnce();
    expect(await store.restore('dec_1')).toBeNull();
  });

  /**
   * The race the review caught: an undo landing between the executor returning
   * and the stamp. If `markReplayed` were conditional on `status = 'executed'`
   * it would silently no-op, leaving a `pending` row while the receipt still
   * said the call went out — design H1 exactly. The send happened; the row must
   * agree with the world.
   */
  it('an undo that lands mid-replay loses — the row still says executed', async () => {
    const bus = new HookBus();
    const store = createFakeStore();
    const decision = base();
    store.rows.set(decision.id, decision);
    bus.registerService('tool:execute:request_capability', 'test', async () => {
      // The person hits undo while the tool is still in flight.
      await store.restore(decision.id);
      return { ok: true };
    });

    await settleReplay({ store, bus, ctx: callerCtx(), decision, now: () => new Date(T0) });

    const row = store.rows.get(decision.id)!;
    expect(row.status).toBe('executed');
    expect(row.replayedAt).toBe(T0);
    // And the undo cannot be retried now.
    expect(await store.restore(decision.id)).toBeNull();
  });
});

describe('emitExecuted — swallows a subscriber rejection and never throws', () => {
  it('does not throw when the sole subscriber throws', async () => {
    const bus = new HookBus();
    bus.subscribe('decisions:executed', 'broken-subscriber', async () => {
      throw new Error('boom');
    });
    const decision = base();

    await expect(
      emitExecuted(bus, callerCtx(), decision, 'executed', decision.approvedText),
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  CHAT_TURN_END_HOLD_HOOK,
  CHAT_TURN_SEGMENT_END_HOOK,
  HookBus,
  createLogger,
  makeAgentContext,
  type ChatTurnEndHoldPayload,
} from '@ax/core';
import { fireEventTurnEnd } from '../event-turn-end.js';

// R27 — the one place `chat:turn-end` is emitted asks first whether the
// turn-end is a held segment's (a sandbox restart inside one request). Held:
// `chat:turn-segment-end` fires instead. Not held, no subscriber, a throwing
// subscriber, or no reqId: `chat:turn-end` fires exactly as before.

function ctx(sessionId = 's-old') {
  return makeAgentContext({
    sessionId,
    agentId: 'a',
    userId: 'u',
    reqId: 'ipc-fresh',
    logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }),
  });
}

function record(bus: HookBus) {
  const seen: Array<{ hook: string; payload: unknown }> = [];
  for (const hook of ['chat:turn-end', CHAT_TURN_SEGMENT_END_HOOK]) {
    bus.subscribe<unknown>(hook, `test/${hook}`, async (_c, payload) => {
      seen.push({ hook, payload });
      return undefined;
    });
  }
  return seen;
}

const TURN_END = { reason: 'user-message-wait', role: 'assistant', reqId: 'req-1' };

describe('event.turn-end hold (R27)', () => {
  it('a normal turn still fires chat:turn-end and no segment-end', async () => {
    const bus = new HookBus();
    const seen = record(bus);
    await fireEventTurnEnd(ctx(), bus, TURN_END);
    expect(seen).toEqual([{ hook: 'chat:turn-end', payload: TURN_END }]);
  });

  it('a subscriber that does not hold leaves the broadcast alone', async () => {
    const bus = new HookBus();
    const asked: ChatTurnEndHoldPayload[] = [];
    bus.subscribe<ChatTurnEndHoldPayload>(CHAT_TURN_END_HOLD_HOOK, 'test/hold', async (_c, p) => {
      asked.push(p);
      return undefined;
    });
    const seen = record(bus);
    await fireEventTurnEnd(ctx(), bus, TURN_END);
    // The question names the host-stamped session and the turn-end's reqId.
    expect(asked).toEqual([{ sessionId: 's-old', reqId: 'req-1', held: false }]);
    expect(seen.map((s) => s.hook)).toEqual(['chat:turn-end']);
  });

  it('a held turn-end fires chat:turn-segment-end with the same payload instead', async () => {
    const bus = new HookBus();
    bus.subscribe<ChatTurnEndHoldPayload>(CHAT_TURN_END_HOLD_HOOK, 'test/hold', async (_c, p) =>
      p.sessionId === 's-old' && p.reqId === 'req-1' ? { ...p, held: true } : undefined,
    );
    const seen = record(bus);
    await fireEventTurnEnd(ctx(), bus, TURN_END);
    expect(seen).toEqual([{ hook: CHAT_TURN_SEGMENT_END_HOOK, payload: TURN_END }]);
    // Another session naming the same reqId is not held.
    await fireEventTurnEnd(ctx('s-other'), bus, TURN_END);
    expect(seen.map((s) => s.hook)).toEqual([CHAT_TURN_SEGMENT_END_HOOK, 'chat:turn-end']);
  });

  it('a throwing hold subscriber reads as not held', async () => {
    const bus = new HookBus();
    bus.subscribe<ChatTurnEndHoldPayload>(CHAT_TURN_END_HOLD_HOOK, 'test/hold', async () => {
      throw new Error('boom');
    });
    const seen = record(bus);
    await fireEventTurnEnd(ctx(), bus, TURN_END);
    expect(seen.map((s) => s.hook)).toEqual(['chat:turn-end']);
  });

  it('a rejecting hold subscriber reads as not held', async () => {
    const bus = new HookBus();
    bus.subscribe<ChatTurnEndHoldPayload>(CHAT_TURN_END_HOLD_HOOK, 'test/hold', async () => ({
      rejected: true as const,
      reason: 'no',
    }));
    const seen = record(bus);
    await fireEventTurnEnd(ctx(), bus, TURN_END);
    expect(seen.map((s) => s.hook)).toEqual(['chat:turn-end']);
  });

  it('a turn-end naming no reqId is never asked about', async () => {
    const bus = new HookBus();
    let asked = 0;
    bus.subscribe<ChatTurnEndHoldPayload>(CHAT_TURN_END_HOLD_HOOK, 'test/hold', async (_c, p) => {
      asked += 1;
      return { ...p, held: true };
    });
    const seen = record(bus);
    const dark = { reason: 'user-message-wait', role: 'assistant' };
    await fireEventTurnEnd(ctx(), bus, dark);
    expect(asked).toBe(0);
    expect(seen).toEqual([{ hook: 'chat:turn-end', payload: dark }]);
  });
});

import { HookBus, makeAgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  TURN_EVENT_HOOKS,
  createTurnRegistry,
  subscribeTurnEvents,
  type StreamChunkIn,
  type TurnSink,
} from '../turn-registry.js';

const CONVERSATION = 'conv_alice_slack';
const REQ = 'req-aaaaaaaaaaaa';

function recordingSink(over: Partial<TurnSink> = {}) {
  const seen: string[] = [];
  const chunks: StreamChunkIn[] = [];
  const sink: TurnSink = {
    reqId: REQ,
    conversationId: CONVERSATION,
    chunk: (c) => {
      chunks.push(c);
      seen.push(`chunk ${c.kind ?? '?'}`);
    },
    end: () => seen.push('end'),
    error: () => seen.push('error'),
    ...over,
  };
  return { sink, seen, chunks };
}

const ctxFor = (conversationId?: string) =>
  makeAgentContext({
    sessionId: 's',
    agentId: 'agt_alice',
    userId: 'usr_alice',
    // The IPC listener restamps ctx.reqId per request; only the payload's names the turn.
    reqId: 'req-ipc-restamped',
    ...(conversationId !== undefined ? { conversationId } : {}),
  });

describe('createTurnRegistry', () => {
  it("another reqId's chunk is ignored", () => {
    const r = createTurnRegistry();
    const { sink, chunks } = recordingSink();
    r.register(sink);
    r.onStreamChunk({ reqId: 'req-someone-else', kind: 'text', text: 'not yours' });
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'yours' });
    expect(chunks).toEqual([{ reqId: REQ, kind: 'text', text: 'yours' }]);
  });

  it('a chunk is handed on with only the fields it names, each of the right type', () => {
    const r = createTurnRegistry();
    const { sink, chunks } = recordingSink();
    r.register(sink);
    r.onStreamChunk({
      reqId: REQ,
      kind: 'tool-use',
      toolCallId: 'call_1',
      toolName: 'mcp__ax-sandbox-tools__show_visual',
      activityPhrase: 42,
      input: { secret: 'never needed' },
      isError: 'yes',
    });
    expect(chunks).toEqual([
      { reqId: REQ, kind: 'tool-use', toolCallId: 'call_1', toolName: 'mcp__ax-sandbox-tools__show_visual' },
    ]);
  });

  it('turn-end for the same conversation with a different reqId is ignored', () => {
    const r = createTurnRegistry();
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: 'req-another-turn', reason: 'complete' });
    expect(seen).toEqual([]);
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: REQ, reason: 'complete' });
    expect(seen).toEqual(['end']);
  });

  it('turn-end for another conversation is ignored, even naming this reqId', () => {
    const r = createTurnRegistry();
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnEnd(ctxFor('conv_someone_else'), { reqId: REQ });
    r.onTurnEnd(ctxFor(undefined), { reqId: REQ });
    expect(seen).toEqual([]);
  });

  it('a folded reqId ends the turn', () => {
    const r = createTurnRegistry();
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: 'req-the-turn-that-answered', foldedReqIds: [REQ] });
    expect(seen).toEqual(['end']);
  });

  it('only a real array of exact ids counts as folded', () => {
    const r = createTurnRegistry();
    const { sink, seen } = recordingSink();
    r.register(sink);
    for (const foldedReqIds of [REQ, { 0: REQ }, [`${REQ} `], [REQ.toUpperCase()]]) {
      r.onTurnEnd(ctxFor(CONVERSATION), { reqId: 'req-other', foldedReqIds });
    }
    expect(seen).toEqual([]);
  });

  it('a turn-end with no reqId ends it (channel-web parity)', () => {
    for (const payload of [{}, { reqId: '' }, { reqId: 42 }, undefined, null, 'text']) {
      const r = createTurnRegistry();
      const { sink, seen } = recordingSink();
      r.register(sink);
      r.onTurnEnd(ctxFor(CONVERSATION), payload);
      expect(seen, JSON.stringify(payload)).toEqual(['end']);
    }
  });

  it('turn-error is matched by reqId only', () => {
    const r = createTurnRegistry();
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onTurnError({ reason: 'chat-run-timeout' });
    r.onTurnError({ reqId: 'req-other', reason: 'chat-run-timeout' });
    r.onTurnError(null);
    expect(seen).toEqual([]);
    r.onTurnError({ reqId: REQ, reason: 'chat-run-timeout' });
    expect(seen).toEqual(['error']);
  });

  it('malformed payloads are ignored, never thrown on', () => {
    const r = createTurnRegistry();
    const { sink, seen } = recordingSink();
    r.register(sink);
    for (const p of [undefined, null, 42, 'x', [], { reqId: 42 }, { kind: 'text' }]) {
      expect(() => r.onStreamChunk(p)).not.toThrow();
      expect(() => r.onTurnError(p)).not.toThrow();
    }
    expect(seen).toEqual([]);
  });

  it('unregister stops delivery, and a sink that throws never breaks the registry', () => {
    const r = createTurnRegistry();
    const thrower = recordingSink({
      chunk: () => {
        throw new Error('sink bug');
      },
    });
    const unregister = r.register(thrower.sink);
    expect(() => r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'x' })).not.toThrow();
    unregister();
    const { sink, seen } = recordingSink();
    r.register(sink);
    r.onStreamChunk({ reqId: REQ, kind: 'text', text: 'y' });
    expect(seen).toEqual(['chunk text']);
    unregister();
    // Unregistering the old sink twice must not drop the new one.
    r.onTurnEnd(ctxFor(CONVERSATION), { reqId: REQ });
    expect(seen).toEqual(['chunk text', 'end']);
  });

  it('size counts the sinks held now: an undo releases its own, once', () => {
    const r = createTurnRegistry();
    expect(r.size()).toBe(0);
    const undoA = r.register(recordingSink().sink);
    const undoB = r.register(recordingSink({ reqId: 'req-bbbbbbbbbbbb' }).sink);
    expect(r.size()).toBe(2);
    undoA();
    undoA();
    expect(r.size()).toBe(1);
    // A second sink for the same reqId replaces the first; the first's undo can't remove it.
    const undoC = r.register(recordingSink({ reqId: 'req-bbbbbbbbbbbb' }).sink);
    undoB();
    expect(r.size()).toBe(1);
    undoC();
    expect(r.size()).toBe(0);
  });

  it('subscribeTurnEvents wires the three hooks on the bus, and its undo removes them', async () => {
    const bus = new HookBus();
    const r = createTurnRegistry();
    const { sink, seen } = recordingSink();
    r.register(sink);
    const undo = subscribeTurnEvents(bus, r, '@ax/channel-slack/turns');
    expect(TURN_EVENT_HOOKS).toEqual(['chat:stream-chunk', 'chat:turn-end', 'chat:turn-error']);
    await bus.fire('chat:stream-chunk', ctxFor(CONVERSATION), { reqId: REQ, kind: 'text', text: 'hi' });
    await bus.fire('chat:turn-error', ctxFor(CONVERSATION), { reqId: REQ });
    await bus.fire('chat:turn-end', ctxFor(CONVERSATION), { reqId: REQ });
    expect(seen).toEqual(['chunk text', 'error', 'end']);
    undo();
    for (const hook of TURN_EVENT_HOOKS) expect(bus.unsubscribe(hook, '@ax/channel-slack/turns')).toBe(0);
  });
});

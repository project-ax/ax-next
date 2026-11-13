import type { AgentContext, HookBus } from '@ax/core';

/**
 * The DM turns running now, and the one plugin-level subscriber per chat
 * event that feeds them. A turn registers its sink BEFORE `agent:invoke`
 * (the first chunk can arrive before the call returns) and unregisters when
 * it ends. One subscription each, instead of one per turn: no churn.
 *
 * Matching copies channel-web's SSE stream (`server/sse.ts`):
 *   - `chat:stream-chunk` and `chat:turn-error`: the payload's `reqId` is
 *     the turn's. (The firing ctx's reqId is useless: the IPC listener
 *     restamps it per request.)
 *   - `chat:turn-end`: the firing ctx's conversation is the turn's, and then
 *     the payload's `reqId` is the turn's, OR absent or empty (a turn run
 *     dark), OR the turn's reqId is in `foldedReqIds` (a real array, exact
 *     matches: it's runner-written and untrusted).
 *
 * Payloads are runner output: every field is checked with typeof, and a
 * chunk is handed on with only the fields named in StreamChunkIn. A sink
 * that throws never breaks the registry or the bus.
 */

/** The chat events the registry needs, in the order it subscribes to them. */
export const TURN_EVENT_HOOKS = ['chat:stream-chunk', 'chat:turn-end', 'chat:turn-error'] as const;

/**
 * A `chat:stream-chunk` payload as channel-slack reads it: a structural
 * mirror of channel-web's StreamChunk (no cross-plugin import), every field
 * optional and present only when of the right type. `text` and the tool
 * fields are model or tool output (untrusted).
 */
export interface StreamChunkIn {
  reqId: string;
  kind?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  /** Host-authored activity label for a tool use, already fenced at IPC ingress. */
  activityPhrase?: string;
  isError?: boolean;
  /** The call is held, waiting for a person. */
  held?: boolean;
}

export interface TurnSink {
  reqId: string;
  conversationId: string;
  chunk(c: StreamChunkIn): void;
  end(): void;
  error(): void;
}

export interface TurnRegistry {
  /** Returns the undo. Undoing twice, or after another sink took the reqId, is harmless. */
  register(sink: TurnSink): () => void;
  onStreamChunk(payload: unknown): void;
  onTurnEnd(ctx: Pick<AgentContext, 'conversationId'>, payload: unknown): void;
  onTurnError(payload: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const STRING_FIELDS = ['kind', 'text', 'toolCallId', 'toolName', 'activityPhrase'] as const;
const BOOLEAN_FIELDS = ['isError', 'held'] as const;

function narrowChunk(reqId: string, payload: Record<string, unknown>): StreamChunkIn {
  const chunk: StreamChunkIn = { reqId };
  for (const key of STRING_FIELDS) {
    const value = payload[key];
    if (typeof value === 'string') chunk[key] = value;
  }
  for (const key of BOOLEAN_FIELDS) {
    const value = payload[key];
    if (typeof value === 'boolean') chunk[key] = value;
  }
  return chunk;
}

/** A sink's own failure stays its own. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Nothing to do: the sink's turn still ends by its other paths.
  }
}

export function createTurnRegistry(): TurnRegistry {
  const byReqId = new Map<string, TurnSink>();

  const sinkFor = (payload: unknown): TurnSink | undefined => {
    if (!isRecord(payload)) return undefined;
    const reqId = payload['reqId'];
    return typeof reqId === 'string' ? byReqId.get(reqId) : undefined;
  };

  return {
    register(sink) {
      byReqId.set(sink.reqId, sink);
      return () => {
        if (byReqId.get(sink.reqId) === sink) byReqId.delete(sink.reqId);
      };
    },

    onStreamChunk(payload) {
      const sink = sinkFor(payload);
      if (sink === undefined) return;
      const chunk = narrowChunk(sink.reqId, payload as Record<string, unknown>);
      safely(() => sink.chunk(chunk));
    },

    onTurnEnd(ctx, payload) {
      const conversationId = ctx.conversationId;
      if (conversationId === undefined) return;
      const p = isRecord(payload) ? payload : {};
      const ended = p['reqId'];
      const folded = p['foldedReqIds'];
      for (const sink of [...byReqId.values()]) {
        if (sink.conversationId !== conversationId) continue;
        const foldedHere = Array.isArray(folded) && folded.includes(sink.reqId);
        if (!foldedHere && typeof ended === 'string' && ended.length > 0 && ended !== sink.reqId) continue;
        safely(() => sink.end());
      }
    },

    onTurnError(payload) {
      const sink = sinkFor(payload);
      if (sink !== undefined) safely(() => sink.error());
    },
  };
}

/**
 * Subscribe `registry` to the three chat events under `key` (the subscriber's
 * name on the bus). Returns the undo. Each subscriber only buffers into a
 * sink and returns: chunk subscribers are fired without being awaited by
 * their producers, so nothing here waits on Slack.
 */
export function subscribeTurnEvents(bus: HookBus, registry: TurnRegistry, key: string): () => void {
  bus.subscribe<unknown>('chat:stream-chunk', key, async (_ctx, payload) => {
    registry.onStreamChunk(payload);
    return undefined;
  });
  bus.subscribe<unknown>('chat:turn-end', key, async (ctx, payload) => {
    registry.onTurnEnd(ctx, payload);
    return undefined;
  });
  bus.subscribe<unknown>('chat:turn-error', key, async (_ctx, payload) => {
    registry.onTurnError(payload);
    return undefined;
  });
  return () => {
    for (const hook of TURN_EVENT_HOOKS) bus.unsubscribe(hook, key);
  };
}

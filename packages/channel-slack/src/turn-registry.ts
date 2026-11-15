import type { AgentContext, HookBus, Logger } from '@ax/core';
import { logCode } from './log-code.js';

/**
 * The Slack turns running now (DMs and channel mentions), and the one
 * plugin-level subscriber per chat event that feeds them. A turn registers its sink BEFORE `agent:invoke`
 * (the first chunk can arrive before the call returns) and unregisters when
 * it ends. One subscription each, instead of one per turn: no churn.
 *
 * Matching copies channel-web's SSE stream (`server/sse.ts`), but for one
 * rule:
 *   - `chat:stream-chunk` and `chat:turn-error`: the payload's `reqId` is
 *     the turn's. (The firing ctx's reqId is useless: the IPC listener
 *     restamps it per request.)
 *   - `chat:turn-end`: the firing ctx's conversation is the turn's, and then
 *     the payload's `reqId` is the turn's, OR the turn's reqId is in
 *     `foldedReqIds` (a real array, exact matches: it's runner-written and
 *     untrusted), OR the payload names no turn (`reqId` absent, empty or not
 *     a string: a turn run dark) and the turn has BEGUN: a chunk under its
 *     reqId has come.
 *
 *   - `chat:permission-request` (a card asking the person's OK): a `host` card
 *     names its turn by the payload's `reqId` (the firing ctx is the egress
 *     proxy's, not the turn's); a `skill` card is matched by the firing ctx's
 *     conversation (the broker fires it from the runner's IPC ctx: a fresh
 *     reqId, the real conversation), to every sink in it. Any other `kind` is
 *     dropped. channel-web `sse.ts:590-619` does the same.
 *
 * That last condition is ours, not channel-web's. A dark turn-end before a
 * turn has begun is another turn's: a warm agent's reaction to a Deny runs
 * dark (decisions:dismiss wakes it with no continuation id), and the
 * person's next message, sent right after the Deny, has its turn registered
 * and waiting by then. Ended there, their reply said "I didn't have anything
 * to add." and their real answer streamed to nobody. A turn whose own end
 * came dark before it said anything still ends: runTurn's invoke grace ends
 * it, and a woken turn's start deadline does (turn.ts).
 *
 * Payloads are runner output: every field is checked with typeof, and a
 * chunk is handed on with only the fields named in StreamChunkIn. A sink
 * that throws never breaks the registry or the bus. Its end, error or
 * permission throwing is logged (`slack_turn_sink_failed`, the stage and the
 * error's code only: never its message, the card or an id). A chunk's is
 * logged once per sink: the busiest path must leave a trace when a reply
 * is lost, but one broken sink would log once per streamed piece.
 */

/** The chat events the registry needs, in the order it subscribes to them. */
export const TURN_EVENT_HOOKS = [
  'chat:stream-chunk',
  'chat:turn-end',
  'chat:turn-error',
  'chat:permission-request',
] as const;

/**
 * A `chat:permission-request` card as channel-slack reads it: only the fields
 * it needs, each checked with typeof. Strings pass through untouched
 * (a `host` is whatever the sandbox tried to reach: validating it is the
 * prompt's job, not the registry's). `needsKey` is true unless the card has a
 * `slots` array whose every slot is an object with `haveExisting === true`:
 * Slack never collects a key, so anything not provably key-free needs the web.
 */
export type PermissionIn =
  | { kind: 'host'; host: string; sessionId: string }
  | { kind: 'skill'; skillId: string; description: string; needsKey: boolean };

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
  /** A card asking for the person's OK, for this turn (host) or conversation (skill). */
  permission?(p: PermissionIn): void;
}

export interface TurnRegistry {
  /** Returns the undo. Undoing twice, or after another sink took the reqId, is harmless. */
  register(sink: TurnSink): () => void;
  onStreamChunk(payload: unknown): void;
  onTurnEnd(ctx: Pick<AgentContext, 'conversationId'>, payload: unknown): void;
  onTurnError(payload: unknown): void;
  onPermissionRequest(ctx: Pick<AgentContext, 'conversationId'>, payload: unknown): void;
  /** Sinks registered now. 0 once every turn has ended: each one unregisters however it ends. */
  size(): number;
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function keyFree(slots: unknown): boolean {
  return Array.isArray(slots) && slots.every((s) => isRecord(s) && s['haveExisting'] === true);
}

/** The card's own fields, or null for any other kind or a field of the wrong type. */
function narrowPermission(payload: Record<string, unknown>): PermissionIn | null {
  if (payload['kind'] === 'host') {
    const { host, sessionId } = payload;
    return nonEmptyString(host) && nonEmptyString(sessionId) ? { kind: 'host', host, sessionId } : null;
  }
  if (payload['kind'] === 'skill') {
    const { skillId, description } = payload;
    if (!nonEmptyString(skillId)) return null;
    if (description !== undefined && typeof description !== 'string') return null;
    return { kind: 'skill', skillId, description: description ?? '', needsKey: !keyFree(payload['slots']) };
  }
  return null;
}

/** Where a sink threw: the registry call that handed it something. */
type SinkStage = 'chunk' | 'end' | 'error' | 'permission';

export interface TurnRegistryDeps {
  /** Hears a sink's end, error or permission throwing, and its FIRST chunk throw, by stage and code. */
  logger: Pick<Logger, 'warn'>;
}

interface Entry {
  readonly sink: TurnSink;
  /** A chunk under the sink's reqId has come: its turn has begun. */
  begun: boolean;
  /** Its first chunk failure has been logged: the rest are not. */
  chunkFailed: boolean;
}

export function createTurnRegistry(d: TurnRegistryDeps): TurnRegistry {
  const byReqId = new Map<string, Entry>();

  /** A sink's own failure stays its own: its turn still ends by its other paths. */
  const safely = (stage: SinkStage, fn: () => void, entry?: Entry): void => {
    try {
      fn();
    } catch (err) {
      // A chunk's is logged once per sink: one broken sink would otherwise log once per piece (header).
      if (stage === 'chunk' && entry !== undefined) {
        if (entry.chunkFailed) return;
        entry.chunkFailed = true;
      }
      try {
        d.logger.warn('slack_turn_sink_failed', { stage, code: logCode(err) });
      } catch {
        // A log line never breaks the registry.
      }
    }
  };

  const entryFor = (payload: unknown): Entry | undefined => {
    if (!isRecord(payload)) return undefined;
    const reqId = payload['reqId'];
    return typeof reqId === 'string' ? byReqId.get(reqId) : undefined;
  };

  return {
    register(sink) {
      const entry: Entry = { sink, begun: false, chunkFailed: false };
      byReqId.set(sink.reqId, entry);
      return () => {
        if (byReqId.get(sink.reqId) === entry) byReqId.delete(sink.reqId);
      };
    },

    onStreamChunk(payload) {
      const entry = entryFor(payload);
      if (entry === undefined) return;
      entry.begun = true;
      const sink = entry.sink;
      const chunk = narrowChunk(sink.reqId, payload as Record<string, unknown>);
      safely('chunk', () => sink.chunk(chunk), entry);
    },

    onTurnEnd(ctx, payload) {
      const conversationId = ctx.conversationId;
      if (conversationId === undefined) return;
      const p = isRecord(payload) ? payload : {};
      const ended = p['reqId'];
      const folded = p['foldedReqIds'];
      const named = typeof ended === 'string' && ended.length > 0;
      for (const { sink, begun } of [...byReqId.values()]) {
        if (sink.conversationId !== conversationId) continue;
        const foldedHere = Array.isArray(folded) && folded.includes(sink.reqId);
        if (!foldedHere) {
          if (named && ended !== sink.reqId) continue;
          // Dark: a turn that hasn't begun isn't the one that ended (header).
          if (!named && !begun) continue;
        }
        safely('end', () => sink.end());
      }
    },

    onTurnError(payload) {
      const sink = entryFor(payload)?.sink;
      if (sink !== undefined) safely('error', () => sink.error());
    },

    onPermissionRequest(ctx, payload) {
      if (!isRecord(payload)) return;
      const card = narrowPermission(payload);
      if (card === null) return;
      if (card.kind === 'host') {
        const sink = entryFor(payload)?.sink;
        if (sink?.permission !== undefined) {
          const deliver = sink.permission.bind(sink);
          safely('permission', () => deliver(card));
        }
        return;
      }
      const conversationId = ctx.conversationId;
      if (conversationId === undefined) return;
      for (const { sink } of [...byReqId.values()]) {
        if (sink.conversationId !== conversationId || sink.permission === undefined) continue;
        const deliver = sink.permission.bind(sink);
        safely('permission', () => deliver(card));
      }
    },

    size() {
      return byReqId.size;
    },
  };
}

/**
 * Subscribe `registry` to the four chat events under `key` (the subscriber's
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
  bus.subscribe<unknown>('chat:permission-request', key, async (ctx, payload) => {
    registry.onPermissionRequest(ctx, payload);
    return undefined;
  });
  return () => {
    for (const hook of TURN_EVENT_HOOKS) bus.unsubscribe(hook, key);
  };
}

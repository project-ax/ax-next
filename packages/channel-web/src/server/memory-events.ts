import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import type { RouteRequest, RouteResponse } from './sse.js';

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id/memory-events (TASK-626).
//
// Why a second stream: the chat stream (sse.ts) is per TURN and closes at
// turn-end, and memory passes run AFTER turn-end. So "the agent is noting
// something from this conversation" needs a stream scoped to the
// conversation, not the turn.
//
// Per request:
//
//   1. auth:require-user → 401.
//   2. conversations:get(conversationId, userId) → forbidden / not-found both
//      answer 404 `conversation-not-found` (never 403 — no existence leak).
//   3. agents:resolve(agentId, userId) → 404, same posture.
//   4. No memory:status on the bus → 503 `memory-unavailable`: this
//      deployment does not run memory at all.
//   5. Open the stream, SUBSCRIBE to memory:conversation-activity, THEN read
//      the memory:status snapshot. Subscribe-first means a pass that starts
//      while the snapshot is being read is still seen (it may arrive before
//      the snapshot frame; the UI treats both as "latest wins").
//   6. After a live `idle` or `failed` activity frame, re-read memory:status
//      and write a fresh `memoryStatus` frame (TASK-645): those endings do
//      not say whether the per-user pause cleared, and the pass may have.
//
// Frames (no `kind`, no `seq` — the client's frame reader dedups on those):
//   data: {"memoryStatus":{"extraction":"ok"|"paused","conversation":"idle"|"extracting"|"failed"}}
//   data: {"memoryStatus":{"readFailed":true}}
//   data: {"memoryActivity":{"state":...,"statementIds"?:[...]}}
//
// Activity frames carry statement IDS only, never statement text — the UI
// fetches the rows it is allowed to see through the memory recall route.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';
const KEEPALIVE_MS = 25_000;
const MAX_STATEMENT_IDS = 200;

const ACTIVITY_STATES = new Set(['extracting', 'recorded', 'idle', 'failed', 'paused']);
const CONVERSATION_STATES = new Set(['idle', 'extracting', 'failed']);

type ActivityState = 'extracting' | 'recorded' | 'idle' | 'failed' | 'paused';

export type MemoryEventFrame =
  | {
      memoryStatus:
        | { extraction: 'ok' | 'paused'; conversation: 'idle' | 'extracting' | 'failed' }
        | { readFailed: true };
    }
  | { memoryActivity: { state: ActivityState; statementIds?: string[] } };

export interface MemoryEventsHandlerDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

/** Validate the untyped memory:status reply field by field. Unknown → quiet default. */
function readStatus(reply: unknown): {
  extraction: 'ok' | 'paused';
  conversation: 'idle' | 'extracting' | 'failed';
} {
  const r = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
  const extraction = r.extraction === 'paused' ? 'paused' : 'ok';
  const conv =
    typeof r.conversation === 'object' && r.conversation !== null
      ? (r.conversation as Record<string, unknown>).state
      : undefined;
  const conversation =
    typeof conv === 'string' && CONVERSATION_STATES.has(conv)
      ? (conv as 'idle' | 'extracting' | 'failed')
      : 'idle';
  return { extraction, conversation };
}

/** Build the wire frame from an activity payload, or null to drop it. */
function activityFrame(payload: Record<string, unknown>): MemoryEventFrame | null {
  const state = payload.state;
  if (typeof state !== 'string' || !ACTIVITY_STATES.has(state)) return null;
  // Fields copied one at a time, never spread: the payload is another
  // plugin's, and a field added upstream later must not reach the browser
  // without someone deciding it should.
  if (state === 'recorded') {
    const raw = Array.isArray(payload.statementIds) ? (payload.statementIds as unknown[]) : [];
    const statementIds = raw
      .filter((id): id is string => typeof id === 'string')
      .slice(0, MAX_STATEMENT_IDS);
    return { memoryActivity: { state, statementIds } };
  }
  return { memoryActivity: { state: state as ActivityState } };
}

export function createMemoryEventsHandler(deps: MemoryEventsHandlerDeps) {
  const { bus, initCtx } = deps;

  return async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    // 1) Authenticate.
    let userId: string;
    try {
      const result = await bus.call<
        { req: RouteRequest },
        { user: { id: string; isAdmin: boolean } }
      >('auth:require-user', initCtx, { req });
      userId = result.user.id;
    } catch (err) {
      if (err instanceof PluginError || isRejection(err)) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      throw err;
    }

    // 2) The conversation, owned by this user.
    const conversationId = req.params.id;
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      res.status(404).json({ error: 'conversation-not-found' });
      return;
    }
    let agentId: string;
    try {
      const got = await bus.call<
        { conversationId: string; userId: string },
        { conversation: { agentId: string } }
      >('conversations:get', initCtx, { conversationId, userId });
      agentId = got.conversation.agentId;
    } catch (err) {
      if (err instanceof PluginError && (err.code === 'forbidden' || err.code === 'not-found')) {
        res.status(404).json({ error: 'conversation-not-found' });
        return;
      }
      throw err;
    }

    // 3) The conversation's agent must still be reachable by this user.
    try {
      await bus.call<{ agentId: string; userId: string }, unknown>('agents:resolve', initCtx, {
        agentId,
        userId,
      });
    } catch (err) {
      if (err instanceof PluginError) {
        res.status(404).json({ error: 'conversation-not-found' });
        return;
      }
      throw err;
    }

    // 4) Memory isn't running in this deployment — say so, don't stream silence.
    if (!bus.hasService('memory:status')) {
      res.status(503).json({ error: 'memory-unavailable' });
      return;
    }

    // 5) Open the stream.
    const stream = res.status(200).stream({ contentType: 'text/event-stream; charset=utf-8' });

    let closed = false;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    const subKey = `${PLUGIN_NAME}/memory-events/${conversationId}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      bus.unsubscribe('memory:conversation-activity', subKey);
    };
    stream.onClose(cleanup);

    const safeWrite = (frame: MemoryEventFrame): void => {
      if (closed) return;
      try {
        stream.write(`data: ${JSON.stringify(frame)}\n\n`);
      } catch {
        cleanup();
        try {
          stream.close();
        } catch {
          // already closed
        }
      }
    };

    // 5a) Subscribe FIRST, so nothing fired during the snapshot read is lost.
    // Until the snapshot is written, frames are HELD, not written: the read
    // can capture `extracting` a moment before the pass ends and fires
    // `recorded`, and a snapshot written after that event would leave the
    // client showing "extracting" with nothing left to correct it. Snapshot
    // first, then every event the read raced, in order, so the last word is
    // always the newest.
    let held: MemoryEventFrame[] | null = [];
    // The memory:status reads below run on a ctx for this agent and caller.
    const ctx = makeAgentContext({
      sessionId: 'memory-events',
      agentId,
      userId,
      conversationId,
      workspace: initCtx.workspace,
    });
    bus.subscribe<unknown>('memory:conversation-activity', subKey, async (_ctx, payload) => {
      if (typeof payload !== 'object' || payload === null) return undefined;
      const p = payload as Record<string, unknown>;
      if (p.conversationId !== conversationId || p.userId !== userId) return undefined;
      const frame = activityFrame(p);
      if (frame === null) return undefined;
      if (held !== null) {
        // The snapshot read is still in flight and will answer `extraction`.
        held.push(frame);
        return undefined;
      }
      safeWrite(frame);
      // TASK-645: an `idle` or `failed` ending says nothing about the per-user
      // pause, yet the pass may have just cleared it (a stored key resolved,
      // then nothing durable was said) — `recorded` and `paused` answer it
      // themselves. Re-read the ONE source (`memory:status`) rather than have
      // the client guess, so the rail never keeps saying "paused" after
      // extraction has resumed.
      if (p.state === 'idle' || p.state === 'failed') {
        try {
          const reply = await bus.call<{ conversationId: string }, unknown>('memory:status', ctx, {
            conversationId,
          });
          safeWrite({ memoryStatus: readStatus(reply) });
        } catch (err) {
          // Advisory: the next snapshot (reconnect) or `recorded` corrects it.
          initCtx.logger.warn('memory_events_status_read_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return undefined;
    });

    // 5b) Keepalive, armed before the await below so a close during the read
    // still finds (and clears) it.
    keepaliveTimer = setInterval(() => {
      if (closed) return;
      try {
        stream.write(':\n\n');
      } catch {
        cleanup();
      }
    }, KEEPALIVE_MS);
    if (typeof (keepaliveTimer as { unref?: () => void }).unref === 'function') {
      (keepaliveTimer as { unref: () => void }).unref();
    }

    // 5c) THEN the snapshot, on the ctx above.
    try {
      const reply = await bus.call<{ conversationId: string }, unknown>('memory:status', ctx, {
        conversationId,
      });
      safeWrite({ memoryStatus: readStatus(reply) });
    } catch (err) {
      initCtx.logger.warn('memory_events_status_read_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // "Couldn't check" — the stream stays open; live activity still flows.
      safeWrite({ memoryStatus: { readFailed: true } });
    }
    const raced = held;
    held = null;
    for (const frame of raced) safeWrite(frame);
  };
}

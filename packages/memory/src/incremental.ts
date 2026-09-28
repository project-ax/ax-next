import type { AgentContext, HookBus } from '@ax/core';

/**
 * When to extract DURING a conversation — TASK-625.
 *
 * `chat:end` fires once per runner SESSION, and in the k8s preset a session
 * ends when the idle reaper collects the warm runner (~5 min after the last
 * turn), not when the person is done. Extracting only there makes memories
 * appear at an arbitrary, late time. So a pass also runs when either of these
 * happens first after a completed turn:
 *
 * - **idle**: no further assistant turn for `idleMs` (default 2 min);
 * - **turns**: `everyUserTurns` completed user turns (default 4) since the
 *   last pass.
 *
 * `chat:end` still runs a final pass over whatever remains. Every pass is
 * detached — nothing here is awaited by the turn — and passes for one
 * conversation run strictly one after another, so an idle pass and a
 * `chat:end` pass can never read the same cursor at once. That serialization
 * is in-process, which is honest only because the host is single-replica
 * (the chart refuses more; same footing as `memory:status`). The DURABLE part
 * of the dedup does not depend on it: the cursor lives in `storage:*`, and a
 * pass that re-runs over the same turns re-uses the same batch key.
 *
 * This file owns timing and ordering only. What a pass does is `runPass`,
 * supplied by the plugin.
 */

export const CHAT_TURN_END_HOOK = 'chat:turn-end';
export const CONVERSATIONS_GET_HOOK = 'conversations:get';
export const STORAGE_GET_HOOK = 'storage:get';
export const STORAGE_SET_HOOK = 'storage:set';

export const DEFAULT_IDLE_MS = 120_000;
export const DEFAULT_EVERY_USER_TURNS = 4;

export type PassTrigger = 'idle' | 'turns' | 'chat-end';

export interface IncrementalConfig {
  /** Idle pause after a completed turn that triggers a pass. Default 2 min. */
  idleMs?: number;
  /** Completed user turns that trigger a pass. Default 4. */
  everyUserTurns?: number;
}

/**
 * True when this host can extract incrementally: it has the canonical
 * transcript (turns with ids) AND somewhere durable to keep the cursor.
 *
 * Both, or the plugin stays on the `chat:end`-only path it had before. A
 * transcript without a durable cursor would re-extract every turn after a
 * host restart, under a new range and so a new batch key — the exact
 * double-recording this card forbids. The CLI loads neither, and keeps the
 * old behaviour exactly.
 */
export function canExtractIncrementally(bus: HookBus): boolean {
  return (
    bus.hasService(CONVERSATIONS_GET_HOOK) &&
    bus.hasService(STORAGE_GET_HOOK) &&
    bus.hasService(STORAGE_SET_HOOK)
  );
}

/**
 * The per-conversation cursor: the `turnIndex` just past the last canonical
 * turn a pass covered. Kept in `storage:*` so a host restart resumes where it
 * stopped instead of re-extracting the conversation from the top.
 *
 * Written only AFTER the batch is recorded. If the write is lost, the next
 * pass covers the same range again under the same batch key — an engine
 * no-op — plus whatever came after.
 */
export function cursorKey(conversationId: string): string {
  return `memory:observer-cursor:${conversationId}`;
}

export async function readCursor(
  bus: HookBus,
  ctx: AgentContext,
  conversationId: string,
): Promise<number> {
  const out = await bus.call<{ key: string }, { value?: Uint8Array } | null | undefined>(
    STORAGE_GET_HOOK,
    ctx,
    { key: cursorKey(conversationId) },
  );
  const value = out?.value;
  if (value === undefined) return 0;
  // We are the only writer of this key. Anything we cannot read is a fault,
  // not "start over": starting over would re-record the whole conversation.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value));
  } catch {
    parsed = undefined;
  }
  const next = (parsed as { next?: unknown } | undefined)?.next;
  if (typeof next !== 'number' || !Number.isInteger(next) || next < 0) {
    throw new Error('memory observer cursor is unreadable; refusing to re-extract the conversation');
  }
  return next;
}

export async function writeCursor(
  bus: HookBus,
  ctx: AgentContext,
  conversationId: string,
  next: number,
): Promise<void> {
  await bus.call<{ key: string; value: Uint8Array }, unknown>(STORAGE_SET_HOOK, ctx, {
    key: cursorKey(conversationId),
    value: new TextEncoder().encode(JSON.stringify({ next })),
  });
}

interface ConversationState {
  ctx: AgentContext;
  timer: NodeJS.Timeout | undefined;
  userTurns: number;
  lastReqId?: string;
}

export interface IncrementalScheduler {
  /** A `chat:turn-end` arrived. Never throws, never awaits a pass. */
  onTurnEnd(ctx: AgentContext, payload: { role?: unknown; reqId?: unknown } | undefined): void;
  /** `chat:end` for a conversation: cancel its timer, queue the final pass. */
  onChatEnd(ctx: AgentContext & { conversationId: string }): void;
  shutdown(): void;
}

export function createIncrementalScheduler(opts: {
  idleMs: number;
  everyUserTurns: number;
  /** One pass. Must never reject — the plugin's pass catches everything. */
  runPass: (ctx: AgentContext & { conversationId: string }, trigger: PassTrigger) => Promise<void>;
  /** Every queued pass, for the test seam. */
  onDetached?: (work: Promise<void>) => void;
}): IncrementalScheduler {
  const states = new Map<string, ConversationState>();
  /** The tail of each conversation's pass queue. */
  const tails = new Map<string, Promise<void>>();

  const enqueue = (ctx: AgentContext & { conversationId: string }, trigger: PassTrigger): void => {
    const id = ctx.conversationId;
    const previous = tails.get(id) ?? Promise.resolve();
    const work = previous
      .then(() => opts.runPass(ctx, trigger))
      // Unreachable by contract; present so the queue can never wedge on a
      // rejection and a detached promise can never be unhandled.
      .catch(() => undefined)
      .finally(() => {
        if (tails.get(id) === work) tails.delete(id);
      });
    tails.set(id, work);
    opts.onDetached?.(work);
  };

  const clearTimer = (state: ConversationState): void => {
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
  };

  return {
    onTurnEnd(ctx, payload) {
      // Only a completed ASSISTANT turn ends an exchange. Tool turns and
      // heartbeats (no role) are not a reply the person has read.
      if (payload?.role !== 'assistant') return;
      const id = ctx.conversationId;
      if (typeof id !== 'string' || id === '') return;
      const convCtx = ctx as AgentContext & { conversationId: string };

      let state = states.get(id);
      if (state === undefined) {
        state = { ctx: convCtx, timer: undefined, userTurns: 0 };
        states.set(id, state);
      }
      state.ctx = convCtx;
      // One user message can produce several assistant turn-ends (a long
      // answer split across turns). The host mints one `reqId` per user
      // message, so a NEW reqId is a new completed user turn. Without one,
      // every assistant turn counts: an early pass is harmless, a missed one
      // is not.
      const reqId = typeof payload.reqId === 'string' && payload.reqId !== '' ? payload.reqId : undefined;
      if (reqId === undefined || reqId !== state.lastReqId) state.userTurns += 1;
      if (reqId !== undefined) state.lastReqId = reqId;

      clearTimer(state);
      if (state.userTurns >= opts.everyUserTurns) {
        state.userTurns = 0;
        enqueue(convCtx, 'turns');
        return;
      }
      const armed = state;
      armed.timer = setTimeout(() => {
        armed.timer = undefined;
        armed.userTurns = 0;
        enqueue(armed.ctx as AgentContext & { conversationId: string }, 'idle');
      }, opts.idleMs);
      // A pending idle pass must never keep the process alive at shutdown.
      armed.timer.unref?.();
    },

    onChatEnd(ctx) {
      const state = states.get(ctx.conversationId);
      if (state !== undefined) clearTimer(state);
      states.delete(ctx.conversationId);
      enqueue(ctx, 'chat-end');
    },

    shutdown() {
      for (const state of states.values()) clearTimer(state);
      states.clear();
    },
  };
}

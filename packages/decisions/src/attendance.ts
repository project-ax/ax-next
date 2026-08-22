/**
 * Attendance: is anyone actually going to answer this?
 *
 * It decides which side runs an approved call. `attended` means the agent is
 * still warm and re-issues its own call; `unattended` means the turn ended and
 * the host replays the recorded one (AW-5). Getting it wrong in one direction
 * is recoverable and in the other is not, which is what shapes this file.
 *
 * WHY THE CONVERSATION AND NOT THE CONTEXT. AW-4 derived attendance from
 * `ctx.source === 'routine'`, which answers "was this a scheduled fire". That
 * is a different question with the same answer today and a different one
 * tomorrow: attendance is a property of the CHANNEL that opened the
 * conversation, so the day a Slack channel plugin exists it adds a channel,
 * not a new attendance value. `origin` is that channel.
 *
 * WHY IT FAILS TO `unattended`. The two mistakes are not symmetric:
 *
 *   - unattended misread as attended: the host never replays, and the decision
 *     waits for a warm agent that is already gone. Nothing runs, ever, and
 *     nothing says so.
 *   - attended misread as unattended: the host replays the recorded call
 *     itself. The call still happens, exactly as the person approved it — the
 *     agent just does not get to narrate it.
 *
 * So every unknown answer — no conversation, a conversation nobody can read, a
 * conversations store that is not even loaded — is `unattended`.
 */
import type { AgentContext, HookBus } from '@ax/core';
import { PLUGIN_NAME } from './pre-call.js';
import type { Attendance } from './types.js';

/**
 * The hook this reads. Named once: it appears in the manifest's
 * `optionalCalls`, in the `hasService` guard, and in the call itself, and
 * three copies of a hook name is how they stop agreeing.
 */
export const CONVERSATION_METADATA_HOOK = 'conversations:get-metadata';

/**
 * The fields we need off the conversation. A structural mirror of
 * `@ax/conversations`' `GetMetadataOutput` rather than an import (invariant 2)
 * — and deliberately only the two fields, so this file cannot start depending
 * on the rest of that projection.
 */
interface ConversationChannel {
  origin?: unknown;
  activeSessionId?: unknown;
}

export interface ConversationLookup {
  origin: 'web' | 'routine';
  activeSessionId: string | null;
}

/**
 * Read the conversation's channel + live session in ONE indexed row read.
 *
 * `conversations:get-metadata` and not `conversations:get`: the latter projects
 * the whole display-event log and reconstructs attachment blocks on its way to
 * the same two fields, and this read rides the `tool:pre-call` 10-second
 * ceiling. A gate that gets slower as a conversation gets longer is a gate that
 * eventually denies.
 *
 * Returns `null` for every "we do not know" — an absent store, an unreadable
 * row, a thrown call. The caller turns that into `unattended`.
 */
export async function conversationChannel(
  bus: HookBus,
  ctx: AgentContext,
  conversationId: string,
): Promise<ConversationLookup | null> {
  if (conversationId.length === 0) return null;
  if (!bus.hasService(CONVERSATION_METADATA_HOOK)) return null;
  try {
    const md = await bus.call<
      { conversationId: string; userId: string },
      ConversationChannel
    >(CONVERSATION_METADATA_HOOK, ctx, { conversationId, userId: ctx.userId });
    return {
      // Narrowed, not cast. An older producer that predates the field sends
      // nothing, and `'web'` — attended — would be the WRONG default for a
      // value we were not told: see the asymmetry at the top of this file.
      origin: md.origin === 'routine' || md.origin === 'web' ? md.origin : 'routine',
      activeSessionId:
        typeof md.activeSessionId === 'string' && md.activeSessionId.length > 0
          ? md.activeSessionId
          : null,
    };
  } catch (err) {
    // `not-found` (a conversation that was deleted, or one belonging to
    // somebody else) lands here alongside a genuine failure, and both mean the
    // same thing: we cannot say anyone is watching.
    ctx.logger.warn('decision_conversation_lookup_failed', {
      plugin: PLUGIN_NAME,
      conversationId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

/**
 * `web` → attended, `routine` → unattended, everything else → unattended.
 */
export async function attendanceFor(
  bus: HookBus,
  ctx: AgentContext,
  conversationId: string,
): Promise<Attendance> {
  const channel = await conversationChannel(bus, ctx, conversationId);
  if (channel === null) return 'unattended';
  return channel.origin === 'web' ? 'attended' : 'unattended';
}

/** Bind the bus once so the pre-call subscriber keeps its one-argument seam. */
export function createAttendanceResolver(
  bus: HookBus,
): (ctx: AgentContext) => Promise<Attendance> {
  return async (ctx) => attendanceFor(bus, ctx, ctx.conversationId ?? '');
}

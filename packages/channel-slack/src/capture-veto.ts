import {
  MEMORY_PRE_CAPTURE_HOOK,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  MemoryPreCapturePayloadSchema,
  reject,
  type AgentContext,
  type HookBus,
  type Rejection,
} from '@ax/core';
import type { ChannelStore } from './channel-store.js';
import { logCode } from './log-code.js';

// ---------------------------------------------------------------------------
// TASK-1094 decisions row Q4: a connected channel's "Let the agent remember
// this channel" switch. Memory asks `memory:pre-capture { conversationId }`
// before every extraction pass and every `memory_note`; this answers it for
// the conversations of Slack channel threads. The shape is @ax/routines'
// `taskCaptureVeto` (routines/src/capture.ts), copied rather than imported:
// plugins don't import each other (invariant 2).
// ---------------------------------------------------------------------------

/** The subscriber's name on the bus. Memory logs it as the plugin that refused. */
export const CAPTURE_VETO_KEY = '@ax/channel-slack/capture-veto';

/**
 * How long the capture check may take before it refuses anyway: half of
 * memory's own bound (`MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS`, in core). A
 * subscriber past that bound is skipped by the bus and the pass goes on, so
 * the answer has to arrive first for a slow lookup to fail closed.
 */
export const CAPTURE_CHECK_DEADLINE_MS = MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS / 2;

/** What a pass on one conversation needs answered: is it a channel thread memory must stay out of? */
async function keptOut(
  channels: Pick<ChannelStore, 'getThread' | 'get'>,
  conversationId: string,
): Promise<boolean> {
  const thread = await channels.getThread(conversationId);
  // Not a channel thread (a web chat, a DM): not this plugin's to refuse.
  if (thread === null) return false;
  // A turn ran while the switch was off. Sticky, whatever the switch says now.
  if (thread.notRemembered !== false) return true;
  const binding = await channels.get(thread.installId, thread.channelId);
  // Disconnected (or its install removed), connected to another agent since,
  // or switched off now.
  return binding === null || binding.agentId !== thread.agentId || binding.remember !== true;
}

/**
 * The `memory:pre-capture` veto. Keyed on the conversation, never on who is
 * asking: a pass under any source, user or agent on a kept-out thread is
 * refused, because memory leaves its cursor where a refusal stopped it and
 * the next pass that got through would read every turn the refusals skipped.
 * It asks about the host-set `ctx.conversationId` and, when an earlier
 * subscriber rewrote the payload to name another, that one too: a kept-out
 * thread under either is refused.
 *
 * A conversation channel-slack never recorded gets no opinion. One it did is
 * refused when any turn in it started while the channel's switch was off, or
 * when the channel is no longer connected to its agent, or when the switch is
 * off now.
 *
 * Fails closed: a lookup that throws, or takes longer than `deadlineMs`,
 * refuses too. A refusal costs memory nothing but time (the cursor stays put,
 * so a later pass reads those turns), which is why refusing an ordinary
 * chat's pass while the database is slow is the cheap mistake. Logs a
 * failure by its code alone.
 */
export async function channelCaptureVeto(
  channels: Pick<ChannelStore, 'getThread' | 'get'>,
  ctx: AgentContext,
  payload: unknown,
  deadlineMs = CAPTURE_CHECK_DEADLINE_MS,
): Promise<Rejection | undefined> {
  const refusal = reject({ reason: 'channel-not-remembered' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Read inside the try: a payload an earlier subscriber rewrote into
    // something that throws when read is refused, not skipped by the bus.
    const parsed = MemoryPreCapturePayloadSchema.safeParse(payload);
    const ids = new Set<string>();
    if (ctx.conversationId !== undefined && ctx.conversationId.length > 0) ids.add(ctx.conversationId);
    if (parsed.success) ids.add(parsed.data.conversationId);
    if (ids.size === 0) return undefined;
    const deadline = new Promise<never>((_resolve, rejectDeadline) => {
      timer = setTimeout(
        () => rejectDeadline(Object.assign(new Error(`capture check took longer than ${deadlineMs} ms`), { code: 'timeout' })),
        deadlineMs,
      );
      timer.unref?.();
    });
    const answers = await Promise.race([
      Promise.all([...ids].map((conversationId) => keptOut(channels, conversationId))),
      deadline,
    ]);
    if (!answers.some(Boolean)) return undefined;
  } catch (err) {
    // Logged after the refusal is built: a logger that throws can't turn it into a skipped subscriber.
    try {
      ctx.logger.warn('slack_capture_check_failed', { code: logCode(err) });
    } catch {
      // The refusal stands.
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return refusal;
}

/**
 * Subscribe the veto, under CAPTURE_VETO_KEY, in place of any an earlier run
 * of the plugin left on this bus: the veto outlives a shutdown on purpose
 * (plugin.ts says why), so a second init on the same bus replaces it rather
 * than leaving a stale one answering from a closed database. Returns the
 * unsubscribe, which the plugin calls only when its init fails.
 */
export function subscribeCaptureVeto(
  bus: HookBus,
  channels: Pick<ChannelStore, 'getThread' | 'get'>,
): () => void {
  bus.unsubscribe(MEMORY_PRE_CAPTURE_HOOK, CAPTURE_VETO_KEY);
  bus.subscribe<unknown>(MEMORY_PRE_CAPTURE_HOOK, CAPTURE_VETO_KEY, (ctx, payload) =>
    channelCaptureVeto(channels, ctx, payload),
  );
  return () => {
    bus.unsubscribe(MEMORY_PRE_CAPTURE_HOOK, CAPTURE_VETO_KEY);
  };
}

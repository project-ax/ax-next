import {
  MEMORY_PRE_CAPTURE_HOOK,
  MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  MemoryPreCapturePayloadSchema,
  reject,
  type AgentContext,
  type HookBus,
  type MemoryPreCapturePayload,
  type Rejection,
} from '@ax/core';
import type { ChannelStore } from './channel-store.js';
import { logCode } from './log-code.js';

// ---------------------------------------------------------------------------
// TASK-1094: memory learns from what members say in a connected channel,
// public or private (a private one is remembered like any other since
// TASK-1203, design §4c), and never from what outsiders say (PR B review
// F1). Memory asks `memory:pre-capture { conversationId }` before every
// extraction pass and every `memory_note`; this answers it for the
// conversations of Slack channel threads. The shape is @ax/routines'
// `taskCaptureVeto` (routines/src/capture.ts), copied rather than imported:
// plugins don't import each other (invariant 2).
//
// TASK-1146: the answer also tells memory who is speaking. Each member turn
// records the names its sender label showed on the thread (channel-store.ts
// `speakerNames`); a thread this lets memory learn from is answered with
// them, added after any an earlier subscriber put in the payload, and in a
// turn that isn't private memory stores no statement whose subject is made
// of them. A name is a fact memory won't file under it, so this never drops
// one: past what one answer may carry, or on a payload it can't read, it
// refuses instead. The names are never logged.
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

/**
 * Why memory must stay out of a channel thread, most decisive first (the
 * order a pass asking about two refused threads reports them in):
 *   - `channel-external-turn`: outsiders' turns run in it. Memory never
 *     learns from them (decisions shard, PR B review F1): a team agent
 *     recalls shared memory in every turn, members' private chats included,
 *     so an outsider's words, once learned, would come back as facts with a
 *     member's authority. Reversible: this one rule.
 *   - `channel-not-remembered`: the thread was marked before TASK-1203 (a
 *     turn while its channel was private, TASK-1188, or switched off,
 *     TASK-1202), or the channel is no longer connected to the thread's
 *     agent.
 */
const REFUSALS = ['channel-external-turn', 'channel-not-remembered'] as const;
type Refusal = (typeof REFUSALS)[number];

/** Why memory must stay out of one conversation, if it must; and if not, who is speaking in it. */
interface Lookup {
  refusal: Refusal | null;
  speakerNames: readonly string[];
}

const NO_NAMES: readonly string[] = Object.freeze([]);

/**
 * What a pass on one conversation needs answered: is it a channel thread
 * memory must stay out of, and why; and if memory may learn from it, who is
 * speaking in it. Names only ever come from a thread it doesn't refuse; a
 * conversation it never recorded has none.
 */
async function lookup(channels: Pick<ChannelStore, 'getThread' | 'get'>, conversationId: string): Promise<Lookup> {
  const thread = await channels.getThread(conversationId);
  // Not a channel thread (a web chat, a DM): not this plugin's to refuse, nor its names to give.
  if (thread === null) return { refusal: null, speakerNames: NO_NAMES };
  // Outsiders' turns run here: never. Their thread records no names
  // (channel-store.ts), so lifting this refusal means recording outsiders'
  // names first, or memory would file what they say under them.
  if (thread.external !== false) return { refusal: 'channel-external-turn', speakerNames: NO_NAMES };
  // Marked before TASK-1203: a turn ran while the channel was private
  // (TASK-1188), or switched off (TASK-1202). Sticky, whatever the channel
  // says now: memory's cursor already skipped those turns, so letting the
  // thread in would have its next pass read what was said under "this isn't
  // remembered".
  if (thread.notRemembered !== false) return { refusal: 'channel-not-remembered', speakerNames: NO_NAMES };
  const binding = await channels.get(thread.installId, thread.channelId);
  // Disconnected (or its install removed), or connected to another agent
  // since. Public or private, a channel connected to the thread's agent lets
  // memory in (TASK-1203, design §4c).
  if (binding === null || binding.agentId !== thread.agentId) {
    return { refusal: 'channel-not-remembered', speakerNames: NO_NAMES };
  }
  // As stored, with no default: a row that has no names list throws when
  // read below, and the check refuses, rather than answer "nobody is
  // speaking" for a thread whose speakers it can't tell.
  return { refusal: null, speakerNames: thread.speakerNames };
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
 * refused when outsiders' turns run in it (`channel-external-turn`), and a
 * member's when it was marked before TASK-1203, or when the channel is no
 * longer connected to its agent (`channel-not-remembered`). A private
 * channel is remembered like any other (TASK-1203, design §4c).
 *
 * A member's thread it lets through is answered with the names that
 * member's turns were labelled with (TASK-1146): the payload it was given,
 * every name an earlier subscriber added still in it, and its own appended
 * (from each id it asked about, in that order), each name once. No names of
 * its own (a thread from before TASK-1146, or a conversation it never
 * recorded): no opinion, and the payload goes on as it came. It never drops
 * a name, since memory could file facts under a dropped one, so it refuses
 * instead:
 *   - `capture-payload-unreadable`: it has names to add, but the payload an
 *     earlier subscriber left doesn't parse, so it can't add them without
 *     answering over that subscriber's;
 *   - `speaker-names-over-cap`: with an earlier subscriber's, the names come
 *     to more than one answer may carry
 *     (`MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX`). Its own never do alone: a
 *     thread keeps at most half that (limits.ts `THREAD_SPEAKER_NAMES_MAX`),
 *     and it asks about two threads at most.
 *
 * Fails closed: a lookup that throws, or takes longer than `deadlineMs`,
 * refuses too, as `capture-check-failed` (never a channel's reason). So does
 * a thread row that has no names list at all: it is never read as one with
 * no names. For an extraction pass a refusal costs nothing but time (the
 * cursor stays put, so a later pass reads those turns), which is why
 * refusing an ordinary chat's pass while the database is slow is the cheap
 * mistake; a `memory_note` refused then is not saved. Logs a failure by its
 * code alone, and never a name.
 */
export async function channelCaptureVeto(
  channels: Pick<ChannelStore, 'getThread' | 'get'>,
  ctx: AgentContext,
  payload: unknown,
  deadlineMs = CAPTURE_CHECK_DEADLINE_MS,
): Promise<Rejection | MemoryPreCapturePayload | undefined> {
  /**
   * The answer when the check itself fails: a refusal, saying only that. A
   * slow or not-ready store refuses every conversation's pass (a web chat's
   * too), so it must not claim a channel decided it.
   */
  const failed = reject({ reason: 'capture-check-failed' });
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
    const found = await Promise.race([
      Promise.all([...ids].map((conversationId) => lookup(channels, conversationId))),
      deadline,
    ]);
    const reason = REFUSALS.find((r) => found.some((f) => f.refusal === r));
    if (reason !== undefined) return reject({ reason });
    const own: string[] = [];
    // Spread, not flatMap: a lookup without a names list throws here, inside the try.
    for (const f of found) own.push(...f.speakerNames);
    if (own.length === 0) return undefined;
    if (!parsed.success) return reject({ reason: 'capture-payload-unreadable' });
    const speakerNames = [...new Set([...(parsed.data.speakerNames ?? []), ...own])];
    if (speakerNames.length > MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX) return reject({ reason: 'speaker-names-over-cap' });
    // What it was given, keys it doesn't know included, with the names added.
    return { ...(payload as Record<string, unknown>), ...parsed.data, speakerNames };
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
  return failed;
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

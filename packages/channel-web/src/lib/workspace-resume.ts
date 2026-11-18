/**
 * Picking a stopped agent back up after a capability grant (TASK-374).
 *
 * WHAT ACTUALLY HAPPENS when an agent asks for a skill or a connector, because
 * the word "parked" hides it — and the export below keeps that word only
 * because it is what the card, the board and every conversation about this call
 * it, not because it is accurate. `request_capability` fires
 * `chat:permission-request` and returns to the model, the model says it has
 * asked, and the TURN ENDS — a `done` frame, `chat:turn-end`, the lot. Nothing
 * is suspended server-side and nothing is waiting to be attached to. Answering
 * the grant attaches the skill and restarts the warm session, so the capability
 * is there for the next turn and there is no current turn to give it to.
 *
 * "A moment after the card" is not "before Connect is live": the turn normally
 * ends a moment after the card, but Connect is enabled while it is still
 * running. So the resume first follows that reply to its end (up to
 * `RESUME_WAIT_MS`) and only then re-sends. A re-send into the busy session
 * would restart the session under the reply and cut it off: TASK-1127 marks
 * the session, and routing retires a marked session even mid-turn (TASK-1150).
 *
 * That is why this re-POSTs rather than re-attaching. The evidence was in the
 * deleted chat UI, which had both mechanisms and picked deliberately between
 * them: a decision approval called `continuationActions` → `chat.resumeStream()`,
 * whose own comment said "this is a resume, never a re-POST: the turn is
 * already running server-side"; a capability grant called `resumeActions` →
 * `chat.regenerate()`, which re-POSTed the last user turn. We are the second
 * case, so we do the second thing.
 *
 * WHY NOT A REGISTER/CALL BRIDGE. The now-deleted chat UI used exactly that
 * shape for `resumeActions` and for the agent-bootstrap kickoff (TASK-249):
 * a register/call pair around the assistant-ui runtime, live only while a
 * `useChatThreadRuntime` was mounted. The workspace mounts no such runtime,
 * so a bridge like that would be a no-op that looks exactly like wiring. This
 * is the workspace's own route to the same outcome, over the workspace's own
 * wire, importing nothing from the chat tree.
 *
 * WHAT A RE-POST COSTS, stated rather than hidden: the person's message appears
 * in the transcript a second time, because `POST /api/chat/messages` appends
 * the user turn it is given. Chat's `regenerate()` always did exactly this —
 * its `lib/transport.ts` POSTed `messages[messages.length - 1]`, which after
 * assistant-ui dropped the trailing assistant message was the previous user
 * turn. So this was parity with the shipped surface, not a new wart, and the
 * alternative (a server-side resume that re-invokes without appending) would
 * have been a change to the chat wire that neither card owns.
 */
import { ConversationReadOnlyError } from './conversation-read-only';
import { workspaceApi, type ThreadMessage } from './workspace-api';

/**
 * Why a resume did not happen. Every reason but `read-only` gets the same
 * sentence; see `grant-copy`.
 */
export type ResumeFailure =
  /** The conversation read failed, so we never learned what to re-send. */
  | 'thread-unreadable'
  /** We read it and there is no user turn in it to re-issue. */
  | 'nothing-to-resume'
  /** We knew what to send and the POST refused it. */
  | 'send-failed'
  /**
   * TASK-1093 — the POST was refused because the conversation is a Slack DM
   * thread, which takes its messages in Slack. Its own reason, because the
   * advice differs: messaging the agent HERE is refused too, so the row says
   * to reply in Slack. ONLY a Slack thread: the route refuses a routine's
   * conversation the same way, but there is nowhere for the person to go and
   * reply to a routine run, so that refusal stays `send-failed` and keeps its
   * sentence.
   */
  | 'read-only'
  /**
   * TASK-1150 — a reply was, or may still be, being written in that
   * conversation, so nothing was sent: it was still going when we stopped
   * waiting (`RESUME_WAIT_MS`); or the wait ended without proof and a re-read
   * showed a live reply; or the re-read itself failed; or the followed reply
   * ended but a different one (a continuation) is now live. Re-sending would
   * have replaced it.
   */
  | 'still-running';

/**
 * What a grant's `onGranted` reports back to its row: `true` the agent picked
 * up again; `false` it did not, and a message to it here will; `'reply-elsewhere'`
 * it did not, and its conversation is a Slack thread that takes messages only
 * in Slack; `'reply-when-done'` it was still working on a reply, so we left it
 * alone, and a message once that reply is done will pick the connection up.
 */
export type GrantResume = boolean | 'reply-elsewhere' | 'reply-when-done';

/**
 * How long the resume follows a reply that is still running before it gives up
 * (TASK-1150). Bounded for a stale binding, whose stream would sit on
 * keepalives; stopping at the bound is the side that never loses a reply.
 */
export const RESUME_WAIT_MS = 60_000;

/** What the row is told for a resume that did not happen. */
export function grantResumeFor(reason: ResumeFailure): GrantResume {
  if (reason === 'read-only') return 'reply-elsewhere';
  if (reason === 'still-running') return 'reply-when-done';
  return false;
}

export type ResumeResult =
  | {
      resumed: true;
      /** The re-issued turn, to stream if a view is on screen to stream it. */
      reqId: string;
      conversationId: string;
      /** The text we re-sent — the same text the person wrote the first time. */
      text: string;
    }
  | { resumed: false; reason: ResumeFailure };

/**
 * The last thing the PERSON said, which is the turn that stopped.
 *
 * Read off the durable thread rather than out of component state, and that is
 * the whole reason this is a function on a thread and not a field on a view.
 * `AgentView` does hold what it last sent — in `sent` — but it clears it on
 * `onDone`, and `onDone` is precisely what fires when the asking turn ends. By
 * the time anyone can answer the grant, that state is usually `null`. (The card
 * body for this task says the view "already holds the last sent text"; it does
 * not, and building on that would have produced a resume that worked only for a
 * grant answered before the turn finished, which does happen: Connect is live
 * mid-turn (TASK-1150).)
 *
 * Trailing `agent` messages are skipped, not treated as a stop: the asking turn
 * always ends with the agent saying it has asked, so the message we want is
 * never the last one in the thread.
 *
 * An empty or whitespace-only turn is not re-sendable — `sendMessage` would
 * post an empty text block — so it reads as "nothing to resume" rather than as
 * a turn we then fail to send.
 */
export function lastUserText(thread: readonly ThreadMessage[]): string | null {
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const m = thread[i];
    if (m === undefined || m.kind !== 'user') continue;
    const text = m.text.trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/**
 * How following a reply ended. Only `ended` is proof the reply is over.
 */
type TurnEnd = 'ended' | 'unproven' | 'timeout';

/**
 * Follow a reply that is still being written until it ends. `'ended'` only on
 * `onDone` (a `done` frame, or a resume 404: the host no longer runs that turn).
 * `'unproven'` for every other way the wait stopped: `onError` fires for a turn's
 * error frame AND for a failed first open, a 401/403/429/5xx or spent
 * reconnects, and the callback carries nothing to tell them apart, so none of
 * them proves the reply ended; a stream that returns with no terminal frame or
 * rejects is no proof either. `'timeout'` when it was still going at
 * `timeoutMs`. Aborts its stream either way and never rejects.
 */
function waitForTurnEnd(reqId: string, timeoutMs: number): Promise<TurnEnd> {
  return new Promise<TurnEnd>((resolve) => {
    const controller = new AbortController();
    const finish = (end: TurnEnd): void => {
      clearTimeout(timer);
      controller.abort();
      resolve(end);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    workspaceApi
      .streamReply(reqId, {
        resume: true,
        signal: controller.signal,
        onText: () => undefined,
        onDone: () => finish('ended'),
        onError: () => finish('unproven'),
      })
      .then(
        // Returned without a terminal frame (closed under us), or a reader bug:
        // `finish` is idempotent, so a stream we aborted ourselves changes nothing.
        () => finish('unproven'),
        () => finish('unproven'),
      );
  });
}

/**
 * After a wait, is a reply still live in the conversation? Any live reply
 * counts, not only the one we followed: a re-send would retire its session just
 * the same. A failed read cannot rule one out, so it counts.
 *
 * `followed` is the reply we waited on and saw end. Its binding may not be
 * cleared yet when we re-read, so it alone does not count; a continuation
 * approved during the wait binds a DIFFERENT request and does. (After an
 * `unproven` wait nothing proved the followed reply over, so `followed` is
 * left out and any live reqId counts, the followed one included.)
 */
async function replyStillLive(
  agentId: string,
  conversationId: string,
  followed?: string,
): Promise<boolean> {
  try {
    const detail = await workspaceApi.agent(agentId, conversationId);
    const live = detail.liveReqId;
    return typeof live === 'string' && live.length > 0 && live !== followed;
  } catch (e) {
    console.warn('[workspace] could not re-check for a running reply', e);
    return true;
  }
}

/**
 * Re-issue the turn the grant interrupted, in the conversation it was raised
 * on.
 *
 * `conversationId` is the grant's own — never "the agent's current
 * conversation" — because a grant answered from Today may belong to an agent
 * nobody is looking at, whose current conversation may since have moved on.
 * The row carries the id for exactly this reason (see `workspace-grant-store`),
 * and the same id is what the decision POST just used, so the capability and
 * the re-issued turn cannot end up pointing at two different threads.
 *
 * NEVER THROWS. Every caller is a click handler on a row whose grant has
 * ALREADY been applied by the time we get here — the capability landed, and the
 * only question left is whether the agent picked up again. A rejection here
 * would read to the caller as "the grant failed", which is the one thing it
 * did not do. So each failure comes back as a reason the row can say out loud.
 */
export async function resumeParkedTurn(target: {
  agentId: string;
  conversationId: string;
}): Promise<ResumeResult> {
  const { agentId, conversationId } = target;
  let text: string | null;
  let origin: string | null | undefined;
  let liveReqId: string | null | undefined;
  try {
    const detail = await workspaceApi.agent(agentId, conversationId);
    text = lastUserText(detail.thread);
    origin = detail.origin;
    liveReqId = detail.liveReqId;
  } catch (e) {
    // The operator's half. The reader's half is the row's sentence.
    console.warn('[workspace] could not read the turn to resume', e);
    return { resumed: false, reason: 'thread-unreadable' };
  }
  if (text === null) return { resumed: false, reason: 'nothing-to-resume' };
  // A reply is still being written here. Let it finish; re-sending now would
  // restart the session under it. Still going at the bound: send nothing.
  if (typeof liveReqId === 'string' && liveReqId.length > 0) {
    const end = await waitForTurnEnd(liveReqId, RESUME_WAIT_MS);
    if (end === 'timeout') return { resumed: false, reason: 'still-running' };
    // Ask the host once before re-sending, in both cases. Not seeing the end is
    // not the end. And seeing it end says nothing of a continuation approved
    // during the wait, which binds its own request and runs after this one's
    // `done`: only a reqId other than the one we followed counts there. A failed
    // read withholds on both, for the same reason: stopping never loses a reply.
    const followed = end === 'ended' ? liveReqId : undefined;
    if (await replyStillLive(agentId, conversationId, followed)) {
      return { resumed: false, reason: 'still-running' };
    }
  }
  try {
    const { reqId, conversationId: landed } = await workspaceApi.sendMessage({
      agentId,
      conversationId,
      text,
    });
    return { resumed: true, reqId, conversationId: landed, text };
  } catch (e) {
    console.warn('[workspace] could not re-send the turn to resume', e);
    // Read-only AND Slack. The detail we just read names the origin; a routine
    // or an unnamed origin keeps the plain refused-send sentence.
    const inSlack = e instanceof ConversationReadOnlyError && origin === 'slack';
    return { resumed: false, reason: inSlack ? 'read-only' : 'send-failed' };
  }
}

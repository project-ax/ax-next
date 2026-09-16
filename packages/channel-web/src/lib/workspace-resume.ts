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
 * the grant attaches the skill and RETIRES the warm session, so the capability
 * is there for the next turn and there is no current turn to give it to.
 *
 * That is why this re-POSTs rather than re-attaching. The evidence is in chat,
 * which has both mechanisms and picks deliberately between them: a decision
 * approval calls `continuationActions` → `chat.resumeStream()`, whose own
 * comment says "this is a resume, never a re-POST: the turn is already running
 * server-side"; a capability grant calls `resumeActions` → `chat.regenerate()`,
 * which re-POSTs the last user turn. We are the second case, so we do the
 * second thing.
 *
 * WHY NOT `lib/resume-actions.ts` — the module chat uses. It is a register/call
 * pair around the assistant-ui runtime's `regenerate`, and the only thing that
 * ever registers is `useChatThreadRuntime`, which assistant-ui calls solely
 * under an `AssistantRuntimeProvider`. The workspace branch of `App.tsx`
 * deliberately mounts none, so `continueAfterGrant()` there is a no-op that
 * looks exactly like wiring — the same trap `bootstrapKickoff` laid for
 * TASK-249. This is the workspace's own route to the same outcome, over the
 * workspace's own wire, importing nothing from the chat tree.
 *
 * WHAT A RE-POST COSTS, stated rather than hidden: the person's message appears
 * in the transcript a second time, because `POST /api/chat/messages` appends
 * the user turn it is given. Chat's `regenerate()` has always done exactly
 * this — `lib/transport.ts` POSTs `messages[messages.length - 1]`, which after
 * assistant-ui drops the trailing assistant message IS the previous user turn.
 * So this is parity with the shipped surface, not a new wart, and the
 * alternative (a server-side resume that re-invokes without appending) is a
 * change to the chat wire that both surfaces would share and neither card owns.
 */
import { workspaceApi, type ThreadMessage } from './workspace-api';

/** Why a resume did not happen. Each one gets the same sentence; see `grant-copy`. */
export type ResumeFailure =
  /** The conversation read failed, so we never learned what to re-send. */
  | 'thread-unreadable'
  /** We read it and there is no user turn in it to re-issue. */
  | 'nothing-to-resume'
  /** We knew what to send and the POST refused it. */
  | 'send-failed';

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
 * the time anyone can answer the grant, that state is `null`. (The card body
 * for this task says the view "already holds the last sent text"; it does not,
 * and building on that would have produced a resume that worked only for a
 * grant answered before the turn finished — which is never.)
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
  try {
    const detail = await workspaceApi.agent(agentId, conversationId);
    text = lastUserText(detail.thread);
  } catch (e) {
    // The operator's half. The reader's half is the row's sentence.
    console.warn('[workspace] could not read the turn to resume', e);
    return { resumed: false, reason: 'thread-unreadable' };
  }
  if (text === null) return { resumed: false, reason: 'nothing-to-resume' };
  try {
    const { reqId, conversationId: landed } = await workspaceApi.sendMessage({
      agentId,
      conversationId,
      text,
    });
    return { resumed: true, reqId, conversationId: landed, text };
  } catch (e) {
    console.warn('[workspace] could not re-send the turn to resume', e);
    return { resumed: false, reason: 'send-failed' };
  }
}

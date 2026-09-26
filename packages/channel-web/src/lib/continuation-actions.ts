/**
 * Continuation-stream seam for post-approval turns (TASK-278, TASK-542).
 *
 * After an approval wakes a warm agent, the continuation runs as a
 * host-initiated turn under a fresh reqId the approve response hands back as
 * `streamReqId`. The decision hooks own the approval but not the thread that
 * renders it, so this module is the rendezvous — the same module-ref posture
 * as `resume-actions.ts` (the thread registers, the approval triggers).
 *
 * ONE PATH, TWO RENDERERS. Chat's runtime (`lib/runtime.tsx`) and the agent
 * workspace's thread (`components/workspace/AgentView.tsx`) both register
 * here, and both surfaces' decision queues hand their approvals to
 * `continueApprovedTurn`. What each renderer DOES with a kick differs — chat
 * calls `chat.resumeStream()` and its transport takes the staged id; the
 * workspace takes the id itself and streams it over `workspaceApi.streamReply`
 * — but the rule for WHEN to attach is written once, here. That is why this
 * file lives outside the chat tree: TASK-360 deletes chat, and the workspace
 * keeps using this.
 *
 * The halves, deliberately separate:
 *
 *   - `continueApprovedTurn(decision, streamReqId)` — the decision queue's
 *     `onDecisionApproved`. Attaches ONLY when there is a turn to watch and
 *     the decision belongs to the conversation the registered thread has open
 *     at SETTLE time (the approve POST is async; the reader may have moved).
 *     Quiet when no thread is registered: approving from a surface with no
 *     open thread (the workspace's Today) is ordinary, and the turn still
 *     renders on the next read.
 *   - `resumeContinuation(reqId)` — stages the id and kicks the registered
 *     resume. A no-op for junk ids, and a no-op (with a warn) when nothing is
 *     registered.
 *   - `takePendingContinuation()` — consumed ONCE by whichever renderer the
 *     kick reached. Consume-once so a stale id can never be picked up by a
 *     later, unrelated resume: one approval, one attach attempt.
 */
interface Registrant {
  resume: () => void;
  /** The conversation this thread has open right now, or null (welcome state). */
  openConversation: () => string | null;
}

let registrant: Registrant | null = null;
let pendingReqId: string | null = null;

function resumeContinuation(reqId: string): void {
  if (typeof reqId !== 'string' || reqId.length === 0) return;
  if (registrant === null) {
    console.warn(
      '[continuation] an approval carried a live continuation turn, but no thread is mounted to render it',
    );
    return;
  }
  pendingReqId = reqId;
  try {
    registrant.resume();
  } catch {
    // The kick must never take the approval receipt down with it: this
    // runs inside the approve POST's settle path, where a throw would
    // surface as a failure notice over a successful approval. Unstage, so
    // a later unrelated resume cannot pick up this id either.
    pendingReqId = null;
    console.warn('[continuation] the thread refused the resume kick');
  }
}

export const continuationActions = {
  /**
   * A thread wires its resume here on mount. Latest wins. Returns the
   * unregister, which clears the slot only if it still holds THIS
   * registration — so an unmounting thread cannot evict the one that
   * replaced it.
   */
  registerResume(resume: () => void, openConversation: () => string | null): () => void {
    const mine: Registrant = { resume, openConversation };
    registrant = mine;
    return () => {
      if (registrant === mine) registrant = null;
    };
  },
  /**
   * The decision queue's `onDecisionApproved`, for both surfaces. A null
   * `streamReqId` (no turn runs to watch), no registered thread, a thread on
   * the welcome state, or a decision from another conversation attaches
   * nothing: the receipts stand as they did before.
   */
  continueApprovedTurn(decision: { conversationId: string }, streamReqId: string | null): void {
    if (streamReqId === null || registrant === null) return;
    const open = registrant.openConversation();
    if (open === null || decision.conversationId !== open) return;
    resumeContinuation(streamReqId);
  },
  /**
   * Stage `reqId` for the renderer and kick the resume. The renderer picks
   * the id up with `takePendingContinuation` as part of the resume.
   */
  resumeContinuation,
  /** The renderer reads (and clears) the staged id. */
  takePendingContinuation(): string | null {
    const id = pendingReqId;
    pendingReqId = null;
    return id;
  },
  /** Test seam. */
  reset(): void {
    registrant = null;
    pendingReqId = null;
  },
};

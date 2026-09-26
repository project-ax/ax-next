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
 *     at ATTACH time (the approve POST is async, and the attach may wait out
 *     the undo window — the reader may have moved either way). Quiet when no
 *     thread is registered: approving from a surface with no open thread (the
 *     workspace's Today) is ordinary, and the turn still renders on the next
 *     read.
 *   - `cancelApprovedTurn(decisionId)` — the decision queue's
 *     `onDecisionUndone`. Drops a deferred attach that has not fired yet.
 *
 * WHY THE ATTACH WAITS (TASK-574). On the attended path the host no longer
 * tells the warm agent at approve time: it holds the continuation until the
 * ten-second undo window closes, so an Undo inside the window cancels a turn
 * nothing has started. The approve answers that moment as `pendingUntil`
 * beside the `streamReqId`. Attaching at once would show "Thinking…" for the
 * whole window — and, after an Undo, forever, since nothing ever runs on that
 * id. So a future `pendingUntil` schedules the attach for then, keyed by the
 * decision id (one approval, one timer: a second approve settle for the same
 * row replaces it), and an Undo that the server accepted cancels it. A past,
 * absent or unparseable `pendingUntil` — a host predating TASK-574, or one
 * that delivered at once — attaches immediately, exactly as before. A
 * decision with no `id` cannot be cancelled by an Undo, so it attaches at
 * once too rather than scheduling a timer nothing could ever clear.
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
/** Deferred attaches (TASK-574), keyed by decision id. */
const deferred = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Attach now, if the gates hold NOW: a registered thread whose open
 * conversation is the decision's. Read at call time — for a deferred attach,
 * that is when the timer fires, not when the approve settled.
 */
function attachIfOpen(conversationId: string, streamReqId: string): void {
  if (registrant === null) return;
  const open = registrant.openConversation();
  if (open === null || conversationId !== open) return;
  resumeContinuation(streamReqId);
}

/** Milliseconds until `pendingUntil`, or 0 for past / absent / unparseable. */
function delayUntil(pendingUntil: string | null | undefined): number {
  if (typeof pendingUntil !== 'string') return 0;
  const at = Date.parse(pendingUntil);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, at - Date.now());
}

function clearDeferred(decisionId: string): void {
  const timer = deferred.get(decisionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  deferred.delete(decisionId);
}

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
   *
   * A future `pendingUntil` (TASK-574) defers the attach to then — see the
   * header — and the gates above are applied when it fires.
   */
  continueApprovedTurn(
    decision: { id?: string; conversationId: string; pendingUntil?: string | null },
    streamReqId: string | null,
  ): void {
    if (streamReqId === null) return;
    const id = decision.id;
    if (typeof id === 'string' && id.length > 0) {
      // A second settle for the same row replaces the earlier plan.
      clearDeferred(id);
      const wait = delayUntil(decision.pendingUntil);
      if (wait > 0) {
        const { conversationId } = decision;
        deferred.set(
          id,
          setTimeout(() => {
            deferred.delete(id);
            attachIfOpen(conversationId, streamReqId);
          }, wait),
        );
        return;
      }
    }
    attachIfOpen(decision.conversationId, streamReqId);
  },
  /**
   * The decision queue's `onDecisionUndone` (TASK-574): the server took the
   * approval back inside the window, so the deferred continuation will never
   * run. Drop its attach. A no-op when nothing is pending for `decisionId`.
   */
  cancelApprovedTurn(decisionId: string): void {
    clearDeferred(decisionId);
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
    for (const timer of deferred.values()) clearTimeout(timer);
    deferred.clear();
  },
};

/**
 * Continuation-stream seam for post-approval turns (TASK-278).
 *
 * After an approval wakes a warm agent, the continuation runs as a
 * host-initiated turn under a fresh reqId the approve response hands back as
 * `streamReqId`. The decision hooks own the approval but not the chat runtime,
 * so this module is the rendezvous — the same module-ref posture as
 * `resume-actions.ts` (the runtime registers, the card triggers).
 *
 * Two halves, deliberately separate:
 *
 *   - `resumeContinuation(reqId)` — called by the decision path after a
 *     successful approve on the OPEN thread. Stages the id and kicks the
 *     runtime's resume. A no-op for junk ids, and a no-op (with a warn) when
 *     no chat runtime registered — e.g. an approval from a surface with no
 *     live thread, where there is nothing to render into.
 *   - `takePendingContinuation()` — consumed ONCE by the transport's
 *     `reconnectToStream`. Consume-once so a stale id can never be picked up
 *     by a later, unrelated resume: one approval, one attach attempt.
 */
let resume: (() => void) | null = null;
let pendingReqId: string | null = null;

export const continuationActions = {
  /** Runtime wires its `chat.resumeStream` here on mount. Latest wins. */
  registerResume(fn: () => void): void {
    resume = fn;
  },
  /**
   * Stage `reqId` for the transport and kick the resume. The transport picks
   * the id up when the SDK calls `reconnectToStream` as part of the resume.
   */
  resumeContinuation(reqId: string): void {
    if (typeof reqId !== 'string' || reqId.length === 0) return;
    if (resume === null) {
      console.warn(
        '[continuation] an approval carried a live continuation turn, but no chat runtime is mounted to render it',
      );
      return;
    }
    pendingReqId = reqId;
    try {
      resume();
    } catch {
      // The kick must never take the approval receipt down with it: this
      // runs inside the approve POST's settle path, where a throw would
      // surface as a failure notice over a successful approval. Unstage, so
      // a later unrelated resume cannot pick up this id either.
      pendingReqId = null;
      console.warn('[continuation] the chat runtime refused the resume kick');
    }
  },
  /** Transport reads (and clears) the staged id during `reconnectToStream`. */
  takePendingContinuation(): string | null {
    const id = pendingReqId;
    pendingReqId = null;
    return id;
  },
  /** Test seam. */
  reset(): void {
    resume = null;
    pendingReqId = null;
  },
};

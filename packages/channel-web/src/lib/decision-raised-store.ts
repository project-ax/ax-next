/**
 * Decision-raised store — a monotonic counter, not a copy of the decision.
 *
 * The server's `decisionRaised` SSE frame (TASK-261, `src/server/sse.ts`
 * §4c-quater) carries only `{decisionId, summary}` — nowhere near enough to
 * render `ApprovalCard` (it needs detail, labels, preview, status,
 * `undoable`). `GET /api/workspace/decisions` stays the one producer of
 * decision rows (invariant 4 — one source of truth); storing the frame's
 * payload here would just be a second, poorer copy of a row someone else
 * owns.
 *
 * So this store holds nothing but a count. Bumping it is a signal with two
 * jobs: (a) "read the decisions route again now" — `useConversationDecisions`
 * (T3) refreshes `useDecisionQueue` off a change in `raised` — and (b)
 * positive evidence that something IS waiting, which `<InThreadApprovals>`
 * (T4) needs to decide whether a failed read is worth saying out loud.
 *
 * Same `useSyncExternalStore` shape as `permission-card-store.ts` /
 * `agent-status-store.ts`.
 */
import { useSyncExternalStore } from 'react';

export interface DecisionRaisedState {
  raised: number;
}

const initial: DecisionRaisedState = { raised: 0 };

let state: DecisionRaisedState = initial;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): DecisionRaisedState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const set = (next: DecisionRaisedState): void => {
  state = next;
  notify();
};

export function useDecisionRaised(): DecisionRaisedState {
  return useSyncExternalStore(subscribe, getSnapshot, () => initial);
}

/** Read the current state without subscribing. Use inside effects/tests. */
export const getDecisionRaisedSnapshot = (): DecisionRaisedState => state;

export const decisionRaisedActions = {
  /** A `decisionRaised` frame landed — bump the counter. */
  raise(): void {
    set({ raised: state.raised + 1 });
  },
  /**
   * Back to 0. Called when the active conversation changes, so evidence
   * that a decision is waiting in thread A cannot speak for thread B.
   */
  reset(): void {
    set(initial);
  },
  /** Test seam — reset between tests. */
  resetForTest(): void {
    set(initial);
  },
  /** Test seam — subscribe without React. */
  subscribeForTest(cb: () => void): () => void {
    return subscribe(cb);
  },
};

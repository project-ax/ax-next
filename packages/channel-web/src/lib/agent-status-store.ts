/**
 * Agent-status store — drives the slim status row above the composer.
 *
 * Surfaces *transient* agent state ("Thinking…", "Starting sandbox…",
 * "Searching the web…") and *recoverable* errors ("Connection lost —
 * retrying…"). Lives outside the chat timeline so nothing here is
 * persisted to history.
 *
 * Same `useSyncExternalStore` shape as `search-store.ts`: a small in-module
 * `state` object plus a subscriber set, with a typed `agentStatusActions`
 * object for callers.
 *
 * Visibility model: a single `mode` discriminator drives CSS state.
 *   - 'hidden'  — row collapsed (`opacity: 0`, no pointer-events).
 *   - 'working' — blue dot, breathing, optional cancel handler.
 *   - 'error'   — red dot, persistent until retry/dismiss; shows a
 *                 retry button if a `retry` callback was provided,
 *                 otherwise a dismiss button.
 *
 * Why a discriminated mode rather than two flags: the row can't be
 * "both working AND erroring", and a flag pair would make a third
 * state ("working === false && error === false") that we'd then have
 * to disambiguate from "hidden". Mode collapses that ambiguity.
 */
import { useSyncExternalStore } from 'react';

export type AgentStatusMode = 'hidden' | 'working' | 'error';

export interface AgentStatusState {
  mode: AgentStatusMode;
  text: string;
  /** When set in working mode, the row exposes a "stop" affordance on hover. */
  cancel: (() => void) | null;
  /** When set in error mode, the row's primary action says "retry". */
  retry: (() => void) | null;
  /** When set in error mode, the row's primary action says "dismiss" (only used if retry is null). */
  dismiss: (() => void) | null;
}

const initial: AgentStatusState = {
  mode: 'hidden',
  text: '',
  cancel: null,
  retry: null,
  dismiss: null,
};

let state: AgentStatusState = initial;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): AgentStatusState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const set = (next: AgentStatusState): void => {
  state = next;
  notify();
};

export function useAgentStatusStore(): AgentStatusState {
  return useSyncExternalStore(subscribe, getSnapshot, () => initial);
}

/** Read the current state without subscribing. Use inside effects. */
export const getAgentStatusSnapshot = (): AgentStatusState => state;

export const agentStatusActions = {
  /** Reveal the row in working mode with the given label. */
  show(text: string): void {
    set({ ...state, mode: 'working', text, retry: null, dismiss: null });
  },
  /** Swap the label while visible. CSS handles the crossfade. */
  set(text: string): void {
    if (state.mode === 'hidden') {
      // No row visible — equivalent to show().
      set({ ...state, mode: 'working', text, retry: null, dismiss: null });
      return;
    }
    if (state.text === text) return;
    set({ ...state, text });
  },
  /** Hide the row and clear any registered handlers. */
  hide(): void {
    set(initial);
  },
  /**
   * Register a cancel handler. When non-null, the row exposes a "stop"
   * button on hover. The handler is cleared on hide().
   */
  onCancel(fn: (() => void) | null): void {
    set({ ...state, cancel: fn });
  },
  /**
   * Switch to error mode (red dot, persistent). If `retry` is provided,
   * the action button says "retry"; otherwise it says "dismiss".
   */
  error(
    text: string,
    opts: { retry?: () => void; dismiss?: () => void } = {},
  ): void {
    set({
      ...state,
      mode: 'error',
      text,
      retry: opts.retry ?? null,
      dismiss: opts.dismiss ?? null,
    });
  },
  /** Test seam — reset between tests. */
  reset(): void {
    set(initial);
  },
};

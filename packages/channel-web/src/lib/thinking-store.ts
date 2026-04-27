/**
 * Thinking-block UI toggle (Task 21 / Invariant J4).
 *
 * Default: hidden. The UI shows a small per-message toggle on assistant
 * messages; clicking flips this flag from `false` → `true`, which:
 *
 *   1. Re-creates the history adapter with `includeThinking: true` so
 *      the next thread reload pulls historical thinking blocks.
 *
 *   2. Toggles a body-level CSS class (`thinking-visible`) so any
 *      already-rendered thinking parts (from a live stream chunk) become
 *      visible. The transport always emits thinking deltas; the UI
 *      decides whether to render them.
 *
 * Why a global flag, not per-message:
 *   - Per-message tracking would need the message id from assistant-ui's
 *     runtime, then a Map keyed by id, then re-renders that miss flips
 *     until the runtime re-iterates parts. The user-visible difference
 *     between per-message and global is small in MVP; J4 just says "off
 *     by default and toggleable", and a global flag satisfies it.
 *
 * If a future spec demands per-message scoping, the API surface (a
 * boolean store + actions) is identical — only the data shape changes.
 */
import { useSyncExternalStore } from 'react';

export interface ThinkingStoreState {
  /** When true, thinking blocks render visibly. */
  visible: boolean;
}

let state: ThinkingStoreState = { visible: false };
const listeners = new Set<() => void>();

const getSnapshot = (): ThinkingStoreState => state;
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const set = (next: Partial<ThinkingStoreState>): void => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

export const useThinkingStore = (): ThinkingStoreState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const thinkingStoreActions = {
  setVisible: (visible: boolean): void => {
    set({ visible });
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('thinking-visible', visible);
    }
  },
  toggle: (): void => {
    thinkingStoreActions.setVisible(!state.visible);
  },
  /** Test seam — reset between tests. */
  reset: (): void => {
    set({ visible: false });
    if (typeof document !== 'undefined') {
      document.body.classList.remove('thinking-visible');
    }
  },
};

/**
 * Search-mode store — owns the search-bar's open/closed state and the
 * current query string (Task 26).
 *
 * Single source of truth: a small in-module `state` object plus the
 * `body.searching` class on `<body>`. The class is what the CSS rule
 * `body.searching .attach-btn { display: none }` keys off, so the
 * composer's attach button vanishes whenever the bar is open. Same
 * pattern as `theme.ts` / `sidebar-collapse.ts` — no React-state copy,
 * `useSyncExternalStore` subscribes components, and the `apply()` helper
 * handles both DOM and listener updates atomically.
 *
 * Why a separate `open` flag rather than "open === query.length > 0":
 * we want the bar to render even when the query is empty (so the user
 * has somewhere to type). Coupling visibility to query length would
 * make the bar disappear on first keystroke-then-backspace, which is
 * the kind of thing that makes everyone in the room say "oh".
 *
 * Filtering note: actual message-text filtering is deferred until
 * assistant-ui exposes a stable message-iteration API. `<Thread />`
 * shows a "filter active" banner while the query is non-empty so the
 * affordance isn't a lie.
 */
import { useSyncExternalStore } from 'react';

interface SearchState {
  query: string;
  open: boolean;
}

let state: SearchState = { query: '', open: false };
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): SearchState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const apply = (next: SearchState): void => {
  state = next;
  document.body.classList.toggle('searching', next.open);
  notify();
};

/** SSR-safe default — closed bar, empty query. */
const ssrSnapshot: SearchState = { query: '', open: false };

export function useSearchStore(): SearchState {
  return useSyncExternalStore(subscribe, getSnapshot, () => ssrSnapshot);
}

export const searchStoreActions = {
  open(): void {
    apply({ query: '', open: true });
  },
  setQuery(q: string): void {
    apply({ ...state, query: q });
  },
  /** Reset the query without closing the bar — bound to the × button. */
  clear(): void {
    apply({ ...state, query: '' });
  },
  close(): void {
    apply({ query: '', open: false });
  },
};

/**
 * "This tab's session is over." One bit, set once, read by `App.tsx`.
 *
 * Built in the `toast-store` mould — a module singleton over
 * `useSyncExternalStore` — for the same reason the six siblings are: the thing
 * that learns the session ended is a `fetch` wrapper in `lib/http.ts`, which
 * has no React context to write into and no business acquiring one.
 *
 * WHY A LATCH AND NOT A COUNTER. `expired()` is a no-op once the bit is set, so
 * a caller may fire it as often as it likes. That matters more than it sounds:
 * the decisions undo poll (`lib/workspace-decisions.ts`) re-reads a row ONCE
 * PER SECOND while an undo window is open, and a signed-out tab would fire this
 * on every tick. Notifying subscribers only on the false→true transition keeps
 * that from re-rendering the whole app 60 times a minute on the way to a screen
 * that is about to unmount anyway.
 *
 * There is deliberately no un-expire. Signing back in reloads the page (the
 * Google round-trip lands on `/`), which resets the module. `reset()` exists
 * for tests and nothing else — a "recovered" path would need to re-establish
 * every store the signed-out screen tore down, and we do not have that.
 */
import { useSyncExternalStore } from 'react';

let expired = false;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): boolean => expired;

const notify = (): void => {
  for (const l of listeners) l();
};

/** `true` once a post-boot request has come back 401. Never goes back. */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Non-React read, for callers that are not components. */
export function getSessionExpired(): boolean {
  return expired;
}

export const sessionExpiredActions = {
  /** Idempotent — see the latch note above. */
  expired(): void {
    if (expired) return;
    expired = true;
    notify();
  },
  /** Test seam. Not a recovery path. */
  reset(): void {
    expired = false;
    notify();
  },
};

/**
 * Permission-card store — holds the single pending JIT approval card.
 *
 * The transport routes a `permissionRequest` SSE frame here (design §11.3);
 * `<PermissionCard>` reads it. Lives outside the chat timeline — nothing here
 * is persisted to history, and it never holds a secret (the key the user types
 * stays in the card component's local state and posts straight to the
 * credential store). Same `useSyncExternalStore` shape as agent-status-store.
 */
import { useSyncExternalStore } from 'react';

export interface PermissionRequest {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
  /** TASK-39: open-mode banner — the agent just wrote this skill. */
  authored?: boolean;
}

export interface PermissionCardState {
  request: PermissionRequest | null;
}

const initial: PermissionCardState = { request: null };

let state: PermissionCardState = initial;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): PermissionCardState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const set = (next: PermissionCardState): void => {
  state = next;
  notify();
};

export function usePermissionCardStore(): PermissionCardState {
  return useSyncExternalStore(subscribe, getSnapshot, () => initial);
}

/** Read the current state without subscribing. Use inside effects/tests. */
export const getPermissionCardSnapshot = (): PermissionCardState => state;

export const permissionCardActions = {
  /** Surface a pending card. A new request replaces any prior one. */
  show(request: PermissionRequest): void {
    set({ request });
  },
  /** Clear the card (Connect-complete or Not-now). */
  dismiss(): void {
    set({ request: null });
  },
  /** Test seam — reset between tests. */
  reset(): void {
    set(initial);
  },
  /** Test seam — subscribe without React. */
  subscribeForTest(cb: () => void): () => void {
    return subscribe(cb);
  },
};

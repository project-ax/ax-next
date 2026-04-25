/**
 * Sidebar collapse state — owned by `document.body.classList` so the
 * existing CSS rules (copied from the Tide handoff) drive layout without
 * a parallel React-state copy. localStorage persists across reloads.
 *
 * Single source of truth: `body.sidebar-collapsed`. React subscribes via
 * `useSyncExternalStore`; a small in-module listener set rebroadcasts on
 * `setSidebarCollapsed`. We don't observe class mutations from outside the
 * module — there are none today, and adding a MutationObserver just to
 * cover that case would be paranoid in the wrong direction.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'tide-sidebar-collapsed';
const listeners = new Set<() => void>();

const getSnapshot = (): boolean =>
  document.body.classList.contains('sidebar-collapsed');

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const notify = (): void => {
  for (const l of listeners) l();
};

/** SSR-safe default of `false`; the real value is read on hydrate. */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function setSidebarCollapsed(collapsed: boolean): void {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  if (collapsed) {
    localStorage.setItem(KEY, '1');
  } else {
    localStorage.removeItem(KEY);
  }
  notify();
}

/** Read persisted state and apply it. Call once on App mount. */
export function hydrateSidebarCollapsed(): void {
  const v = localStorage.getItem(KEY);
  setSidebarCollapsed(v === '1');
}

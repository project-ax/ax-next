/**
 * Sidebar collapse + mobile-open state — both owned by
 * `document.body.classList` so the existing CSS rules (copied from the Tide
 * handoff) drive layout without a parallel React-state copy.
 *
 * Two body classes, two concerns:
 *   - `sidebar-collapsed` (desktop) — narrows to a 56px rail.
 *     Persisted to localStorage so it survives reloads.
 *   - `sidebar-open` (mobile)       — slides the sidebar in over the
 *     content. NOT persisted; mobile sessions should always start
 *     closed so the user sees the chat first.
 *
 * Single in-module listener set rebroadcasts on either setter. We don't
 * observe class mutations from outside the module — there are none today,
 * and a MutationObserver just to cover that case would be paranoid in the
 * wrong direction.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'tide-sidebar-collapsed';
const listeners = new Set<() => void>();

const getCollapsedSnapshot = (): boolean =>
  document.body.classList.contains('sidebar-collapsed');

const getOpenSnapshot = (): boolean =>
  document.body.classList.contains('sidebar-open');

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
  return useSyncExternalStore(subscribe, getCollapsedSnapshot, () => false);
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

/**
 * Mobile slide-over open state. NOT persisted — mobile sessions always
 * start closed. Toggled by `SidebarMobileToggle` and the scrim's tap
 * handler in `App.tsx`.
 */
export function useSidebarOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpenSnapshot, () => false);
}

export function setSidebarOpen(open: boolean): void {
  document.body.classList.toggle('sidebar-open', open);
  notify();
}

/**
 * Theme tri-toggle — owned by `<html data-theme>` so the existing CSS
 * variables (`:root`, `[data-theme="dark"]`, `prefers-color-scheme: dark`)
 * drive paint without a parallel React-state copy. localStorage persists
 * across reloads under `'tide-theme'`.
 *
 * Three modes:
 *  - `auto`   — no `data-theme` attribute; system preference takes over
 *               via `prefers-color-scheme`.
 *  - `light`  — `data-theme="light"`, pinning the light palette.
 *  - `dark`   — `data-theme="dark"`, pinning the dark palette.
 *
 * Single source of truth: the `data-theme` attribute on `<html>`. React
 * subscribes via `useSyncExternalStore`; a small in-module listener set
 * rebroadcasts on `setTheme`. Same shape as `sidebar-collapse.ts`.
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'auto' | 'light' | 'dark';
const KEY = 'tide-theme';
const listeners = new Set<() => void>();

const getSnapshot = (): Theme => {
  const v = document.documentElement.getAttribute('data-theme');
  if (v === 'light' || v === 'dark') return v;
  return 'auto';
};

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const notify = (): void => {
  for (const l of listeners) l();
};

/** SSR-safe default of `'auto'`; the real value is read on hydrate. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'auto');
}

export function setTheme(value: Theme): void {
  if (value === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem(KEY);
  } else {
    document.documentElement.setAttribute('data-theme', value);
    localStorage.setItem(KEY, value);
  }
  notify();
}

/** Read persisted state and apply it. Call once on App mount. */
export function hydrateTheme(): void {
  const v = localStorage.getItem(KEY) as Theme | null;
  if (v === 'light' || v === 'dark') {
    document.documentElement.setAttribute('data-theme', v);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  notify();
}

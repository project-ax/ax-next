/**
 * Theme tri-toggle — owned by `<html data-theme>` so the existing CSS
 * variables (`:root`, `[data-theme="dark"]`, `prefers-color-scheme: dark`)
 * drive paint without a parallel React-state copy. localStorage persists
 * across reloads under `'ax-theme'`.
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
const KEY = 'ax-theme';
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

// --- resolved (light|dark) theme ---------------------------------------------
// `useTheme()` is tri-state; the header needs the CONCRETE palette to pick the
// matching logo variant (and to decide whether to invert a light-only logo).
// For `auto` we resolve against `prefers-color-scheme`, subscribing to OS-level
// flips. Guarded for jsdom, which ships no `matchMedia`.

const DARK_QUERY = '(prefers-color-scheme: dark)';

const systemPrefersDark = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(DARK_QUERY).matches;

const subscribeSystemTheme = (cb: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(DARK_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
};

/**
 * The concrete palette in effect: tri-state `useTheme()` collapsed against the
 * OS preference for `auto`. Re-renders on theme toggle AND on OS-level flips.
 */
export function useResolvedTheme(): 'light' | 'dark' {
  const theme = useTheme();
  const systemDark = useSyncExternalStore(
    subscribeSystemTheme,
    systemPrefersDark,
    () => false,
  );
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return systemDark ? 'dark' : 'light';
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

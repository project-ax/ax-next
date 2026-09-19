/**
 * Is the viewport narrower than the `md` breakpoint?
 *
 * The workspace shell has two side columns that do not shrink —
 * `WorkspaceSidebar`'s 236px and `AgentRail`'s 296px — which on a 390px phone
 * is 532px of chrome and leaves the conversation no width at all. Below `md`
 * both move off-canvas into a `Sheet`, and this is the switch (TASK-404).
 *
 * WHY A HOOK AND NOT A `md:` CLASS. A `Sheet` and an inline `<aside>` are
 * different trees, not one tree with different CSS: the sidebar is stateful,
 * carries the `UserMenu`, and rendering both at once would duplicate every
 * focus stop and every `aria` target on the page. shadcn's own Sidebar block
 * branches in JS for exactly this reason. Anything that IS expressible as a
 * class — the header wrapping, the tab strip's scroll rail — stays a class and
 * does not come through here.
 *
 * 767.98px rather than 767px: `max-width: 767px` leaves a dead band on
 * fractional viewport widths (a 767.5px window matches neither it nor
 * `min-width: 768px`), which browser zoom and some Android devices really do
 * produce. Tailwind's own `md` is `min-width: 768px`, so this is its exact
 * complement and the two can never both be true or both be false.
 */
import { useSyncExternalStore } from 'react';

/** The complement of Tailwind's `md` (`min-width: 768px`). Keep them in step. */
const COMPACT_QUERY = '(max-width: 767.98px)';

/**
 * Guarded for jsdom, which ships no `matchMedia` at all — the same guard
 * `theme.ts` already carries for `prefers-color-scheme`. Absent `matchMedia`
 * this reads `false`, so tests that do not opt in keep rendering the desktop
 * tree and nothing that exists today changes shape.
 */
const isCompact = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(COMPACT_QUERY).matches;

const subscribeCompact = (cb: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(COMPACT_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
};

/**
 * `true` below 768px. Re-renders on resize and on orientation change, because
 * `matchMedia` fires `change` for both — a rotation that crosses the breakpoint
 * moves the sidebar without a reload.
 */
export function useIsCompact(): boolean {
  return useSyncExternalStore(subscribeCompact, isCompact, () => false);
}

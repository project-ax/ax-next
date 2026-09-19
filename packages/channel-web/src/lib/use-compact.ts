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
 * THE QUERY IS A NEGATION, NOT A `max-width`. Tailwind's `md` is
 * `min-width: 768px`, and the complement of that is `not all and
 * (min-width: 768px)` — which is exactly what Tailwind's own `max-md` variant
 * compiles to. A `max-width` spelling cannot express it: `767px` leaves a whole
 * pixel unclaimed, and even `767.98px` leaves the open band
 * `(767.98, 768)` matching NEITHER query, so a viewport in it would take the
 * desktop JS tree (both 236px and 296px columns) while the CSS still applied
 * the compact header. A 0.02px band is only reachable from zoom or a
 * fractional DPR, but it is reachable, and "the two can never disagree" is the
 * property this hook is for. Negating the real breakpoint makes that true by
 * construction rather than by a rounding margin.
 */
import { useSyncExternalStore } from 'react';

/**
 * The exact complement of Tailwind's `md` (`min-width: 768px`) — gap-free by
 * construction. If the `md` breakpoint ever moves, move this with it.
 */
const COMPACT_QUERY = 'not all and (min-width: 768px)';

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

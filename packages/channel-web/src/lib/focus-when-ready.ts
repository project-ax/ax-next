/**
 * Put keyboard focus back on a control that is not in the document yet
 * (TASK-443 built it for Settings; TASK-474 lifted it out so other surfaces can
 * use it too).
 *
 * WHAT IT IS FOR. Some of our "close" transitions destroy the control that
 * opened them and create a new one. Settings is the first: `App.tsx` swaps the
 * whole workspace out for it and mounts a fresh one on the way back. A restore
 * that captured the opener NODE cannot help there (it is detached, and
 * focusing a detached node lands on `<body>`), so the restore goes by IDENTITY:
 * the caller names the control with an attribute, and this module finds that
 * control's successor in the new tree.
 *
 * TARGETS ARE AN ORDERED LIST. The first selector is the control that really
 * opened the surface. Anything after it is a stand-in for when the real one is
 * not on screen at all. The case that earned this (TASK-474) is a compact
 * viewport: the nav, and every control in it, lives inside a `Sheet` that Radix
 * unmounts while closed. The opener simply does not exist, so the list names the
 * hamburger — {@link NAV_TRIGGER_ATTR} — next.
 *
 * The first target that is present AND takes focus wins. A present-but-disabled
 * target does not end the search, because "we found it and it refused" still
 * leaves the person on `<body>`.
 *
 * THE WAIT. The new tree often is not there yet — the remounted workspace paints
 * a loading screen with no sidebar first. So {@link focusFirstWhenReady} tries
 * straight away and then watches the document for a target to arrive, with
 * three exits:
 *
 *   - a target takes focus;
 *   - somebody else takes the keyboard first (a Tab, a click, an autofocus) —
 *     a person standing somewhere on purpose outranks a restore;
 *   - {@link RESTORE_WINDOW_MS} runs out.
 *
 * The window is the only exit guaranteed to fire, and it has to be: there are
 * reachable states where no target ever appears (the board read fails on the
 * way back and the shell shows a "Try again" screen with no header in it). An
 * observer that waited forever would run on every DOM mutation for the rest of
 * the session and could still fire minutes later, stealing the keyboard.
 *
 * WHICH DIRECTION THIS FAILS IN. To `<body>` — the same place the original bug
 * lands. That is why {@link focusFirst} reports whether focus ACTUALLY moved
 * (checked against `activeElement`, not against having called `.focus()`).
 */

/**
 * Marks the button that opens the compact nav sheet — the hamburger.
 *
 * It is a STAND-IN restore target: on a compact viewport, anything that lives
 * inside the nav sheet (the user menu, "+ New agent") is gone once the sheet
 * closes, and the hamburger is the control on screen that leads back to it.
 * Restoring there is a deliberate choice of a DIFFERENT element from the one
 * that opened the surface, not an accident of whatever was focusable.
 *
 * Only ever rendered on a compact viewport, so on desktop it is never a
 * candidate and the real opener is the only thing a restore can land on.
 */
export const NAV_TRIGGER_ATTR = 'data-nav-trigger';

/**
 * How long after the close a restore may still land.
 *
 * Long enough to cover a remount that waits on a board read on a slow
 * connection; short enough that the restore is still recognisably part of the
 * transition the person performed, rather than a cursor jump out of nowhere.
 */
export const RESTORE_WINDOW_MS = 2_000;

/**
 * One restore target: a selector, or a finder for a target a selector cannot
 * name safely — e.g. one identified by server data (TASK-533), which should be
 * compared as a value rather than spliced into selector syntax.
 */
export type FocusTarget = string | ((root: ParentNode) => HTMLElement | null);

/**
 * Focus the first target, in order, that is present and accepts focus.
 *
 * Returns whether focus actually landed on one of them.
 */
export function focusFirst(
  selectors: readonly FocusTarget[],
  root: ParentNode = document,
): boolean {
  for (const selector of selectors) {
    const target =
      typeof selector === 'string'
        ? root.querySelector<HTMLElement>(selector)
        : selector(root);
    if (target === null) continue;
    // `preventScroll`: the surface has just been re-created and is already
    // scrolled where the person left it. A scroll correction toward a control
    // they did not ask to look at reads as the page jumping under them.
    target.focus({ preventScroll: true });
    if (target.ownerDocument.activeElement === target) return true;
  }
  return false;
}

/**
 * Whether something other than "nothing" holds the keyboard.
 *
 * `<body>` is what a browser falls back to when the focused element goes away,
 * and `<html>` and `null` are the same fact reported differently by different
 * engines and by a document nobody has focused yet. None of the three is a
 * person standing somewhere; everything else is.
 */
function keyboardIsClaimed(doc: Document): boolean {
  const active = doc.activeElement;
  return (
    active !== null && active !== doc.body && active !== doc.documentElement
  );
}

/**
 * {@link focusFirst} as soon as a target exists — unless someone else has taken
 * the keyboard first, or the window closes.
 *
 * Call it once, right after the close. The returned function cancels the wait;
 * a React caller returns it straight from its effect, so re-opening the surface
 * (or unmounting) calls off a restore that is no longer wanted.
 *
 * WHY A MUTATION OBSERVER AND NOT POLLING. What we are waiting for is a DOM
 * event — a target being inserted — and the observer fires on exactly that.
 *
 * `windowMs` is a parameter so a test can close the window without waiting out
 * the real one. Callers in the app pass nothing.
 */
export function focusFirstWhenReady(
  selectors: readonly FocusTarget[],
  doc: Document = document,
  windowMs: number = RESTORE_WINDOW_MS,
): () => void {
  if (focusFirst(selectors, doc)) return () => {};

  const observer = new MutationObserver(() => {
    // Somebody is standing somewhere on purpose. Leave them there. Checked
    // BEFORE trying to focus, so a Tab during the wait ends the restore rather
    // than losing a race with it.
    if (keyboardIsClaimed(doc)) return stop();
    if (focusFirst(selectors, doc)) stop();
  });
  const timer = setTimeout(() => stop(), windowMs);
  // One exit for all three endings, so no path can leave the observer attached
  // or the timer armed.
  function stop(): void {
    observer.disconnect();
    clearTimeout(timer);
  }

  observer.observe(doc.body, { childList: true, subtree: true });
  return stop;
}

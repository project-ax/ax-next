/**
 * Where keyboard focus goes when the Settings pane closes (TASK-443).
 *
 * THE BUG THIS EXISTS FOR. Settings is not an overlay. `App.tsx` renders it as
 * a PANE SWAP — `adminSettingsOpen ? <AdminShell/> : <WorkspaceShell/>` — so
 * opening it unmounts the whole workspace and closing it mounts a whole new
 * one. Nothing in that sequence moves focus, and the browser's rule for a
 * focused element that disappears is to drop focus on `<body>`. A keyboard
 * user who opened Settings from the user menu, changed nothing, and backed out
 * is returned to a workspace they now have to Tab into from the top.
 *
 * WHY THE EXISTING RESTORES DO NOT COVER IT — and why this is a second
 * mechanism rather than a reuse. Both of the restores already in the tree
 * capture a NODE and focus it again later:
 *
 *   - `components/ui/use-opener-restore.ts` records `document.activeElement` at
 *     `onOpenAutoFocus` and restores it at `onCloseAutoFocus`, for Dialog and
 *     Sheet.
 *   - `lib/consent-focus.ts` (#599 / TASK-427) focuses a node inside, or an
 *     ancestor region of, a consent card that is about to be replaced.
 *
 * Both depend on the target still being in the document when the restore runs,
 * and `use-opener-restore` is explicit about what happens when it is not:
 * `if (!opener || !opener.isConnected) return`. It bails, because focusing a
 * detached node is a silent no-op that lands on `<body>` anyway — the very
 * failure it was written to fix. On a pane swap the opener is ALWAYS detached:
 * it was destroyed the moment Settings opened. There is no "while the node is
 * still mounted" window to use.
 *
 * SO THE RESTORE IS BY IDENTITY, NOT BY NODE. The control that opened Settings
 * has a successor in the newly-mounted tree — same control, same place, new
 * node — and `SETTINGS_OPENER_ATTR` is how we name it. The attribute goes on
 * the user-menu TRIGGER rather than on the "Settings" menu item inside it: the
 * item lives in a popover that is gone before Settings even mounts, while the
 * trigger is the durable door, and it is also exactly where Radix's dropdown
 * would have put focus if the surrounding tree had survived.
 *
 * THE OPENER IS NOT THERE WHEN SETTINGS CLOSES. Measured, and the reason this
 * module is more than a one-line `querySelector().focus()`. The surface
 * Settings returns to is freshly mounted, so it re-reads its data, and
 * `WorkspaceShell`'s own loading branch (`if (loading && !board)`) renders a
 * centred "Loading your workspace…" with NO sidebar in it. For that first tick
 * there is no user menu, no trigger, and nothing to focus — a restore fired
 * from the close handler finds zero marked nodes and quietly does nothing. So
 * the restore WAITS for the opener to arrive: {@link focusSettingsOpenerWhenReady}.
 *
 * AND IT GIVES WAY TO THE PERSON. Waiting introduces a second hazard: someone
 * who Tabs while the workspace loads has a control, and yanking them off it
 * when the sidebar finally paints is worse than the bug. So the wait aborts the
 * moment anything else holds the keyboard. A deliberate focus — a Tab, a click,
 * an autofocus on the returning surface — outranks a restore for a pane that is
 * already gone.
 *
 * AND IT GIVES UP. The opener does not always come back at all, and a wait with
 * no end is its own defect — found in review, and reachable two ways:
 *
 *   - **A narrow viewport.** `WorkspaceShell` renders the desktop rail only
 *     when it is not `compact`; below that the nav — and the only `UserMenu` —
 *     lives inside a `Sheet` that Radix UNMOUNTS while closed. Coming back from
 *     Settings the sheet is closed, so there is no opener anywhere.
 *   - **A board read that blips on the way back.** The remounted shell re-reads
 *     the board, and its `error` branch is a "Try again" screen with no sidebar
 *     in it. Reachable on a desktop that was perfectly healthy a moment ago.
 *
 * In both, focus stays on `<body>`, so the yield rule never trips either, and
 * an unbounded observer would run its callback on every DOM mutation for the
 * rest of the session — and could still fire minutes later, stealing the
 * keyboard from a nav sheet somebody opened for a completely different reason.
 *
 * So the wait is bounded by {@link SETTINGS_RESTORE_WINDOW_MS}. That IS a
 * number of milliseconds, and the earlier draft of this file argued there was
 * no honest one. The argument was wrong, because it had the subject wrong: this
 * restore is waiting on a REMOUNT, not on a server. It belongs to the
 * transition the person just performed. Once they have had time to look at the
 * new surface and act on it, moving their cursor is not a restore any more — it
 * is exactly the focus steal the yield rule exists to prevent, arriving too
 * late for the yield rule to see it. A restore that misses its window leaves
 * focus on `<body>`, which is no worse than the bug and a great deal better
 * than a surprise.
 *
 * WHICH DIRECTION THIS FAILS IN. It fails to `<body>` — the same place the bug
 * lands — so a test that only asserts "not `<body>`" cannot tell a working
 * restore from a broken one, and neither can a reader. That is why
 * {@link focusSettingsOpener} reports whether focus ACTUALLY moved (checked
 * against `activeElement`, not against having called `.focus()`): a marked node
 * that is disabled, `inert`, or not yet rendered refuses focus quietly, and a
 * caller that wants to know can.
 */

/**
 * Marks the control a person opens Settings from.
 *
 * At most one node in the document should carry it: the restore takes the
 * first match, and a second marked node would make which one wins depend on
 * document order rather than on anything deliberate. It belongs only on a
 * control that can really open Settings — a marked node behind a menu that
 * cannot is a promise of a door that isn't there.
 */
export const SETTINGS_OPENER_ATTR = 'data-settings-opener';

/**
 * Put focus back on the Settings opener in the CURRENT document.
 *
 * Call it after the render that brings the opener's surface back, not before:
 * the node is looked up fresh each time, so calling it too early finds nothing
 * and it says so rather than pretending.
 *
 * Returns whether focus actually landed on the opener.
 */
export function focusSettingsOpener(root: ParentNode = document): boolean {
  const opener = root.querySelector<HTMLElement>(`[${SETTINGS_OPENER_ATTR}]`);
  if (opener === null) return false;
  // `preventScroll`: the workspace has just been re-created and is already
  // scrolled where the person left it. A scroll correction toward a sidebar
  // control they did not ask to look at reads as the page jumping under them.
  opener.focus({ preventScroll: true });
  return opener.ownerDocument.activeElement === opener;
}

/**
 * How long after the close the restore may still land.
 *
 * Long enough to cover a remount that waits on a board read on a slow
 * connection; short enough that the restore is still recognisably part of the
 * transition the person performed, rather than a cursor jump out of nowhere.
 * It is also the only thing guaranteeing the wait ENDS — see the module header
 * for the two surfaces where the opener never comes back at all.
 */
export const SETTINGS_RESTORE_WINDOW_MS = 2_000;

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
 * Focus the Settings opener as soon as it exists — unless someone else has
 * taken the keyboard first, or it never shows up.
 *
 * Call it once, right after Settings closes. It tries immediately, and if the
 * opener has not been rendered yet it watches the document for it until the
 * restore window closes. The returned function cancels the wait; a React caller
 * returns it straight from its effect, so re-opening Settings (or unmounting)
 * calls off a restore that is no longer wanted.
 *
 * WHY A MUTATION OBSERVER AND NOT POLLING. What we are waiting for is a DOM
 * event — the opener being inserted — and the observer fires on exactly that.
 * A polling interval would have to guess how often as well as how long. The
 * observer only does work when the page changes.
 *
 * THE THREE WAYS IT ENDS, all of which disconnect: the opener takes focus; the
 * keyboard turns out to be claimed ({@link keyboardIsClaimed}, checked on every
 * mutation BEFORE trying to focus, so a Tab during the wait ends the restore
 * rather than losing a race with it); or the window runs out.
 *
 * `windowMs` is a parameter so a test can close the window without waiting out
 * the real one. Callers in the app pass nothing.
 */
export function focusSettingsOpenerWhenReady(
  doc: Document = document,
  windowMs: number = SETTINGS_RESTORE_WINDOW_MS,
): () => void {
  if (focusSettingsOpener(doc)) return () => {};

  const observer = new MutationObserver(() => {
    // Somebody is standing somewhere on purpose. Leave them there.
    if (keyboardIsClaimed(doc)) return stop();
    if (focusSettingsOpener(doc)) stop();
  });
  const timer = setTimeout(() => stop(), windowMs);
  // One exit for all three endings, so no path can leave the observer attached
  // or the timer armed. Declared after both so it can close over them; it is
  // only ever CALLED from an async callback or by the caller.
  function stop(): void {
    observer.disconnect();
    clearTimeout(timer);
  }

  observer.observe(doc.body, { childList: true, subtree: true });
  return stop;
}

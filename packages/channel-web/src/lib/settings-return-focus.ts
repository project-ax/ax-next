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
 * ON A COMPACT VIEWPORT THE OPENER NEVER COMES BACK (TASK-474). Below `md`,
 * `WorkspaceShell` has no desktop rail: the nav — and the only `UserMenu` —
 * lives inside a `Sheet` that Radix UNMOUNTS while closed, and it is closed
 * when the workspace comes back. There is no successor to wait for, so the
 * by-identity wait used to expire with focus on `<body>`.
 *
 * So the restore has a SECOND target: the hamburger that opens that sheet
 * (`NAV_TRIGGER_ATTR`). This is a deliberate accessibility decision, not a
 * fallback of convenience — it puts focus on a DIFFERENT element from the one
 * that opened Settings. It is the right one because it is what is actually on
 * screen and focusable, and it is the door back to the opener: one Enter
 * reopens the sheet with the user menu in it. The alternatives are worse —
 * reopening the sheet ourselves would put up a surface nobody asked for, and a
 * generic "first focusable thing" would be wherever document order happens to
 * say. The opener still wins whenever it exists (desktop): the targets are
 * tried in order, and the hamburger is only ever rendered on compact.
 *
 * AND IT GIVES UP. A board read that blips on the way back renders the shell's
 * "Try again" screen, which has neither a sidebar nor a header — neither
 * target ever appears, on any viewport. Focus stays on `<body>`, so the yield
 * rule never trips either. The wait is therefore bounded by
 * {@link SETTINGS_RESTORE_WINDOW_MS}: this restore is waiting on a REMOUNT, not
 * on a server, and once the person has had time to look at the new surface,
 * moving their cursor is not a restore any more — it is a focus steal arriving
 * too late for the yield rule to see it. A restore that misses its window
 * leaves focus on `<body>`, which is no worse than the bug.
 *
 * THE MECHANISM lives in `./focus-when-ready.ts` (lifted out in TASK-474 so
 * other close transitions can name their own targets). This module only says
 * which targets Settings restores to.
 *
 * WHICH DIRECTION THIS FAILS IN. It fails to `<body>` — the same place the bug
 * lands — so a test that only asserts "not `<body>`" cannot tell a working
 * restore from a broken one. That is why {@link focusSettingsOpener} reports
 * whether focus ACTUALLY moved: a marked node that is disabled, `inert`, or not
 * yet rendered refuses focus quietly, and a caller that wants to know can.
 */
import {
  NAV_TRIGGER_ATTR,
  RESTORE_WINDOW_MS,
  focusFirst,
  focusFirstWhenReady,
} from './focus-when-ready';

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
 * Where Settings sends focus back to, in order: the opener itself, else the
 * compact nav's hamburger (see the module header for why a different element).
 */
const SETTINGS_RETURN_TARGETS = [
  `[${SETTINGS_OPENER_ATTR}]`,
  `[${NAV_TRIGGER_ATTR}]`,
] as const;

/**
 * Put focus back on the Settings opener — or its compact stand-in — in the
 * CURRENT document.
 *
 * Call it after the render that brings the opener's surface back, not before:
 * the targets are looked up fresh each time, so calling it too early finds
 * nothing and it says so rather than pretending.
 *
 * Returns whether focus actually landed on a target.
 */
export function focusSettingsOpener(root: ParentNode = document): boolean {
  return focusFirst(SETTINGS_RETURN_TARGETS, root);
}

/**
 * How long after the close the restore may still land. The same window as
 * every other `focus-when-ready` restore — see `RESTORE_WINDOW_MS` there.
 */
export const SETTINGS_RESTORE_WINDOW_MS = RESTORE_WINDOW_MS;

/**
 * {@link focusSettingsOpener} as soon as a target exists — unless someone else
 * has taken the keyboard first, or neither target shows up inside the window.
 * Returns a cancel function; a React caller returns it from its effect. See
 * `focusFirstWhenReady` for the three ways the wait ends.
 *
 * `windowMs` is a parameter so a test can close the window without waiting out
 * the real one. Callers in the app pass nothing.
 */
export function focusSettingsOpenerWhenReady(
  doc: Document = document,
  windowMs: number = SETTINGS_RESTORE_WINDOW_MS,
): () => void {
  return focusFirstWhenReady(SETTINGS_RETURN_TARGETS, doc, windowMs);
}

/**
 * Where keyboard focus goes when the new-agent dialog closes (TASK-510).
 *
 * THE BUG THIS EXISTS FOR. The "New agent…" row does not open an overlay on
 * top of the workspace. `App.tsx`'s bootstrap gate REPLACES the whole tree
 * with the dialog (and, after a create, with the "Setting up your agent…"
 * screen), so the row that opened it is destroyed on open and a fresh
 * workspace is mounted on close. The dialog's own restore
 * (`components/ui/use-opener-restore.ts`) captures a node, finds it detached,
 * and correctly bails — so Escape, Close and a finished create all used to
 * leave focus on `<body>`.
 *
 * It is the same shape as Settings (`./settings-return-focus.ts`), so it uses
 * the same mechanism: restore by IDENTITY, after the remount, with
 * `focusFirstWhenReady`. This module only says which targets.
 *
 * THE TARGETS, in order:
 *
 *   1. The "New agent…" row itself ({@link NEW_AGENT_OPENER_ATTR}) — the
 *      control that really opened the dialog. On desktop it is always on the
 *      rail, so this is where focus lands.
 *   2. The compact nav's hamburger (`NAV_TRIGGER_ATTR`). Below `md` the row
 *      lives inside the nav `Sheet`, which is closed (and so unmounted) when
 *      the workspace comes back. The hamburger is the control on screen that
 *      leads back to it — the same deliberate stand-in Settings uses
 *      (TASK-474), listed last because it stands in for anything in the sheet.
 *
 * A person who takes the keyboard during the wait (a Tab, a click, an
 * autofocus on the returning surface) keeps it; see `focusFirstWhenReady`.
 */
import { NAV_TRIGGER_ATTR, focusFirstWhenReady } from './focus-when-ready';

/**
 * Marks the control a person opens the new-agent dialog from.
 *
 * At most one rendered node should carry it — the restore takes the first
 * match in document order.
 */
export const NEW_AGENT_OPENER_ATTR = 'data-new-agent-opener';

const NEW_AGENT_RETURN_TARGETS = [
  `[${NEW_AGENT_OPENER_ATTR}]`,
  `[${NAV_TRIGGER_ATTR}]`,
] as const;

/**
 * Put focus back on the "New agent…" row — or its compact stand-in — as soon
 * as one exists. Call it once, right after the dialog's close; return the
 * canceller from the effect that called it.
 *
 * `windowMs` is a parameter so a test can close the window without waiting
 * out the real one. Callers in the app pass nothing.
 */
export function focusNewAgentOpenerWhenReady(
  doc: Document = document,
  windowMs?: number,
): () => void {
  return focusFirstWhenReady(NEW_AGENT_RETURN_TARGETS, doc, windowMs);
}

/**
 * Marks an agent's conversation region with that agent's id (TASK-533).
 *
 * It carries the id, not just a presence flag, because the workspace that
 * comes back after a create first paints whatever route it was on — often
 * ANOTHER agent's conversation — and only moves to the new agent once the
 * kickoff's send returns. A bare marker would land focus on the wrong agent.
 */
export const AGENT_CONVERSATION_ATTR = 'data-agent-conversation';

/**
 * After a FINISHED create, put focus into the new agent's conversation — the
 * thing now on screen — rather than back on the "New agent…" row (TASK-533).
 * Escape and Close still use {@link focusNewAgentOpenerWhenReady}: nothing was
 * made, so the control you came from is still the right place to stand.
 *
 * THE ONE TARGET, and no opener fallback. The sidebar (and the row in it)
 * paints BEFORE the route moves to the new agent, so listing the row second
 * would not be a fallback at all: `focusFirstWhenReady` takes the first target
 * that is present, and the row would win every time. If the new agent's view
 * never appears inside the window (a board read that fails on the way back),
 * this fails the way the original bug did — to `<body>`.
 *
 * The id is compared as a VALUE, not spliced into a selector: it is server
 * data, and an attribute-selector string built from it is one escaping bug
 * away from matching something else.
 */
export function focusNewAgentViewWhenReady(
  agentId: string,
  doc: Document = document,
  windowMs?: number,
): () => void {
  const newAgentsConversation = (root: ParentNode): HTMLElement | null => {
    for (const el of root.querySelectorAll<HTMLElement>(
      `[${AGENT_CONVERSATION_ATTR}]`,
    )) {
      if (el.getAttribute(AGENT_CONVERSATION_ATTR) === agentId) return el;
    }
    return null;
  };
  return focusFirstWhenReady([newAgentsConversation], doc, windowMs);
}

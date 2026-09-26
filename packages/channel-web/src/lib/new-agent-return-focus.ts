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
import {
  NAV_TRIGGER_ATTR,
  focusFirstWhenReady,
  keyboardIsClaimed,
  type FocusTarget,
} from './focus-when-ready';

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
 * Marks the new agent's "Loading…" pane with that agent's id (TASK-539).
 *
 * THE BUG IT EXISTS FOR. The restore below waits on two serial round-trips —
 * the kickoff's send, then the agent read — inside one
 * `RESTORE_WINDOW_MS` (2s). On a slow link the read outlasts the window, the
 * conversation region arrives after the restore has given up, and focus stays
 * on `<body>`. The loading pane is on screen from the moment the route moves
 * to the new agent, so it is a landing spot that does not wait on the read.
 * It is not only the slow path: the pane usually paints before the read
 * returns, so most creates land here first and are handed on.
 *
 * Keyed by id for the same reason as {@link AGENT_CONVERSATION_ATTR}: another
 * agent's view can be painting when the restore starts.
 *
 * A pane that took focus hands it on to the conversation when the read lands
 * (`AgentView`), because the pane is replaced — and a focused node that is
 * removed drops the keyboard on `<body>`, which is the bug again one step later.
 */
export const AGENT_LOADING_ATTR = 'data-agent-loading';

/**
 * A finder for the element carrying `attr` = `agentId`.
 *
 * The id is compared as a VALUE, not spliced into a selector: it is server
 * data, and an attribute-selector string built from it is one escaping bug
 * away from matching something else.
 */
function byAgentId(attr: string, agentId: string): FocusTarget {
  return (root: ParentNode): HTMLElement | null => {
    for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      if (el.getAttribute(attr) === agentId) return el;
    }
    return null;
  };
}

/** The conversation region of agent `agentId`, found by id. */
export function agentConversationTarget(agentId: string): FocusTarget {
  return byAgentId(AGENT_CONVERSATION_ATTR, agentId);
}

/**
 * After a FINISHED create, put focus into the new agent's conversation — the
 * thing now on screen — rather than back on the "New agent…" row (TASK-533).
 * Escape and Close still use {@link focusNewAgentOpenerWhenReady}: nothing was
 * made, so the control you came from is still the right place to stand.
 *
 * THE TARGETS, both keyed by the new agent's id, and no opener fallback:
 *
 *   1. Its conversation region — where focus should end up.
 *   2. Its "Loading…" pane ({@link AGENT_LOADING_ATTR}, TASK-539) — on screen
 *      as soon as the route moves, so a slow agent read cannot run the window
 *      out. `AgentView` moves focus from there into the conversation once the
 *      read lands.
 *
 * The sidebar (and the "New agent…" row in it) paints BEFORE the route moves
 * to the new agent, so listing the row as a fallback would not be a fallback
 * at all: `focusFirstWhenReady` takes the first target that is present, and
 * the row would win every time. If neither target appears inside the window
 * — a board read that fails on the way back, say — this fails the way the
 * original bug did, to `<body>`.
 *
 * A kickoff SEND that outlasts the window is covered one level up (TASK-547):
 * on the workspace `App.tsx` calls this again when the send returns and the
 * route moves, so that wait gets a window of its own.
 */
export function focusNewAgentViewWhenReady(
  agentId: string,
  doc: Document = document,
  windowMs?: number,
): () => void {
  return focusFirstWhenReady(
    [agentConversationTarget(agentId), byAgentId(AGENT_LOADING_ATTR, agentId)],
    doc,
    windowMs,
  );
}

/**
 * {@link focusNewAgentViewWhenReady} started a SECOND time, once the kickoff's
 * send has returned and the route has moved (TASK-547) — so a send slower
 * than the first window still ends with focus in the new agent.
 *
 * It yields to a person up front, which the first call does not need to: that
 * one runs straight after the dialog's close, when the keyboard is on
 * `<body>` by construction. This one runs seconds later, and
 * `focusFirstWhenReady`'s immediate try does not check the keyboard — so if
 * the new view has already painted by now, a person who tabbed somewhere
 * during the send would have focus pulled out from under them. It also makes
 * the re-arm a no-op when the first restore has already landed (the pane or
 * the conversation holds focus, which counts as claimed).
 */
export function refocusNewAgentViewWhenReady(
  agentId: string,
  doc: Document = document,
  windowMs?: number,
): () => void {
  if (keyboardIsClaimed(doc)) return () => {};
  return focusNewAgentViewWhenReady(agentId, doc, windowMs);
}

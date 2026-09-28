/**
 * Point at a message in the transcript from outside it — the rail's "from
 * your message" link (TASK-627).
 *
 * The rail and the thread are siblings under `AgentView`, and the thread
 * already finds its own find-highlight by querying its DOM
 * (`data-find-active`). This does the same from the other side: every message
 * carries `data-turn-id`, and a pointed-at message gets `data-memory-source`,
 * which `AgentConversation` styles with thread-find's own warning-soft
 * highlight. No prop threads through the thread, so hovering a row in the
 * rail does not re-render every message.
 *
 * Ids are compared with `getAttribute`, never spliced into a selector: a turn
 * id is opaque, and an opaque string inside a CSS selector needs escaping
 * that is easy to get wrong.
 */

export const TURN_ID_ATTR = 'data-turn-id';
export const MEMORY_SOURCE_ATTR = 'data-memory-source';

/** How long a jumped-to message stays highlighted. */
export const SOURCE_FLASH_MS = 2_000;

const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function findTurn(turnId: string): HTMLElement | null {
  for (const el of document.querySelectorAll(`[${TURN_ID_ATTR}]`)) {
    if (el instanceof HTMLElement && el.getAttribute(TURN_ID_ATTR) === turnId) return el;
  }
  return null;
}

/** Hover: highlight without scrolling. Never cancels a flash in progress. */
export function previewSource(turnId: string, on: boolean): void {
  const el = findTurn(turnId);
  if (el === null) return;
  if (on) {
    if (!el.hasAttribute(MEMORY_SOURCE_ATTR)) el.setAttribute(MEMORY_SOURCE_ATTR, 'preview');
  } else if (el.getAttribute(MEMORY_SOURCE_ATTR) === 'preview') {
    el.removeAttribute(MEMORY_SOURCE_ATTR);
  }
}

/**
 * Click: scroll the message into view and highlight it briefly. Answers
 * whether the message was on screen to jump to — a compacted or unloaded turn
 * is not, and the caller should not pretend it moved anything.
 */
export function jumpToSource(turnId: string): boolean {
  const el = findTurn(turnId);
  if (el === null) return false;
  if (typeof el.scrollIntoView === 'function') {
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }
  el.setAttribute(MEMORY_SOURCE_ATTR, 'flash');
  const prev = flashTimers.get(el);
  if (prev !== undefined) clearTimeout(prev);
  flashTimers.set(
    el,
    setTimeout(() => {
      flashTimers.delete(el);
      if (el.getAttribute(MEMORY_SOURCE_ATTR) === 'flash') el.removeAttribute(MEMORY_SOURCE_ATTR);
    }, SOURCE_FLASH_MS),
  );
  return true;
}

/**
 * Point at a message in the transcript from outside it — the rail's source
 * link, "from your message" or "from my reply" (TASK-627, TASK-642).
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

import type { ThreadMessage } from './workspace-api';

export const TURN_ID_ATTR = 'data-turn-id';
export const MEMORY_SOURCE_ATTR = 'data-memory-source';

/**
 * How a pointed-at message looks: thread-find's warning-soft fill and
 * warning edge (`ThreadFind.tsx`), so "this is the bit you asked about" looks
 * the same whichever control asked. Only a tint BEHIND the message — nothing
 * is painted as warning text on it, so there is no new contrast pair.
 */
export const MEMORY_SOURCE_CLASS =
  'transition-colors data-[memory-source]:bg-warning-soft data-[memory-source]:ring-1 data-[memory-source]:ring-warning';

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

/**
 * Who said a turn the rail can point at (TASK-642).
 *
 * The fact's `about` is its SUBJECT, not its speaker: "the go-live is Oct 14"
 * is about the person whether they said it or the agent's reply repeated it.
 * And the stored row keeps only the turn's id. So the speaker is read off the
 * turn itself, from the thread on screen — which is also the only place a
 * jump can land, so a turn missing here is one there is nothing to jump to.
 */
export type SourceSpeaker = 'person' | 'agent';

export interface TurnSource {
  speaker: SourceSpeaker;
  /** The start of what that turn said, for the link's accessible name. */
  excerpt: string;
}

/** Longest excerpt a source link's accessible name carries, before its `…`. */
export const SOURCE_EXCERPT_MAX = 60;

/**
 * The start of a message as plain words: whitespace collapsed and markdown's
 * marks dropped (an agent reply is markdown, and a screen reader would read
 * every asterisk), cut at a word boundary.
 */
export function sourceExcerpt(text: string): string {
  const plain = text
    .replace(/[*_`#>~|[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= SOURCE_EXCERPT_MAX) return plain;
  const cut = plain.slice(0, SOURCE_EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Every message turn in a thread, by the id the transcript keys it on. */
export function turnSources(thread: readonly ThreadMessage[]): Map<string, TurnSource> {
  const out = new Map<string, TurnSource>();
  for (const m of thread) {
    if (m.kind === 'user') {
      out.set(m.id, { speaker: 'person', excerpt: sourceExcerpt(m.text) });
    } else if (m.kind === 'agent' || m.kind === 'steps') {
      out.set(m.id, { speaker: 'agent', excerpt: sourceExcerpt(m.text) });
    }
  }
  return out;
}

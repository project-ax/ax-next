import { vi } from 'vitest';

/**
 * Local noon on a fixed day. Relative-time tests hang their instants off this so
 * "2 hr ago" is the same calendar day in every machine zone (a fixed UTC instant
 * is near local midnight somewhere).
 */
export const NOON = new Date(2026, 10, 26, 12, 0, 0);

/** An ISO instant `ms` before NOON (negative: after). */
export const beforeNoon = (ms: number): string => new Date(NOON.getTime() - ms).toISOString();

/** Freeze only `Date`, so timers and `waitFor` keep running. Pair with `thawClock`. */
export function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
}

export function thawClock(): void {
  vi.useRealTimers();
}

/** An element's text as sighted people read it: the `Timestamp`'s hidden full date left out. */
export function visibleText(el: Element): string {
  return Array.from(el.childNodes)
    .map((n) => {
      if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
      const e = n as Element;
      return e.classList?.contains('ax-sr-only') ? '' : visibleText(e);
    })
    .join('');
}

/**
 * A `getByText` matcher for a line whose words and `<time>` sit in one element:
 * its visible text (hidden full date left out) must equal `text`. Only the
 * element that owns text nodes matches, so a wrapper around it does not.
 */
export function byVisibleText(text: string): (content: string, el: Element | null) => boolean {
  return (_content, el) =>
    el !== null &&
    Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '') &&
    visibleText(el).replace(/\s+/g, ' ').trim() === text;
}

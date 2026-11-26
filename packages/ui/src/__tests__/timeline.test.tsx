// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MouseEvent } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StatusBadge, StatusMark, Timeline, TimelineEntry } from '../index.js';

afterEach(cleanup);

// The link's Radix tooltip measures with ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const classes = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
// A fixed "now" and explicit instants: the relative text ("5 min ago") never depends on the machine's zone.
const NOW = new Date('2026-11-26T18:00:00.000Z');
const FIVE_MIN = '2026-11-26T17:55:00.000Z';
const LONG = 'Pulled the quarterly numbers and found a mismatch between the ledger and the bank export that needs a look '.repeat(3);

describe('Timeline', () => {
  it('is an ol named by its label, with an li per entry in order', () => {
    render(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="success" />} time={FIVE_MIN} now={NOW}>First</TimelineEntry>
        <TimelineEntry mark={<StatusMark tone="info" />} time={FIVE_MIN} now={NOW}>Second</TimelineEntry>
        <TimelineEntry mark={<StatusBadge tone="neutral" size="sm">You</StatusBadge>} time={FIVE_MIN} now={NOW}>Third</TimelineEntry>
      </Timeline>,
    );
    const list = screen.getByRole('list', { name: 'Updates' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.tagName)).toEqual(['LI', 'LI', 'LI']);
    expect(items.map((li) => li.querySelector('[data-part="text"]')?.textContent)).toEqual(['First', 'Second', 'Third']);
    expect(within(items[2]!).getByText('You')).toBeTruthy();
  });

  it('renders the time as a <time> with the whole date for sighted (title) and screen-reader (hidden text) users', () => {
    render(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="success" />} time={FIVE_MIN} now={NOW}>Done</TimelineEntry>
      </Timeline>,
    );
    const time = screen.getByRole('listitem').querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe(FIVE_MIN);
    expect(time.textContent).toMatch(/^5 min ago/);
    // The relative text alone would leave a screen reader without the date: the full stamp rides along, hidden.
    const hidden = time.querySelector('.ax-sr-only')!;
    expect(hidden.textContent).toMatch(/2026/);
    expect(time.getAttribute('title')).toBe(hidden.textContent!.replace(/^ \(|\)$/g, ''));
  });

  it('renders nothing for an unparseable time rather than "Invalid Date"', () => {
    render(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="success" />} time="not a time">Done</TimelineEntry>
      </Timeline>,
    );
    expect(screen.getByRole('listitem').querySelector('time')).toBeNull();
    expect(screen.getByRole('listitem').textContent).not.toMatch(/Invalid/);
  });

  it('the action is a real, focusable link named by its label, and passes the click through', () => {
    const onNavigate = vi.fn((e: MouseEvent<HTMLAnchorElement>) => e.preventDefault());
    render(
      <Timeline label="Updates">
        <TimelineEntry
          mark={<StatusMark tone="success" />}
          time={FIVE_MIN}
          now={NOW}
          action={{ label: 'See what it did, 5 min ago', href: '/t/1', onNavigate }}
        >
          Done
        </TimelineEntry>
      </Timeline>,
    );
    const link = screen.getByRole('link', { name: 'See what it did, 5 min ago' });
    expect(link.getAttribute('href')).toBe('/t/1');
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('focusing the link shows its label in a tooltip (not just on mouse hover)', async () => {
    render(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="success" />} time={FIVE_MIN} now={NOW} action={{ label: 'See what it did, 5 min ago', href: '/t/1' }}>
          Done
        </TimelineEntry>
      </Timeline>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => screen.getByRole('link').focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe('See what it did, 5 min ago');
    expect(screen.getByRole('link').getAttribute('title')).toBeNull();
  });

  it('without an action there is no link and no tab stop, but a hidden box keeps the times aligned', () => {
    render(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="success" />} time={FIVE_MIN} now={NOW}>Done</TimelineEntry>
      </Timeline>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    const li = screen.getByRole('listitem');
    const spacer = li.querySelector('span[aria-hidden="true"]');
    expect(spacer).not.toBeNull();
    expect(spacer!.getAttribute('tabindex')).toBeNull();
  });

  it('clamps the text to two lines and truncates nothing the reader needs: detail and full are never clamped', () => {
    const { rerender } = render(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="danger" />} time={FIVE_MIN} now={NOW} detail="The bank said no.">{LONG}</TimelineEntry>
      </Timeline>,
    );
    const text = screen.getByRole('listitem').querySelector('[data-part="text"]');
    expect(classes(text)).toContain('ax-line-clamp-2');
    expect(classes(text)).toContain('ax-break-words');
    expect(text!.textContent).toBe(LONG); // clamped on screen only: the whole text is in the DOM for a screen reader
    // The flex child that holds it can shrink below its content, or a long word would push the time off the row.
    expect(classes(text!.parentElement)).toContain('ax-min-w-none');
    const detail = screen.getByRole('listitem').querySelector('[data-part="detail"]');
    expect(detail!.textContent).toBe('The bank said no.');
    expect(classes(detail).some((c) => c.includes('line-clamp'))).toBe(false);

    rerender(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="danger" />} time={FIVE_MIN} now={NOW} full>{LONG}</TimelineEntry>
      </Timeline>,
    );
    const full = screen.getByRole('listitem').querySelector('[data-part="text"]');
    expect(classes(full).some((c) => c.includes('line-clamp'))).toBe(false);
    expect(classes(full)).toContain('ax-whitespace-pre-wrap');
  });

  it('carries no divider of its own and no inline style, and renders on the server', () => {
    const html = renderToString(
      <Timeline label="Updates">
        <TimelineEntry mark={<StatusMark tone="success" />} time={FIVE_MIN} now={NOW} action={{ label: 'Open', href: '/x' }}>Done</TimelineEntry>
      </Timeline>,
    );
    expect(html).toContain('<ol');
    expect(html).toContain('<time');
    expect(html).not.toContain('style=');
    expect(html).not.toMatch(/ax-border-b|ax-divide|<hr/);
  });
});

// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Timestamp } from '../index.js';

afterEach(cleanup);

// Built from local time: a fixed UTC instant is near local midnight in some zone.
const now = new Date(2026, 9, 23, 12, 0);
const value = new Date(now.getTime() - 5 * 60_000).toISOString();

describe('Timestamp', () => {
  it('renders a <time> with an ISO dateTime and a full-date title', () => {
    const { container } = render(<Timestamp value={value} now={now} />);
    const el = container.querySelector('time');
    expect(el?.getAttribute('datetime')).toBe(value);
    expect(el?.getAttribute('title')).toMatch(/^\w{3}, \w{3} \d{1,2}, 2026, /);
    expect(el?.textContent).toContain('5 min ago');
  });

  it('relative format carries a visually hidden absolute time', () => {
    const { container } = render(<Timestamp value={value} now={now} />);
    const hidden = container.querySelector('.ax-sr-only');
    expect(hidden?.textContent).toMatch(/2026/);
  });

  it('clock format has no hidden text', () => {
    const { container } = render(<Timestamp value={value} now={now} format="clock" />);
    expect(container.querySelector('.ax-sr-only')).toBeNull();
    expect(container.querySelector('time')?.getAttribute('title')).toBeTruthy();
  });

  it('renders nothing for an unparseable value', () => {
    for (const bad of ['not a date', NaN, new Date('x')]) {
      const { container, unmount } = render(<Timestamp value={bad} />);
      expect(container.innerHTML).toBe('');
      unmount();
    }
  });

  it('server-renders without throwing', () => {
    expect(renderToString(<Timestamp value={value} now={now} />)).toContain('<time');
    expect(renderToString(<Timestamp value="nope" />)).toBe('');
  });
});

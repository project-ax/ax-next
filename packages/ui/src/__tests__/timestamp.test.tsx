// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Timestamp } from '../index.js';

afterEach(cleanup);

const now = new Date('2026-10-23T12:00:00Z');
const value = '2026-10-23T11:55:00Z';

describe('Timestamp', () => {
  it('renders a <time> with an ISO dateTime and a full-date title', () => {
    const { container } = render(<Timestamp value={value} now={now} />);
    const el = container.querySelector('time');
    expect(el?.getAttribute('datetime')).toBe('2026-10-23T11:55:00.000Z');
    expect(el?.getAttribute('title')).toMatch(/^\w{3}, \w{3} \d{1,2}, 2026, /);
    expect(el?.textContent).toContain('5 min ago');
  });

  it('relative style carries a visually hidden absolute time', () => {
    const { container } = render(<Timestamp value={value} now={now} />);
    const hidden = container.querySelector('.ax-sr-only');
    expect(hidden?.textContent).toMatch(/2026/);
  });

  it('clock style has no hidden text', () => {
    const { container } = render(<Timestamp value={value} now={now} style="clock" />);
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

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, ToastRegion } from '../index.js';

// Radix popper (IconButton tooltip) measures with ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const shown: string[] = [];
const show = (input: Parameters<typeof toast.show>[0]) => {
  let id = '';
  act(() => {
    id = toast.show(input);
  });
  shown.push(id);
  return id;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  act(() => {
    for (const id of shown.splice(0)) toast.dismiss(id);
  });
  vi.useRealTimers();
});

describe('Toast', () => {
  it('info auto-dismisses at 5000ms', () => {
    render(<ToastRegion />);
    show({ title: 'Saved' });
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(4999));
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('success auto-dismisses and a custom duration wins', () => {
    render(<ToastRegion />);
    show({ title: 'Connected', tone: 'success', duration: 100 });
    act(() => void vi.advanceTimersByTime(100));
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('danger and warning stay after 60s', () => {
    render(<ToastRegion />);
    show({ title: 'Disconnected', tone: 'danger' });
    show({ title: 'Heads up', tone: 'warning' });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(screen.getByText('Heads up')).toBeTruthy();
  });

  it('shows the description under the title', () => {
    render(<ToastRegion />);
    show({ title: 'Quota exceeded', description: 'Try again tomorrow.', tone: 'danger' });
    expect(screen.getByText('Try again tomorrow.')).toBeTruthy();
  });

  it('the Dismiss button removes the toast', () => {
    render(<ToastRegion />);
    show({ title: 'Disconnected', tone: 'danger' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Disconnected')).toBeNull();
  });

  it('dismiss(id) removes only that toast', () => {
    render(<ToastRegion />);
    show({ title: 'First', tone: 'danger' });
    const second = show({ title: 'Second', tone: 'danger' });
    show({ title: 'Third', tone: 'danger' });
    act(() => toast.dismiss(second));
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.queryByText('Second')).toBeNull();
    expect(screen.getByText('Third')).toBeTruthy();
  });

  it('dismissing clears the timer, so a later toast is not cut short', () => {
    render(<ToastRegion />);
    const id = show({ title: 'Gone' });
    act(() => toast.dismiss(id));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('five rapid shows render five, in order', () => {
    render(<ToastRegion />);
    for (const n of ['one', 'two', 'three', 'four', 'five']) show({ title: n, tone: 'danger' });
    const region = screen.getByRole('region', { name: 'Notifications' });
    const titles = within(region).getAllByText(/^(one|two|three|four|five)$/).map((el) => el.textContent);
    expect(titles).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('the region has the accessible name "Notifications" and is polite', () => {
    render(<ToastRegion />);
    expect(screen.getByRole('region', { name: 'Notifications' }).getAttribute('aria-live')).toBe('polite');
  });

  it('toasts add no per-item alert role (the polite region announces them once)', () => {
    render(<ToastRegion />);
    show({ title: 'Disconnected', tone: 'danger' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('SSR renders an empty region without throwing', () => {
    const html = renderToString(<ToastRegion />);
    expect(html).toContain('aria-label="Notifications"');
    expect(html).not.toContain('<p');
  });
});

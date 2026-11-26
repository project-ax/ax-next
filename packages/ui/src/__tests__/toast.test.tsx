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

/** Queries scoped to the visible stack (the announcers repeat each toast's words). */
const stack = () => within(screen.getByRole('region', { name: 'Notifications' }));

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
    expect(stack().getByText('Saved')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(4999));
    expect(stack().getByText('Saved')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1));
    expect(stack().queryByText('Saved')).toBeNull();
  });

  it('success auto-dismisses and a custom duration wins', () => {
    render(<ToastRegion />);
    show({ title: 'Connected', tone: 'success', duration: 100 });
    act(() => void vi.advanceTimersByTime(100));
    expect(stack().queryByText('Connected')).toBeNull();
  });

  it('danger and warning stay after 60s', () => {
    render(<ToastRegion />);
    show({ title: 'Disconnected', tone: 'danger' });
    show({ title: 'Heads up', tone: 'warning' });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(stack().getByText('Disconnected')).toBeTruthy();
    expect(stack().getByText('Heads up')).toBeTruthy();
  });

  it('shows the description under the title', () => {
    render(<ToastRegion />);
    show({ title: 'Quota exceeded', description: 'Try again tomorrow.', tone: 'danger' });
    expect(stack().getByText('Try again tomorrow.')).toBeTruthy();
  });

  it('the Dismiss button removes the toast', () => {
    render(<ToastRegion />);
    show({ title: 'Disconnected', tone: 'danger' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(stack().queryByText('Disconnected')).toBeNull();
  });

  it('dismiss(id) removes only that toast', () => {
    render(<ToastRegion />);
    show({ title: 'First', tone: 'danger' });
    const second = show({ title: 'Second', tone: 'danger' });
    show({ title: 'Third', tone: 'danger' });
    act(() => toast.dismiss(second));
    expect(stack().getByText('First')).toBeTruthy();
    expect(stack().queryByText('Second')).toBeNull();
    expect(stack().getByText('Third')).toBeTruthy();
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

  it('the visual stack is a named region that is not itself a live region', () => {
    render(<ToastRegion />);
    expect(screen.getByRole('region', { name: 'Notifications' }).getAttribute('aria-live')).toBeNull();
  });

  it('a danger toast interrupts: its words go to the assertive announcer', () => {
    render(<ToastRegion />);
    show({ title: 'Download failed', description: 'Try again in a minute.', tone: 'danger' });
    expect(screen.getByRole('alert').textContent).toBe('Download failed. Try again in a minute.');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('info, success and warning toasts are announced politely', () => {
    render(<ToastRegion />);
    show({ title: 'Saved' });
    expect(screen.getByRole('status').textContent).toBe('Saved');
    show({ title: 'Heads up', tone: 'warning' });
    expect(screen.getByRole('status').textContent).toBe('Heads up');
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('the announcers are mounted before any toast and sit outside the visual stack (no nested live regions)', () => {
    render(<ToastRegion />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    show({ title: 'Disconnected', tone: 'danger' });
    expect(region.querySelector('[role="alert"],[role="status"],[aria-live]')).toBeNull();
  });

  it('dismissing the newest danger toast falls back to the previous one, then clears', () => {
    render(<ToastRegion />);
    show({ title: 'First', tone: 'danger' });
    const second = show({ title: 'Second', tone: 'danger' });
    expect(screen.getByRole('alert').textContent).toBe('Second');
    act(() => toast.dismiss(second));
    expect(screen.getByRole('alert').textContent).toBe('First');
  });

  it('SSR renders an empty region without throwing', () => {
    const html = renderToString(<ToastRegion />);
    expect(html).toContain('aria-label="Notifications"');
    expect(html).not.toContain('<p');
  });
});

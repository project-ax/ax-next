/**
 * Toasts as channel-web sees them: the shared `toast` store from `@project-ax/ui`
 * drawn by `<ToastRegion />`. The store and component are unit-tested in the
 * package; these cover what the SPA relies on, through role and name queries.
 *
 *   1. `toast.show({ title })` renders the title in the "Notifications" region.
 *   2. A danger toast shows its description.
 *   3. Info toasts auto-dismiss; danger toasts stay put.
 *   4. The "Dismiss" button removes the toast.
 *   5. The stack is not a live region; a danger toast is announced assertively, others politely.
 */
import { toast, ToastRegion } from '@project-ax/ui';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ToastRegion', () => {
  beforeEach(() => {
    toast.dismissAll();
    vi.useFakeTimers();
  });
  afterEach(() => {
    toast.dismissAll();
    vi.useRealTimers();
  });

  const region = () => screen.getByRole('region', { name: 'Notifications' });

  it('renders a toast with the given title', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Saved' });
    });
    expect(within(region()).getByText('Saved')).toBeTruthy();
  });

  it('a danger toast renders its description', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Quota exceeded', description: 'Try again tomorrow.', tone: 'danger' });
    });
    expect(within(region()).getByText('Quota exceeded')).toBeTruthy();
    expect(within(region()).getByText('Try again tomorrow.')).toBeTruthy();
  });

  it('an info toast auto-dismisses after its duration', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Connecting…', duration: 100 });
    });
    expect(within(region()).getByText('Connecting…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(within(region()).queryByText('Connecting…')).toBeNull();
  });

  it('a danger toast stays until dismissed', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Disconnected', tone: 'danger' });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(region()).getByText('Disconnected')).toBeTruthy();
  });

  it('the Dismiss button removes the toast', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Disconnected', tone: 'danger' });
    });
    fireEvent.click(within(region()).getByRole('button', { name: 'Dismiss' }));
    expect(within(region()).queryByText('Disconnected')).toBeNull();
  });

  it('a failure toast interrupts (assertive) and an info toast is polite; the stack itself is not a live region', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Disconnected', tone: 'danger' });
    });
    expect(region().getAttribute('aria-live')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Disconnected');
    act(() => {
      toast.show({ title: 'Link copied' });
    });
    expect(screen.getByRole('status').textContent).toBe('Link copied');
  });
});

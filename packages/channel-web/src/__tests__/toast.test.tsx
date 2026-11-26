/**
 * Toasts as channel-web sees them: the shared `toast` store from `@project-ax/ui`
 * drawn by `<ToastRegion />`. The store and component are unit-tested in the
 * package; these cover what the SPA relies on, through role and name queries.
 *
 *   1. `toast.show({ title })` renders the title in the "Notifications" region.
 *   2. A danger toast shows its description.
 *   3. Info toasts auto-dismiss; danger toasts stay put.
 *   4. The "Dismiss" button removes the toast.
 *   5. The region is one polite live region; toasts add no alert role of their own.
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
    expect(screen.getByText('Connecting…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByText('Connecting…')).toBeNull();
  });

  it('a danger toast stays until dismissed', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Disconnected', tone: 'danger' });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Disconnected')).toBeTruthy();
  });

  it('the Dismiss button removes the toast', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Disconnected', tone: 'danger' });
    });
    fireEvent.click(within(region()).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Disconnected')).toBeNull();
  });

  it('is one polite live region; toasts do not add an alert role (no double announcement)', () => {
    render(<ToastRegion />);
    act(() => {
      toast.show({ title: 'Disconnected', tone: 'danger' });
    });
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

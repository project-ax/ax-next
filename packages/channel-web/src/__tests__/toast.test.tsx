/**
 * ToastStack — top-right session-level notifications.
 *
 * Behaviors under test:
 *
 *   1. `toastActions.show({ ... })` renders a toast with the given title.
 *
 *   2. `toastActions.error(title, detail)` adds the `.error` class and
 *      shows the detail line.
 *
 *   3. Auto-dismiss: info toasts (`duration > 0`) self-remove when the
 *      duration elapses; errors (default `duration: 0`) stay sticky.
 *
 *   4. Dismiss button removes the toast from the DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ToastStack } from '../components/Toast';
import { toastActions } from '../lib/toast-store';

describe('ToastStack', () => {
  beforeEach(() => {
    toastActions.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    toastActions.reset();
  });

  it('renders a toast with the given title', () => {
    render(<ToastStack />);
    act(() => {
      toastActions.show({ title: 'Saved' });
    });
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('error toast adds the .error class and renders detail', () => {
    const { container } = render(<ToastStack />);
    act(() => {
      toastActions.error('Quota exceeded', 'Try again tomorrow.');
    });
    const toast = container.querySelector('.toast');
    expect(toast?.classList.contains('error')).toBe(true);
    expect(screen.getByText('Try again tomorrow.')).toBeTruthy();
  });

  it('info toast auto-dismisses after duration', () => {
    render(<ToastStack />);
    act(() => {
      toastActions.show({ title: 'Connecting…', duration: 100 });
    });
    expect(screen.getByText('Connecting…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByText('Connecting…')).toBeNull();
  });

  it('error toast stays sticky (no auto-dismiss)', () => {
    render(<ToastStack />);
    act(() => {
      toastActions.error('Disconnected');
    });
    expect(screen.getByText('Disconnected')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Disconnected')).toBeTruthy();
  });

  it('dismiss button removes the toast', () => {
    render(<ToastStack />);
    act(() => {
      toastActions.error('Disconnected');
    });
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('Disconnected')).toBeNull();
  });
});

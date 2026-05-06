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

  it('info toast auto-dismisses after duration (two-phase)', () => {
    // Phase 1: duration timer flips the .leaving class so CSS can
    // animate the slide-out. Phase 2: 180ms later the node unmounts.
    const { container } = render(<ToastStack />);
    act(() => {
      toastActions.show({ title: 'Connecting…', duration: 100 });
    });
    expect(screen.getByText('Connecting…')).toBeTruthy();

    // Advance past the duration → leaving phase.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Still in DOM, now with `.leaving` class so the CSS animation runs.
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(container.querySelector('.toast.leaving')).toBeTruthy();

    // Advance past the leave animation → unmount.
    act(() => {
      vi.advanceTimersByTime(200);
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

  it('error toast carries role="alert" so screen readers announce immediately', () => {
    // The stack region is aria-live="polite" — fine for info toasts —
    // but error toasts override with role="alert" (assertive).
    const { container } = render(<ToastStack />);
    act(() => {
      toastActions.error('Disconnected');
    });
    const errorToast = container.querySelector('.toast.error');
    expect(errorToast?.getAttribute('role')).toBe('alert');
  });

  it('info toast does NOT carry role="alert" (polite stack region is enough)', () => {
    const { container } = render(<ToastStack />);
    act(() => {
      toastActions.show({ title: 'Saved' });
    });
    const toast = container.querySelector('.toast');
    expect(toast?.getAttribute('role')).toBeNull();
  });

  it('dismiss button slides out, then removes the toast (two-phase)', () => {
    const { container } = render(<ToastStack />);
    act(() => {
      toastActions.error('Disconnected');
    });
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    // Phase 1 — `.leaving` applied; node still in DOM for the animation.
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(container.querySelector('.toast.leaving')).toBeTruthy();
    // Phase 2 — animation finishes, node unmounts.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Disconnected')).toBeNull();
  });
});

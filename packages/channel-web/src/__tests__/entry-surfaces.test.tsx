/**
 * TASK-339 / audit B1, B2, B3, B6 — the moments before chat.
 *
 * These are the surfaces a first-time user meets before the product has shown
 * them anything, and before this card they were the least finished part of it:
 * a sign-in page that blamed the operator for the reader's wifi, a hand-rolled
 * button as the first thing anyone ever clicks, and three lowercase mono boot
 * states — one of which could hang forever with nothing on screen to suggest
 * reloading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { LoginPage, SIGN_IN_FAILED } from '../components/LoginPage';
import { BootScreen, BOOT_SLOW_HINT } from '../components/BootScreen';
import { HTTP_SESSION_ENDED } from '../lib/http';

describe('LoginPage — session expiry (B1)', () => {
  it('explains why the user is suddenly looking at a sign-in page', () => {
    render(<LoginPage sessionExpired />);
    const alert = screen.getByTestId('session-expired');
    expect(alert.textContent).toContain(HTTP_SESSION_ENDED);
  });

  it('does not colour a routine, protective event as a failure', () => {
    render(<LoginPage sessionExpired />);
    // `destructive` would make being signed out for safety look like a bug.
    expect(screen.getByTestId('session-expired').className).not.toContain(
      'text-destructive',
    );
  });

  it('says nothing about a session on a plain first visit', () => {
    render(<LoginPage />);
    expect(screen.queryByTestId('session-expired')).toBeNull();
  });
});

describe('LoginPage — failure copy (B2) and the button (B3)', () => {
  it('asks the reader to check their own connection before blaming the operator', () => {
    // The order is the fix: a failed sign-in is usually the reader's network,
    // and pointing at the installer first sends them to the wrong person.
    const connection = SIGN_IN_FAILED.indexOf('connection');
    const installer = SIGN_IN_FAILED.indexOf('installed ax');
    expect(connection).toBeGreaterThan(-1);
    expect(installer).toBeGreaterThan(-1);
    expect(connection).toBeLessThan(installer);
  });

  it('uses the shared Button, not a bespoke one', () => {
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: /sign in with google/i });
    // The hand-rolled hover-translate is gone...
    expect(button.className).not.toContain('hover:-translate-y-px');
    expect(button.className).not.toContain('hover:brightness-105');
    // ...and the shared primitive's base classes are present, including the
    // focus ring a keyboard user needs on the first control in the product.
    expect(button.className).toContain('inline-flex');
    expect(button.className).toContain('focus-visible:ring');
  });
});

describe('BootScreen — a wait with a way out (B6)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the message in sentence case, beside the brand mark', () => {
    render(<BootScreen message="Getting things ready…" />);
    const boot = screen.getByTestId('boot-screen');
    expect(within(boot).getByText('Getting things ready…')).toBeTruthy();
    // BrandMark's unbranded state is the dot + the product name; a branded
    // deploy swaps in a logo. Either way the wait now looks like this product
    // rather than a debug screen.
    expect(within(boot).getByText('ax')).toBeTruthy();
  });

  it('says nothing while the wait is still reasonable', () => {
    render(<BootScreen message="Getting things ready…" />);
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(screen.queryByText(BOOT_SLOW_HINT)).toBeNull();
  });

  it('admits something may be wrong once the wait is unreasonable', () => {
    // The real defect this guards: `App`'s boot fetch has no timeout, so a host
    // that accepts the connection and never answers left the SPA on
    // "connecting…" forever with nothing suggesting a reload.
    render(<BootScreen message="Getting things ready…" />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText(BOOT_SLOW_HINT)).toBeTruthy();
  });

  it('stays quiet for waits that are legitimately long', () => {
    render(<BootScreen message="Bringing your agent online…" slowHintAfterMs={null} />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText(BOOT_SLOW_HINT)).toBeNull();
  });
});

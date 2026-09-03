/**
 * Error-boundary WIRING — the per-surface placement in `App.tsx`.
 *
 * The unit test proves the component catches; this proves the chat shell
 * actually wraps its surfaces with it: a thread-panel throw must degrade
 * into the fallback while the sidebar stays up. If someone unwraps the
 * thread (or the boundary regresses), this goes red — the unit test alone
 * would stay green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';

vi.mock('../components/Thread', () => ({
  Thread: () => {
    throw new Error('thread render boom (wiring test)');
  },
}));

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('/admin/bootstrap-status')) return ok({ status: 'completed' });
    if (url.includes('/admin/me')) {
      return ok({ user: { id: 'u9', email: 'w@local', displayName: 'W', isAdmin: false } });
    }
    if (url.includes('/api/chat/agents')) {
      return ok([{ agentId: 'a1', displayName: 'A', visibility: 'personal' }]);
    }
    return ok({});
  }) as unknown as typeof fetch;
}

let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, pathname: '/', search: '', replace: vi.fn() },
  });
  installFetch();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  vi.restoreAllMocks();
});

describe('error-boundary wiring', () => {
  it('a throwing thread degrades to the fallback while the sidebar stays up', async () => {
    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/this part hit a snag/i)).toBeTruthy();
    });
    // Per-surface, not app-wide: the sidebar survives the thread's crash.
    expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy();
    // And the raw error never reaches the DOM.
    expect(screen.queryByText(/thread render boom/)).toBeNull();
  });
});

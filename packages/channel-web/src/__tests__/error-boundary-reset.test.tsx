/**
 * Error-boundary RESET — the chat-thread boundary's `resetKey` wiring in
 * `App.tsx`.
 *
 * The companion wiring test (`error-boundary-wiring.test.tsx`) proves a
 * thread throw degrades into the fallback. This proves the boundary
 * recovers: the fallback clears when the user switches sessions (the content
 * identity that threw is gone), while a re-render on the SAME session keeps
 * the fallback — no incidental clear. If someone unwraps the `resetKey`
 * (or the boundary regresses), this goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { sessionStoreActions } from '../lib/session-store';

const threadCtl = vi.hoisted(() => ({ shouldThrow: true }));

vi.mock('../components/Thread', () => ({
  Thread: () => {
    if (threadCtl.shouldThrow) {
      throw new Error('thread render boom (reset test)');
    }
    return <div>thread healthy</div>;
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
  // Every test starts tripped on session s1; the store is a module
  // singleton, so reset it explicitly (also re-syncs the agent store).
  threadCtl.shouldThrow = true;
  act(() => {
    sessionStoreActions.setActiveSession('s1');
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  vi.restoreAllMocks();
});

describe('error-boundary reset on session switch', () => {
  it('trip → session switch (throw fixed) → the fallback clears', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/this part hit a snag/i)).toBeTruthy();
    });
    // The new session's content is healthy and the user switches to it:
    // the old session's fallback must not stick to the new content.
    threadCtl.shouldThrow = false;
    act(() => {
      sessionStoreActions.setActiveSession('s2');
    });
    await waitFor(() => {
      expect(screen.getByText('thread healthy')).toBeTruthy();
    });
    expect(screen.queryByText(/this part hit a snag/i)).toBeNull();
  });

  it('trip → same-session re-render → the fallback persists', async () => {
    const { rerender } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/this part hit a snag/i)).toBeTruthy();
    });
    // Even with the cause fixed, staying on the same identity must not
    // incidentally clear — recovery needs Try-again or a real switch.
    threadCtl.shouldThrow = false;
    rerender(<App />);
    expect(screen.getByText(/this part hit a snag/i)).toBeTruthy();
    expect(screen.queryByText('thread healthy')).toBeNull();
  });
});

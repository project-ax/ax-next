/**
 * Error-boundary WIRING — the surface placement in `App.tsx`.
 *
 * The unit test proves the component catches; this proves App actually wraps
 * the workspace with it: a workspace throw must degrade into the fallback,
 * and the toast stack (outside the boundary on purpose) must survive it. If
 * someone unwraps the workspace, or moves the toasts inside the boundary,
 * this goes red — the unit test alone would stay green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { toastActions } from '../lib/toast-store';

vi.mock('../components/workspace/WorkspaceShell', () => ({
  WorkspaceShell: () => {
    throw new Error('workspace render boom (wiring test)');
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
  it('a throwing workspace degrades to the fallback, and toasts still reach the user', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/this part hit a snag/i)).toBeTruthy();
    });
    // The raw error never reaches the DOM.
    expect(screen.queryByText(/workspace render boom/)).toBeNull();
    // The toast stack sits OUTSIDE the boundary, so it still works.
    act(() => {
      toastActions.error('toast after the crash');
    });
    expect(await screen.findByText('toast after the crash')).toBeTruthy();
  });
});

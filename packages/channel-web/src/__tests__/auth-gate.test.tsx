import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('Auth gate', () => {
  it('shows LoginPage when /admin/me returns 401', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    });
  });

  it('shows AppContent (sidebar) when /admin/me returns a user', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      // BackendUser shape (from @ax/auth-oidc); lib/auth.ts maps to AuthUser.
      json: async () => ({
        user: { id: 'u2', email: 'alice@local', displayName: 'Alice', isAdmin: false },
      }),
    });
    // App fetches /api/agents on Sidebar mount too — handle subsequent calls
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [] }) });

    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('aside.sidebar')).toBeTruthy();
    });
  });

  it('shows loading state initially before fetch resolves', () => {
    // Don't resolve the promise — controlled
    fetchMock.mockReturnValueOnce(
      new Promise(() => {
        /* never resolves */
      }),
    );
    render(<App />);
    expect(screen.getByText(/connecting/i)).toBeTruthy();
  });

  it('shows LoginPage when /admin/me rejects (offline)', async () => {
    // Network failure — fetch rejects rather than returning a non-2xx.
    // Without the try/catch in App, the promise rejection would leave
    // authState stuck on 'loading' and the UI on "connecting…" forever.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonOk(body: unknown): MockResponse {
  return { ok: true, status: 200, json: async () => body };
}
function jsonStatus(status: number, body: unknown = {}): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

interface RouteHandlers {
  bootstrapStatus?: MockResponse | (() => Promise<MockResponse>);
  adminMe?: MockResponse | (() => Promise<MockResponse>);
  /** Fallback for any other URL (sidebar agents fetch, etc.). */
  fallback?: MockResponse;
}

function installRouteFetch(handlers: RouteHandlers): void {
  const fetchImpl = async (input: RequestInfo | URL): Promise<MockResponse> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/admin/bootstrap-status')) {
      const h = handlers.bootstrapStatus ?? jsonOk({ status: 'completed' });
      return typeof h === 'function' ? h() : h;
    }
    if (url.includes('/admin/me')) {
      const h = handlers.adminMe ?? jsonStatus(401);
      return typeof h === 'function' ? h() : h;
    }
    return handlers.fallback ?? jsonOk({});
  };
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
}

function setPathname(pathname: string): void {
  // jsdom's location is mostly read-only; spy on replace and override pathname.
  const loc = window.location;
  Object.defineProperty(window, 'location', {
    writable: true,
    value: {
      ...loc,
      pathname,
      search: '',
      replace: vi.fn(),
    },
  });
}

let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
});

describe('App boot — bootstrap gate', () => {
  it('redirects / → /setup when bootstrap status is pending', async () => {
    setPathname('/');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'pending' }),
    });
    render(<App />);
    await waitFor(() => {
      expect((window.location.replace as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('/setup');
    });
  });

  it('redirects / → /setup when bootstrap status is claimed', async () => {
    setPathname('/');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'claimed' }),
    });
    render(<App />);
    await waitFor(() => {
      expect((window.location.replace as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('/setup');
    });
  });

  it('renders SetupWizard when on /setup with pending status', async () => {
    setPathname('/setup');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'pending' }),
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Welcome to ax/i)).toBeTruthy();
    });
  });

  it('redirects /setup → / when bootstrap is already completed', async () => {
    setPathname('/setup');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
    });
    render(<App />);
    await waitFor(() => {
      expect((window.location.replace as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('/');
    });
  });
});

describe('App boot — auth gate (post-bootstrap)', () => {
  it('shows LoginPage when /admin/me returns 401', async () => {
    setPathname('/');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
      adminMe: jsonStatus(401),
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    });
  });

  it('shows AppContent (sidebar) when /admin/me returns a user', async () => {
    setPathname('/');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
      adminMe: jsonOk({
        user: { id: 'u2', email: 'alice@local', displayName: 'Alice', isAdmin: false },
      }),
      fallback: jsonOk({ agents: [] }),
    });
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy();
    });
  });

  it('shows loading state initially before fetch resolves', () => {
    setPathname('/');
    installRouteFetch({
      // bootstrap-status never resolves
      bootstrapStatus: () => new Promise(() => {}),
    });
    render(<App />);
    expect(screen.getByText(/connecting/i)).toBeTruthy();
  });

  it('shows LoginPage when /admin/me rejects (offline)', async () => {
    setPathname('/');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
      adminMe: () => Promise.reject(new Error('offline')),
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    });
  });

  it('treats bootstrap-status fetch failure as completed (no redirect, falls through to auth gate)', async () => {
    // If /admin/bootstrap-status is unreachable, App should NOT trap the
    // user in a redirect loop — it should default to the chat shell so
    // legacy deployments without the onboarding plugin keep working.
    setPathname('/');
    installRouteFetch({
      bootstrapStatus: () => Promise.reject(new Error('not registered')),
      adminMe: jsonStatus(401),
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    });
    expect((window.location.replace as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

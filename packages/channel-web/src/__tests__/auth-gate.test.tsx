import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  /** `/api/shared/*` — what a share link points at. */
  shared?: MockResponse;
  /** Fallback for any other URL (agent list, workspace board, etc.). */
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
    if (url.includes('/api/shared/') && handlers.shared !== undefined) {
      return handlers.shared;
    }
    return handlers.fallback ?? jsonOk({});
  };
  const spy = vi.fn(fetchImpl);
  globalThis.fetch = spy as unknown as typeof fetch;
  lastFetch = spy;
}

let lastFetch: ReturnType<typeof vi.fn> | undefined;
function fetchedUrls(): string[] {
  return (lastFetch?.mock.calls ?? []).map((c) => String(c[0]));
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

  it('shows the workspace when /admin/me returns a user', async () => {
    setPathname('/');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
      adminMe: jsonOk({
        user: { id: 'u2', email: 'alice@local', displayName: 'Alice', isAdmin: false },
      }),
      fallback: jsonOk({ agents: [] }),
    });
    render(<App />);
    // The workspace rail's user menu, named for the signed-in user: the gate
    // released AND the real `WorkspaceShell` loaded its board and drew its
    // chrome. Neither the sign-in page nor the boot screen carries it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Alice/ })).toBeTruthy();
    });
    expect(screen.queryByText(/Sign in with Google/i)).toBeNull();
  });

  it('shows loading state initially before fetch resolves', () => {
    setPathname('/');
    installRouteFetch({
      // bootstrap-status never resolves
      bootstrapStatus: () => new Promise(() => {}),
    });
    render(<App />);
    expect(screen.getByText(/getting things ready/i)).toBeTruthy();
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
    // user in a redirect loop — it should default to the signed-in app so
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

describe('App boot — a share link (/a/<code>)', () => {
  const CODE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123_-';
  const ALICE = { user: { id: 'u2', email: 'alice@local', displayName: 'Alice', isAdmin: false } };
  const SHARED = {
    artifact: {
      title: 'Q3 pipeline',
      kind: 'document',
      preview: 'markdown',
      extension: 'md',
      mediaType: 'text/markdown',
      sizeBytes: 12,
      updatedAt: new Date().toISOString(),
      agentName: 'Deal Desk',
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('meta[name="referrer"]').forEach((m) => m.remove());
  });

  it('signed out on /a/<code>: the login page, with the URL left alone', async () => {
    setPathname(`/a/${CODE}`);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    installRouteFetch({ bootstrapStatus: jsonOk({ status: 'completed' }), adminMe: jsonStatus(401) });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Sign in with Google/i)).toBeTruthy());
    expect(window.location.replace as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(`/a/${CODE}`);
    expect(fetchedUrls().some((u) => u.includes('/api/shared/'))).toBe(false);
    // The code cannot leak through a Referer while this page is open.
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
  });

  it('signing in from there asks to come back to the same /a/<code>', async () => {
    setPathname(`/a/${CODE}`);
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
      adminMe: jsonStatus(401),
      fallback: jsonOk({ url: 'https://accounts.google.com/o/oauth2/auth' }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Sign in with Google/i }));
    await waitFor(() => expect(fetchedUrls()).toContain('/auth/sign-in/social'));
    const call = lastFetch?.mock.calls.find((c) => String(c[0]) === '/auth/sign-in/social');
    const body = JSON.parse((call?.[1] as RequestInit).body as string) as { callbackURL: string };
    expect(body.callbackURL).toBe(`/a/${CODE}`);
  });

  it('signed in on /a/<code>: the share page, not the workspace, and the URL is not rewritten', async () => {
    setPathname(`/a/${CODE}`);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
      adminMe: jsonOk(ALICE),
      shared: jsonOk(SHARED),
      fallback: jsonOk({ agents: [] }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Q3 pipeline' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Alice/ })).toBeNull();
    expect(screen.queryByText(/Sign in with Google/i)).toBeNull();
    expect(window.location.replace as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(`/a/${CODE}`);
    // Only the share page's own reads: no agent list, no workspace board.
    expect(fetchedUrls().some((u) => u.includes('/api/workspace'))).toBe(false);
    expect(fetchedUrls()).toContain(`/api/shared/${CODE}`);
  });

  it('a malformed /a/ path is not a share page', async () => {
    setPathname('/a/not-a-code');
    installRouteFetch({
      bootstrapStatus: jsonOk({ status: 'completed' }),
      adminMe: jsonOk(ALICE),
      fallback: jsonOk({ agents: [] }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeTruthy());
    expect(fetchedUrls().some((u) => u.includes('/api/shared/'))).toBe(false);
  });
});

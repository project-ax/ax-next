/**
 * `/workspace` is a gated surface, not a dev-only bypass.
 *
 * It used to render before the auth + bootstrap gate, keyed off
 * `import.meta.env.DEV`. Now it goes through boot like every other route and
 * renders only when the server says this deployment has the preview on. These
 * tests pin the three arms of that gate, plus the fail-closed behaviour of the
 * `/api/features` client.
 *
 * `WorkspaceShell` is stubbed with a sentinel on purpose: what's under test is
 * the GATE, not the shell. Mounting the real shell would drag its data layer
 * (`workspace-api`, `workspace-context`) into every assertion for no added
 * coverage — the shell has its own tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { getSession, type AuthSession } from '../lib/auth';
import { fetchBootstrapStatus } from '../lib/bootstrap-status';
import { fetchFeatures } from '../lib/features';

vi.mock('../lib/bootstrap-status', () => ({
  fetchBootstrapStatus: vi.fn(async () => 'completed'),
}));

vi.mock('../lib/auth', async (importOriginal) => {
  // Keep signInWithGoogle real — LoginPage imports it, and only getSession
  // needs to be steerable per test.
  const actual = await importOriginal<typeof import('../lib/auth')>();
  return { ...actual, getSession: vi.fn(async () => null) };
});

vi.mock('../lib/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/features')>();
  return { ...actual, fetchFeatures: vi.fn(async () => actual.DEFAULT_FEATURES) };
});

vi.mock('../components/workspace/WorkspaceShell', () => ({
  WorkspaceShell: () => <div data-testid="workspace-shell-stub">workspace</div>,
}));

const mockGetSession = vi.mocked(getSession);
const mockFetchBootstrapStatus = vi.mocked(fetchBootstrapStatus);
const mockFetchFeatures = vi.mocked(fetchFeatures);

const ALICE: AuthSession = {
  user: { id: 'u2', email: 'alice@local', name: 'Alice', role: 'user' },
};

/**
 * Everything the chat shell fetches after boot (agent list, runtime wiring).
 * One agent so the first-run create-agent gate stays closed.
 */
function installShellFetch(): void {
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/chat/agents')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { agentId: 'a1', displayName: 'Scout', visibility: 'personal' },
        ],
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
}

function setPathname(pathname: string): void {
  // jsdom's location is mostly read-only; spy on replace and override pathname.
  const loc = window.location;
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...loc, pathname, search: '', replace: vi.fn() },
  });
}

let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  mockGetSession.mockReset();
  mockGetSession.mockResolvedValue(null);
  mockFetchBootstrapStatus.mockReset();
  mockFetchBootstrapStatus.mockResolvedValue('completed');
  mockFetchFeatures.mockReset();
  mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: false });
  installShellFetch();
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
});

describe('/workspace gate', () => {
  it('sends a signed-out visitor to the sign-in page even with the flag on', async () => {
    setPathname('/workspace');
    mockGetSession.mockResolvedValue(null);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
  });

  it('falls through to the chat shell when the flag is off', async () => {
    setPathname('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: false });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy();
    });
    expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
  });

  it('renders the workspace for a signed-in user when the flag is on', async () => {
    setPathname('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy();
    });
    expect(container.querySelector('aside[data-testid="sidebar"]')).toBeNull();
  });
});

describe('fetchFeatures — fail closed', () => {
  // The real client, not the module mock the gate tests install.
  async function realFetchFeatures() {
    const mod = await vi.importActual<typeof import('../lib/features')>('../lib/features');
    return mod.fetchFeatures();
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('returns all-off when /api/features 500s', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(realFetchFeatures()).resolves.toEqual({ agentWorkspacePreview: false });
    expect(warn).toHaveBeenCalled();
  });

  it('returns all-off when /api/features is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(realFetchFeatures()).resolves.toEqual({ agentWorkspacePreview: false });
    expect(warn).toHaveBeenCalled();
  });

  it('returns all-off when the body is malformed', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ agentWorkspacePreview: 'yes please' }),
    })) as unknown as typeof fetch;

    await expect(realFetchFeatures()).resolves.toEqual({ agentWorkspacePreview: false });
    expect(warn).toHaveBeenCalled();
  });

  it('passes a real boolean through', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ agentWorkspacePreview: true }),
    })) as unknown as typeof fetch;

    await expect(realFetchFeatures()).resolves.toEqual({ agentWorkspacePreview: true });
  });
});

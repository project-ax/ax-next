/**
 * The gate in front of the workspace (TASK-360).
 *
 * Signed in, there is one surface: the agent workspace. There is no feature
 * flag and no chat fall-through any more — every path a signed-in user lands
 * on renders `WorkspaceShell`, and the retired `/chat` addresses are REPLACEd
 * with `/` before anything reads the path. Signed out, every path is the
 * sign-in page.
 *
 * `WorkspaceShell` is stubbed with a sentinel on purpose: what's under test is
 * the GATE, not the shell. Mounting the real shell would drag its data layer
 * (`workspace-api`, `workspace-context`) into every assertion for no added
 * coverage — the shell has its own tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { getSession, type AuthSession } from '../lib/auth';
import { fetchBootstrapStatus } from '../lib/bootstrap-status';
import type { WorkspaceShellProps } from '../components/workspace/WorkspaceShell';

vi.mock('../lib/bootstrap-status', () => ({
  fetchBootstrapStatus: vi.fn(async () => 'completed'),
}));

vi.mock('../lib/auth', async (importOriginal) => {
  // Keep signInWithGoogle real — LoginPage imports it, and only getSession
  // needs to be steerable per test.
  const actual = await importOriginal<typeof import('../lib/auth')>();
  return { ...actual, getSession: vi.fn(async () => null) };
});

// `WorkspaceShell` is stubbed with a sentinel — see the file header — but the
// stub also captures the props App hands it into `lastWorkspaceShellProps` so
// the "create-agent door" tests below can inspect them without mounting the
// real shell (its own data layer has its own tests).
let lastWorkspaceShellProps: WorkspaceShellProps | undefined;
vi.mock('../components/workspace/WorkspaceShell', () => ({
  WorkspaceShell: (props: WorkspaceShellProps) => {
    lastWorkspaceShellProps = props;
    return <div data-testid="workspace-shell-stub">workspace</div>;
  },
}));

const mockGetSession = vi.mocked(getSession);
const mockFetchBootstrapStatus = vi.mocked(fetchBootstrapStatus);

const ALICE: AuthSession = {
  user: { id: 'u2', email: 'alice@local', name: 'Alice', role: 'user' },
};

/**
 * What App fetches after boot (the agent list). One agent so the first-run
 * create-agent gate stays closed.
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

/**
 * jsdom's location is mostly read-only, so it is swapped for a plain object.
 * `history.replaceState` is spied AND made to move that object, so a test can
 * assert both that the replace was called and where the address ended up.
 */
let replaceState: ReturnType<typeof vi.spyOn>;
function setLocation(pathname: string, search = '', hash = ''): void {
  const loc = window.location;
  const fake = { ...loc, pathname, search, hash, replace: vi.fn() };
  Object.defineProperty(window, 'location', { writable: true, value: fake });
  replaceState = vi
    .spyOn(window.history, 'replaceState')
    .mockImplementation((_data, _unused, url) => {
      if (typeof url !== 'string') return;
      const next = new URL(url, 'http://localhost');
      fake.pathname = next.pathname;
      fake.search = next.search;
      fake.hash = next.hash;
    });
}

let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  mockGetSession.mockReset();
  mockGetSession.mockResolvedValue(null);
  mockFetchBootstrapStatus.mockReset();
  mockFetchBootstrapStatus.mockResolvedValue('completed');
  lastWorkspaceShellProps = undefined;
  installShellFetch();
});
afterEach(() => {
  replaceState?.mockRestore();
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
});

describe('the auth gate in front of the workspace', () => {
  it.each(['/', '/workspace', '/chat'])(
    'sends a signed-out visitor on %s to the sign-in page',
    async (path) => {
      setLocation(path);
      mockGetSession.mockResolvedValue(null);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
      });
      expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
    },
  );
});

describe('signed in, every path is the workspace', () => {
  it.each(['/', '/workspace', '/workspace/agents/a1', '/somewhere/else'])(
    'renders the workspace on %s, without touching the address',
    async (path) => {
      setLocation(path);
      mockGetSession.mockResolvedValue(ALICE);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy();
      });
      // Not a retired chat address, so App leaves it alone; the shell owns
      // canonicalising workspace routes.
      expect(replaceState).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe(path);
    },
  );

  // A prefix match would swallow these; the helper matches `/chat` and
  // `/chat/` only.
  it('does not treat /chatroom as a retired chat address', async () => {
    setLocation('/chatroom');
    mockGetSession.mockResolvedValue(ALICE);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy();
    });
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('retired /chat addresses land on / (TASK-360)', () => {
  it.each([
    ['/chat', '', ''],
    ['/chat/deep/link', '', ''],
    ['/chat', '?x=1', '#h'],
    ['/chat/c-123', '?x=1', '#h'],
  ])('%s%s%s is replaced with / and ends at the workspace', async (path, search, hash) => {
    setLocation(path, search, hash);
    mockGetSession.mockResolvedValue(ALICE);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy();
    });
    // A REPLACE to bare `/` — nothing of the old address (segment, query,
    // hash) is carried over, and no Back entry is left on the dead path.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });

  it('replaces before the boot fetch resolves, not after', async () => {
    setLocation('/chat');
    let release!: () => void;
    mockFetchBootstrapStatus.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve('completed');
      }),
    );
    mockGetSession.mockResolvedValue(ALICE);

    render(<App />);

    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    await act(async () => {
      release();
    });
    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy();
    });
  });

  it('replaces a /chat address for a signed-out visitor too', async () => {
    setLocation('/chat/deep/link');
    mockGetSession.mockResolvedValue(null);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy();
    });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(window.location.pathname).toBe('/');
  });
});

/**
 * TASK-249 — the workspace gets a create-agent door, AND the kickoff that
 * door starts reaches the workspace, which is the surface that sends it.
 *
 * These tests pin two separate things: (1) `WorkspaceShell` is handed a
 * working `onCreateAgent`, and (2) a first-run kickoff is handed to
 * `WorkspaceShell` as `kickoffAgentId`.
 *
 * Test 2 deliberately drives the FIRST-RUN arm (empty agent list), not the
 * explicit "+ New agent…" path — that is the arm that actually exercises
 * `onDone`, because on first run `FirstRunAutoCreate`'s own gate-closing side
 * effect (via `hydrateAgentsOnce`) used to unmount it before `onDone` fired;
 * see the fix and its comment in `FirstRunAutoCreate.tsx`. Putting
 * `if (cancelled) return` back in front of `onDone` turns it red on
 * `expected null to be 'a-new'`.
 */
describe('workspace create-agent door + kickoff routing (TASK-249)', () => {
  it('App supplies a working onCreateAgent, and calling it opens the name dialog', async () => {
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    // installShellFetch() (from the default beforeEach) already returns one
    // agent, so the first-run gate is closed and the workspace renders
    // straight away.

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy();
    });
    expect(typeof lastWorkspaceShellProps?.onCreateAgent).toBe('function');

    act(() => {
      lastWorkspaceShellProps?.onCreateAgent?.();
    });

    await waitFor(() => {
      expect(screen.getByText('Name your agent')).toBeTruthy();
    });
    // This is the explicit "New agent…" path, not first run, so the dialog
    // must be dismissible (dismissible={!isFirstRun}) — unlike the
    // non-dismissible first-run dialog exercised in the next test.
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy();
  });

  it('hands the first-run kickoff to the workspace', async () => {
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);

    let bootstrapped = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/agents/bootstrap')) {
        bootstrapped = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agent: { agentId: 'a-new', displayName: 'Scout', visibility: 'personal' },
          }),
        };
      }
      if (url.includes('/api/chat/agents')) {
        // hydrateAgentsOnce re-fetches every call — the list must flip
        // non-empty post-bootstrap or the first-run gate re-opens.
        return {
          ok: true,
          status: 200,
          json: async () =>
            bootstrapped
              ? [{ agentId: 'a-new', displayName: 'Scout', visibility: 'personal' }]
              : [],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    render(<App />);

    // First-run: name dialog, non-dismissible.
    await waitFor(() => {
      expect(screen.getByText('Name your agent')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/agent name/i), {
      target: { value: 'Scout' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    await waitFor(() => {
      expect(lastWorkspaceShellProps?.kickoffAgentId).toBe('a-new');
    });
  });
});

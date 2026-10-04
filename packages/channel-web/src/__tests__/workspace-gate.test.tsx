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
import * as hydrate from '../lib/hydrate-agents';
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
  it('App supplies a working onCreateAgent, and calling it opens the new-agent card', async () => {
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
      expect(screen.getByText('New agent')).toBeTruthy();
    });
    // This is the explicit "New agent…" path, not first run, so the card must
    // offer a way back (mode="add") — unlike the first-run card exercised in
    // the next test, which has none.
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeTruthy();
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

    // First-run: the welcome card, with no way back.
    await waitFor(() => {
      expect(screen.getByText('Welcome to ax')).toBeTruthy();
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

/**
 * TASK-689 — the name card in BOTH flows, and the way out when a create fails.
 *
 * First run used to be a modal over an empty page (no product name, no welcome)
 * and the add-agent failure card was a dead end: "your FIRST agent", one
 * "Try again" button, Escape ignored, the workspace REPLACED by the gate — so
 * the only exit was a page reload. Each test says what it does against the old
 * `App`.
 */
describe('the name card in both flows (TASK-689)', () => {
  /**
   * `agents` is what `/api/chat/agents` answers; `bootstrap` decides whether
   * the create succeeds. `bootstrapCalls` is returned so a test can prove a
   * Cancel really did NOT create anything.
   */
  function installFlowFetch(opts: { agents: 'none' | 'one'; bootstrap: 'ok' | 'fail' }) {
    const state = { bootstrapCalls: 0, created: false };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/agents/bootstrap')) {
        state.bootstrapCalls += 1;
        if (opts.bootstrap === 'fail') {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        state.created = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agent: { agentId: 'a-new', displayName: 'Scout', visibility: 'personal' },
          }),
        };
      }
      if (url.includes('/api/chat/agents')) {
        const list =
          opts.agents === 'one' || state.created
            ? [{ agentId: 'a1', displayName: 'Scout', visibility: 'personal' }]
            : [];
        return { ok: true, status: 200, json: async () => list };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return state;
  }

  const nameField = () => screen.getByLabelText(/agent name/i);

  async function openAddFlow() {
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    act(() => {
      lastWorkspaceShellProps?.onCreateAgent?.();
    });
    await screen.findByText('New agent');
  }

  it('first run shows a branded welcome card, not a dialog', async () => {
    // OLD: a `role="dialog"` titled "Name your agent", with no product name.
    installFlowFetch({ agents: 'none', bootstrap: 'ok' });
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);

    render(<App />);

    expect(await screen.findByText('Welcome to ax')).toBeTruthy();
    expect(screen.getByText("First, let's create your personal AI assistant.")).toBeTruthy();
    // The product name, from the shared brand mark (SetupShell).
    expect(screen.getByText('ax')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    // There is nothing to go back to on first run.
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
  });

  it('adding: Cancel goes back to the workspace and creates nothing', async () => {
    // OLD: a ✕ button, no "Cancel".
    const flow = installFlowFetch({ agents: 'one', bootstrap: 'ok' });
    await openAddFlow();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    expect(screen.queryByText('New agent')).toBeNull();
    expect(flow.bootstrapCalls).toBe(0);
  });

  it('adding: Escape goes back to the workspace', async () => {
    // OLD: Radix handled it. The card is not a Radix dialog now, so this is
    // the wiring from the card's listener to `setCreateAgentOpen(false)`.
    installFlowFetch({ agents: 'one', bootstrap: 'ok' });
    await openAddFlow();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
  });

  it('adding: a failed create can be cancelled back to the workspace', async () => {
    // OLD: the failure card had only "Try again" and said "your first agent";
    // the workspace was gone and the only exit was a reload.
    installFlowFetch({ agents: 'one', bootstrap: 'fail' });
    await openAddFlow();
    fireEvent.change(nameField(), { target: { value: 'Quill' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    expect(
      await screen.findByText(/We couldn't set up Quill just now/),
    ).toBeTruthy();
    expect(screen.queryByText(/first agent/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    expect(screen.queryByText(/We couldn't set up/)).toBeNull();
  });

  it('adding: after Cancel the next "+ New agent" opens an EMPTY card', async () => {
    // A stale name from the abandoned attempt would be a small lie: the person
    // chose to walk away. Only first run's "Change name" carries a name back.
    installFlowFetch({ agents: 'one', bootstrap: 'fail' });
    await openAddFlow();
    fireEvent.change(nameField(), { target: { value: 'Quill' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));
    await screen.findByText(/We couldn't set up Quill just now/);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());

    act(() => {
      lastWorkspaceShellProps?.onCreateAgent?.();
    });
    await screen.findByText('New agent');

    expect((nameField() as HTMLInputElement).value).toBe('');
  });

  it('first run: a failed create offers "Change name", which returns to the card with the name kept', async () => {
    // OLD: only "Try again" — a name the server rejected could never be changed.
    installFlowFetch({ agents: 'none', bootstrap: 'fail' });
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    render(<App />);
    await screen.findByText('Welcome to ax');
    fireEvent.change(nameField(), { target: { value: 'Scout' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    expect(await screen.findByText("Let's get you started")).toBeTruthy();
    expect(screen.getByText(/We couldn't set up Scout just now/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /change name/i }));

    expect(await screen.findByText('Welcome to ax')).toBeTruthy();
    expect((nameField() as HTMLInputElement).value).toBe('Scout');
    // Still first run: nothing to fall back to.
    expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
  });
});

/**
 * TASK-791 — the failure card AFTER the agent was created, through the real
 * `App`, because the bug crossed a remount: "Change name" unmounts
 * `FirstRunAutoCreate`, and the id it held went with it.
 *
 * OLD: "Change name" → resubmit POSTed `/api/agents/bootstrap` a second time
 * (two agents), and the add-flow Cancel went back with the half-made agent
 * still on the server. Owner decision 2026-10-03: rename it, or delete it.
 *
 * The create succeeds and the hand-off after it (the component's hydrate)
 * fails once — the only way to reach this card with an agent on the server.
 */
describe('the failure card once the agent exists (TASK-791)', () => {
  type Call = { method: string; url: string; body: unknown };

  function installRecordingFetch(opts: {
    agents: 'none' | 'one';
    deleteStatus?: number;
  }) {
    const calls: Call[] = [];
    const state = { created: false, name: '' };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, body });
      if (url.includes('/api/agents/bootstrap')) {
        state.created = true;
        state.name = (body as { displayName: string }).displayName;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agent: { agentId: 'a-new', displayName: state.name, visibility: 'personal' },
          }),
        };
      }
      if (url.startsWith('/admin/agents/') && method === 'PATCH') {
        state.name = (body as { displayName: string }).displayName;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.startsWith('/admin/agents/') && method === 'DELETE') {
        const status = opts.deleteStatus ?? 204;
        if (status === 204) state.created = false;
        return { ok: status < 300, status, json: async () => ({}) };
      }
      if (url.includes('/api/chat/agents')) {
        const list = [
          ...(opts.agents === 'one'
            ? [{ agentId: 'a1', displayName: 'Scout', visibility: 'personal' }]
            : []),
          ...(state.created
            ? [{ agentId: 'a-new', displayName: state.name, visibility: 'personal' }]
            : []),
        ];
        return { ok: true, status: 200, json: async () => list };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return {
      calls,
      state,
      writes: () => calls.filter((c) => c.method !== 'GET'),
    };
  }

  /** The component's hand-off hydrate fails ONCE; App's own boot load is untouched. */
  function failFirstHandOff() {
    const real = hydrate.hydrateAgentsOnce;
    let failed = false;
    return vi.spyOn(hydrate, 'hydrateAgentsOnce').mockImplementation(async () => {
      if (!failed) {
        failed = true;
        throw new Error('hand-off blip');
      }
      return real();
    });
  }

  const nameField = () => screen.getByLabelText(/agent name/i);

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first run: Change name → resubmit RENAMES the same agent, never POSTs a second', async () => {
    const flow = installRecordingFetch({ agents: 'none' });
    failFirstHandOff();
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    render(<App />);
    await screen.findByText('Welcome to ax');
    fireEvent.change(nameField(), { target: { value: 'Scout' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    fireEvent.click(await screen.findByRole('button', { name: /change name/i }));
    await screen.findByText('Welcome to ax');
    fireEvent.change(nameField(), { target: { value: 'Quill' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    await waitFor(() => expect(lastWorkspaceShellProps?.kickoffAgentId).toBe('a-new'));
    expect(flow.writes().map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/agents/bootstrap', { displayName: 'Scout' }],
      ['PATCH', '/admin/agents/a-new', { displayName: 'Quill' }],
    ]);
  });

  it('adding: Cancel DELETEs the agent this flow made and returns to the workspace', async () => {
    const flow = installRecordingFetch({ agents: 'one' });
    failFirstHandOff();
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    act(() => {
      lastWorkspaceShellProps?.onCreateAgent?.();
    });
    await screen.findByText('New agent');
    fireEvent.change(nameField(), { target: { value: 'Quill' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    expect(await screen.findByText(/Cancel removes Quill/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    expect(flow.writes().map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/agents/bootstrap'],
      ['DELETE', '/admin/agents/a-new'],
    ]);
    // Never the agent that was already there.
    expect(flow.calls.some((c) => c.url.includes('/admin/agents/a1'))).toBe(false);
    expect(lastWorkspaceShellProps?.kickoffAgentId ?? null).toBeNull();
  });

  it('adding: a failed DELETE keeps the card — the person is not told it is gone', async () => {
    installRecordingFetch({ agents: 'one', deleteStatus: 500 });
    failFirstHandOff();
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    act(() => {
      lastWorkspaceShellProps?.onCreateAgent?.();
    });
    await screen.findByText('New agent');
    fireEvent.change(nameField(), { target: { value: 'Quill' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));

    expect(await screen.findByText(/We couldn't remove Quill just now/)).toBeTruthy();
    expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
  });

  it('adding: Cancel when the create itself failed sends no write besides the failed POST', async () => {
    // The control: nothing exists, so there is nothing to delete.
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, body: undefined });
      if (url.includes('/api/agents/bootstrap')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (url.includes('/api/chat/agents')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ agentId: 'a1', displayName: 'Scout', visibility: 'personal' }],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    setLocation('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    act(() => {
      lastWorkspaceShellProps?.onCreateAgent?.();
    });
    await screen.findByText('New agent');
    fireEvent.change(nameField(), { target: { value: 'Quill' } });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy());
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/agents/bootstrap'],
    ]);
  });
});

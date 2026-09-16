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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { getSession, type AuthSession } from '../lib/auth';
import { fetchBootstrapStatus } from '../lib/bootstrap-status';
import { fetchFeatures } from '../lib/features';
import { bootstrapKickoff } from '../lib/bootstrap-kickoff';
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

vi.mock('../lib/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/features')>();
  return { ...actual, fetchFeatures: vi.fn(async () => actual.DEFAULT_FEATURES) };
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
  lastWorkspaceShellProps = undefined;
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

/**
 * `/` is the landing surface, and which surface that IS depends on the flag.
 *
 * With the preview on, the workspace is home — that is the whole point of the
 * flag for the deployment that turns it on. With it off, `/` must still be the
 * chat shell, because that is what every other deployment gets and this change
 * must be invisible to them.
 *
 * Chat does not lose its address either way: it is App's fall-through branch
 * and the static-files plugin serves the SPA on any unclaimed path, so `/chat`
 * renders it. That is what makes handing `/` to the workspace safe rather than
 * a one-way door — and it is why the third test here pins `/chat` explicitly.
 */
describe('the default surface at /', () => {
  it('renders the workspace at / when the flag is on', async () => {
    setPathname('/');
    mockGetSession.mockResolvedValue(ALICE);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-stub')).toBeTruthy();
    });
    expect(container.querySelector('aside[data-testid="sidebar"]')).toBeNull();
  });

  it('still renders the chat shell at / when the flag is off', async () => {
    setPathname('/');
    mockGetSession.mockResolvedValue(ALICE);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: false });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy();
    });
    expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
  });

  it('keeps /chat on the chat shell even with the flag on', async () => {
    setPathname('/chat');
    mockGetSession.mockResolvedValue(ALICE);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy();
    });
    expect(screen.queryByTestId('workspace-shell-stub')).toBeNull();
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

/**
 * TASK-249 — the workspace gets a create-agent door, AND the kickoff that
 * door starts reaches a surface that can actually send it.
 *
 * Shipping only the door would reproduce the exact failure this card exists
 * to avoid: `bootstrapKickoff.trigger()` only ever fires through
 * `useChatThreadRuntime`, which only mounts under an `AssistantRuntimeProvider`
 * — and the workspace branch mounts none. So these tests pin two separate
 * things: (1) `WorkspaceShell` is handed a working `onCreateAgent`, and (2) a
 * first-run kickoff on the workspace path is handed to `WorkspaceShell` as
 * `kickoffAgentId`, never stranded in `bootstrapKickoff`. A third test pins
 * the chat path is untouched — the actual regression risk of "fix" #2.
 *
 * Tests 2 and 3 deliberately drive the FIRST-RUN arm (empty agent list), not
 * the explicit "+ New agent…" path — that is the arm that actually exercises
 * `onDone`, because on first run `FirstRunAutoCreate`'s own gate-closing side
 * effect (via `hydrateAgentsOnce`) used to unmount it before `onDone` fired;
 * see the fix and its comment in `FirstRunAutoCreate.tsx`. The explicit path
 * never hit that race (`createAgentOpen` keeps the gate open until `onDone`
 * itself closes it), so it would not have caught the bug either fix touches.
 */
describe('workspace create-agent door + kickoff routing (TASK-249)', () => {
  it('App supplies a working onCreateAgent, and calling it opens the name dialog', async () => {
    setPathname('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });
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

  it('hands the kickoff to the workspace, not to bootstrapKickoff', async () => {
    setPathname('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });
    const trigger = vi.spyOn(bootstrapKickoff, 'trigger');

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
    // The actual bug this card fixes: on the old code this call went through
    // and the kickoff was silently dropped, because nothing on the workspace
    // path ever registers with it.
    expect(trigger).not.toHaveBeenCalled();
  });

  /**
   * VACUITY, corrected after review. This was first written off as the
   * no-regression arm that "passes either way" — the guard that stops the new
   * `rendersWorkspace` branch from routing BOTH surfaces at the workspace. It
   * is that, but it is also stronger than that, and the weaker label was
   * wrong.
   *
   * Against `main` this test is **red**, measured by swapping `main`'s
   * `FirstRunAutoCreate.tsx` in and running it: `expected "trigger" to be
   * called 1 times, but got 0 times`. On first run the unfixed component never
   * reaches `onDone` at all — the `hydrateAgentsOnce` it awaits closes the
   * bootstrap gate, unmounts it, and its own `cancelled` guard discards the
   * completion. So `bootstrapKickoff.trigger()` is never called on the CHAT
   * path either.
   *
   * Which makes this a regression net for the `onDone` ungating as much as
   * for the branch — but it is NOT the only one, and an earlier version of
   * this comment wrongly claimed it was. Putting `if (cancelled) return` back
   * in front of `onDone` turns BOTH first-run tests red, measured: this one
   * on `expected "trigger" to be called 1 times, but got 0 times`, and `hands
   * the kickoff to the workspace` on `expected null to be 'a-new'`. The reason
   * is that `App.tsx` sets `kickoffAgentId` only inside this same `onDone`, so
   * re-gating it strands the workspace arm exactly as it strands the chat arm.
   * That is what the block header above already says: tests 2 and 3 both drive
   * the first-run arm because that is the arm that exercises `onDone`.
   *
   * What IS distinct about this test: it is the only one that asserts
   * `trigger()` **is** called, and that the workspace is never mounted — it
   * pins the CHAT branch of the `rendersWorkspace` fork, where test 2 pins the
   * workspace branch. Neither subsumes the other.
   */
  it('still uses bootstrapKickoff on the chat path (no regression)', async () => {
    setPathname('/workspace');
    mockGetSession.mockResolvedValue(ALICE);
    // Flag OFF — App falls through to the chat shell even though the path
    // would otherwise resolve to the workspace.
    mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: false });
    const trigger = vi.spyOn(bootstrapKickoff, 'trigger');

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

    await waitFor(() => {
      expect(screen.getByText('Name your agent')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/agent name/i), {
      target: { value: 'Scout' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    await waitFor(() => {
      expect(trigger).toHaveBeenCalledTimes(1);
    });
    expect(lastWorkspaceShellProps).toBeUndefined();
  });
});

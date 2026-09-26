/**
 * TASK-510 — closing the new-agent dialog from the workspace must not drop
 * focus on `<body>`.
 *
 * THE DEFECT (measured on kind in walk TASK-358). The "New agent…" row opens
 * the create flow, and `App.tsx`'s bootstrap gate REPLACES the whole tree with
 * the dialog: the row is destroyed on open, and a brand-new workspace is
 * mounted on close. Escape, the ✕, and a finished create all left focus on
 * `<body>` — the dialog's own restore (`use-opener-restore.ts`) finds its
 * captured opener detached and correctly declines to focus it.
 *
 * WHICH DIRECTION THIS FAILS IN. To `<body>`, and a detached-node restore
 * looks like a fix to any assertion that kept a handle on the old node. So
 * every assertion here re-queries the target from the CURRENT tree and checks
 * it is connected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { getSession, type AuthSession } from '../lib/auth';
import { fetchBootstrapStatus } from '../lib/bootstrap-status';
import { fetchFeatures } from '../lib/features';
import { workspaceApi, type AgentDetail } from '../lib/workspace-api';
import { autoCreateBareAgent } from '../lib/auto-create-agent';
import { RESTORE_WINDOW_MS } from '../lib/focus-when-ready';
import { rail as railFixture } from '../components/workspace/__tests__/rail-fixture';
import { clearViewport, setViewport } from '../components/workspace/__tests__/viewport';

vi.mock('../lib/bootstrap-status', () => ({
  fetchBootstrapStatus: vi.fn(async () => 'completed'),
}));

vi.mock('../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth')>();
  return { ...actual, getSession: vi.fn(async () => null) };
});

vi.mock('../lib/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/features')>();
  return { ...actual, fetchFeatures: vi.fn(async () => actual.DEFAULT_FEATURES) };
});

vi.mock('../lib/auto-create-agent', () => ({
  autoCreateBareAgent: vi.fn(),
}));

// The REAL `WorkspaceShell` mounts — the subject is the row its real sidebar
// renders. Only its data layer is mocked.
vi.mock('../lib/workspace-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(async () => ({ agents: [] })),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(async () => ({ events: [], nextBefore: null })),
      decisions: vi.fn(async () => ({ decisions: [] })),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(async () => ({ reqId: 'r1', conversationId: 'c1' })),
      streamReply: vi.fn(async () => {}),
    },
  };
});

const mockGetSession = vi.mocked(getSession);
const mockFetchBootstrapStatus = vi.mocked(fetchBootstrapStatus);
const mockFetchFeatures = vi.mocked(fetchFeatures);
const mockAutoCreate = vi.mocked(autoCreateBareAgent);

const ALICE: AuthSession = {
  user: { id: 'u2', email: 'alice@local', name: 'Alice', role: 'user' },
};

function installShellFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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
  }) as unknown as typeof fetch;
}

function setPathname(pathname: string): void {
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
  mockGetSession.mockResolvedValue(ALICE);
  mockFetchBootstrapStatus.mockReset();
  mockFetchBootstrapStatus.mockResolvedValue('completed');
  mockFetchFeatures.mockReset();
  mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });
  mockAutoCreate.mockReset();
  mockAutoCreate.mockResolvedValue({ agentId: 'a1' } as Awaited<
    ReturnType<typeof autoCreateBareAgent>
  >);
  installShellFetch();
  setPathname('/workspace');
  vi.mocked(workspaceApi.board).mockResolvedValue({ agents: [] });
});
afterEach(() => {
  clearViewport();
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
});

/** The "New agent…" row, re-queried from the CURRENT tree every time. */
function newAgentRow(): HTMLElement {
  return screen.getByRole('button', { name: /New agent/ });
}

/** The compact hamburger, re-queried from the CURRENT tree every time. */
function navTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /open navigation/i });
}

/** The new agent's conversation region, re-queried from the CURRENT tree. */
function newAgentConversation(): HTMLElement {
  return screen.getByRole('region', { name: 'Conversation with Quill' });
}

function newAgentDetail(agentId: string): AgentDetail {
  return {
    agent: {
      id: agentId,
      name: 'Quill',
      state: 'resting',
      now: null,
      counter: null,
      startedAt: null,
      stoppedReason: null,
    },
    conversationId: 'c1',
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: {
      rules: { status: 'unavailable', doc: null },
      learned: { status: 'unavailable', docs: [] },
    },
  } as unknown as AgentDetail;
}

async function openNewAgentDialog(): Promise<void> {
  fireEvent.click(await waitFor(newAgentRow));
  await screen.findByRole('dialog', { name: /Name your agent/i });
}

function expectFocusedAndConnected(target: () => HTMLElement): void {
  expect(document.activeElement).toBe(target());
  expect(document.activeElement).not.toBe(document.body);
  expect((document.activeElement as HTMLElement).isConnected).toBe(true);
}

describe('closing the new-agent dialog from the workspace (TASK-510)', () => {
  it('really does start from <body> — the restore is doing the work', async () => {
    render(<App />);
    await waitFor(newAgentRow);
    expect(document.activeElement).toBe(document.body);
  });

  it('Escape returns focus to the "New agent…" row', async () => {
    render(<App />);
    await openNewAgentDialog();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });

    await waitFor(() => expectFocusedAndConnected(newAgentRow));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Close button returns focus to the "New agent…" row', async () => {
    render(<App />);
    await openNewAgentDialog();

    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }));

    await waitFor(() => expectFocusedAndConnected(newAgentRow));
  });

  it('a completed create moves focus into the NEW agent\'s conversation (TASK-533)', async () => {
    // End-to-end wiring: `onDone` hands the created id to the close effect,
    // which picks the view restore over the opener one. Only one region mounts
    // here, so id-scoping (passing over ANOTHER agent's region) is pinned by
    // `lib/__tests__/new-agent-view-focus.test.ts`, not by this test.
    mockAutoCreate.mockResolvedValue({ agentId: 'a2' } as Awaited<
      ReturnType<typeof autoCreateBareAgent>
    >);
    vi.mocked(workspaceApi.agent).mockImplementation(async (agentId: string) =>
      newAgentDetail(agentId),
    );
    render(<App />);
    await openNewAgentDialog();

    fireEvent.change(screen.getByLabelText(/Agent name/i), {
      target: { value: 'Quill' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create agent/i }));

    await waitFor(() => expect(mockAutoCreate).toHaveBeenCalledWith('Quill'));
    await waitFor(() => expectFocusedAndConnected(newAgentConversation));
    expect(document.activeElement).not.toBe(newAgentRow());
  });

  describe('when the agent read outlasts the restore window (TASK-539)', () => {
    /** The new agent's loading pane, re-queried from the CURRENT tree. */
    function loadingPane(): HTMLElement {
      return screen.getByRole('region', { name: 'Loading conversation' });
    }

    /** Create "Quill" (a2) with its agent read held until `release()`. */
    async function createWithHeldRead(): Promise<() => void> {
      mockAutoCreate.mockResolvedValue({ agentId: 'a2' } as Awaited<
        ReturnType<typeof autoCreateBareAgent>
      >);
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      vi.mocked(workspaceApi.agent).mockImplementation(async (agentId: string) => {
        await held;
        return newAgentDetail(agentId);
      });
      render(<App />);
      await openNewAgentDialog();
      fireEvent.change(screen.getByLabelText(/Agent name/i), {
        target: { value: 'Quill' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Create agent/i }));
      await waitFor(() => expect(mockAutoCreate).toHaveBeenCalledWith('Quill'));
      return release;
    }

    /** Wait out the real restore window — the delay the card is about. */
    const outlastWindow = (): Promise<void> =>
      new Promise((r) => setTimeout(r, RESTORE_WINDOW_MS + 300));

    it('lands on the loading pane, then moves into the conversation when the read lands', async () => {
      const release = await createWithHeldRead();

      await waitFor(() => expectFocusedAndConnected(loadingPane));
      await outlastWindow();
      // Past the window, and still not on <body>.
      expectFocusedAndConnected(loadingPane);

      release();

      // The pane is REPLACED; focus must follow into the conversation rather
      // than falling to <body> with the removed node.
      await waitFor(() => expectFocusedAndConnected(newAgentConversation));
      expect(screen.queryByRole('region', { name: 'Loading conversation' })).toBeNull();
    }, 10_000);

    it('leaves a person who moved during the wait where they are', async () => {
      const release = await createWithHeldRead();
      await waitFor(() => expectFocusedAndConnected(loadingPane));

      newAgentRow().focus();
      release();

      await waitFor(() => newAgentConversation());
      expectFocusedAndConnected(newAgentRow);
    });
  });

  it('on a compact viewport, falls back to the hamburger — the row is in the closed sheet', async () => {
    setViewport(true);
    render(<App />);
    fireEvent.click(await waitFor(navTrigger));
    await openNewAgentDialog();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });

    await waitFor(() => expectFocusedAndConnected(navTrigger));
    // The premise, asserted rather than assumed: the real opener is gone.
    expect(screen.queryByRole('button', { name: /New agent/ })).toBeNull();
  });
});

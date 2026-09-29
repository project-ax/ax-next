/**
 * TASK-510 — leaving the new-agent flow from the workspace must not drop
 * focus on `<body>`.
 *
 * THE DEFECT (measured on kind in walk TASK-358). The "New agent…" row opens
 * the create flow, and `App.tsx`'s bootstrap gate REPLACES the whole tree with
 * it: the row is destroyed on open, and a brand-new workspace is mounted on
 * close. Escape, the ✕, and a finished create all left focus on `<body>` — the
 * old dialog's own restore (`use-opener-restore.ts`) found its captured opener
 * detached and correctly declined to focus it.
 *
 * TASK-689 turned that dialog into a `SetupShell` card (`NewAgentCard`): the ✕
 * became a "Cancel" button, and the failure card gained its own Cancel and
 * Escape. Those are new ways out of the flow, and every one of them must land
 * on the same restore — which is what the tests below pin.
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
    },
  } as unknown as AgentDetail;
}

async function openNewAgentCard(): Promise<void> {
  fireEvent.click(await waitFor(newAgentRow));
  // Exactly "New agent": the sidebar row it replaces reads "New agent…".
  await screen.findByText('New agent');
  await screen.findByLabelText(/Agent name/i);
}

/** Type a name and submit, then wait for the create to be attempted. */
async function createNamed(name: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Agent name/i), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: /Create agent/i }));
  await waitFor(() => expect(mockAutoCreate).toHaveBeenCalledWith(name));
}

function expectFocusedAndConnected(target: () => HTMLElement): void {
  expect(document.activeElement).toBe(target());
  expect(document.activeElement).not.toBe(document.body);
  expect((document.activeElement as HTMLElement).isConnected).toBe(true);
}

describe('leaving the new-agent flow from the workspace (TASK-510)', () => {
  it('really does start from <body> — the restore is doing the work', async () => {
    render(<App />);
    await waitFor(newAgentRow);
    expect(document.activeElement).toBe(document.body);
  });

  it('Escape returns focus to the "New agent…" row', async () => {
    render(<App />);
    await openNewAgentCard();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });

    await waitFor(() => expectFocusedAndConnected(newAgentRow));
    expect(screen.queryByLabelText(/Agent name/i)).toBeNull();
  });

  // The ✕ this used to click is gone (TASK-689): the card has a labelled Cancel.
  it('the Cancel button returns focus to the "New agent…" row', async () => {
    render(<App />);
    await openNewAgentCard();

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expectFocusedAndConnected(newAgentRow));
  });

  /**
   * TASK-689 — a failed create used to be a dead end, so there was no exit to
   * restore focus from. There are two now, and they must ride the same
   * `createAgentOpen` true → false effect as every other way out.
   *
   * VACUITY: against an `App` whose failure card has no working exit the
   * card just stays up — the row is never re-created and these time out.
   */
  describe('when the create FAILS (TASK-689)', () => {
    async function openFailureCard(): Promise<void> {
      mockAutoCreate.mockRejectedValue(new Error('boom'));
      render(<App />);
      await openNewAgentCard();
      await createNamed('Quill');
      await screen.findByText(/We couldn't set up Quill just now/);
    }

    it('Cancel on the failure card returns focus to the "New agent…" row', async () => {
      await openFailureCard();

      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

      await waitFor(() => expectFocusedAndConnected(newAgentRow));
    });

    it('Escape on the failure card returns focus to the "New agent…" row', async () => {
      await openFailureCard();

      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      });

      await waitFor(() => expectFocusedAndConnected(newAgentRow));
    });
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
    await openNewAgentCard();

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
      return screen.getByRole('region', { name: 'Loading agent' });
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
      await openNewAgentCard();
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
      expect(screen.queryByRole('region', { name: 'Loading agent' })).toBeNull();
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

  describe('when the kickoff send outlasts the restore window (TASK-547)', () => {
    /**
     * Create "Quill" (a2) with the kickoff's `sendMessage` held until
     * `release()`. The route only moves to the new agent once the send
     * resolves, so nothing keyed by a2 is on screen until then.
     */
    async function createWithHeldSend(): Promise<() => void> {
      mockAutoCreate.mockResolvedValue({ agentId: 'a2' } as Awaited<
        ReturnType<typeof autoCreateBareAgent>
      >);
      vi.mocked(workspaceApi.agent).mockImplementation(async (agentId: string) =>
        newAgentDetail(agentId),
      );
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      vi.mocked(workspaceApi.sendMessage).mockImplementationOnce(async () => {
        await held;
        return { reqId: 'r1', conversationId: 'c1' };
      });
      render(<App />);
      await openNewAgentCard();
      fireEvent.change(screen.getByLabelText(/Agent name/i), {
        target: { value: 'Quill' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Create agent/i }));
      await waitFor(() => expect(workspaceApi.sendMessage).toHaveBeenCalled());
      return release;
    }

    const outlastWindow = (): Promise<void> =>
      new Promise((r) => setTimeout(r, RESTORE_WINDOW_MS + 300));

    /**
     * VACUITY: against the unfixed code the only restore started at the
     * flow's close and gave up after `RESTORE_WINDOW_MS`, with the route
     * still on the old view — so focus stays on `<body>` and the final
     * `waitFor` times out. The first `expect` pins the premise: the window
     * really did run out with focus nowhere.
     */
    it('still lands focus in the new agent once the send returns', async () => {
      const release = await createWithHeldSend();

      await outlastWindow();
      expect(document.activeElement).toBe(document.body);

      release();

      await waitFor(() => expectFocusedAndConnected(newAgentConversation));
    }, 10_000);

    /**
     * The re-armed restore yields exactly like the first one: a person who
     * took the keyboard during the slow send keeps it.
     *
     * Measured, and stated so nobody reads more into it: this passes even
     * with `refocusNewAgentViewWhenReady`'s up-front check removed, because
     * in this order the new view paints AFTER the re-arm starts and the
     * observer's own check yields. The up-front check covers the other order
     * (view already painted) and is pinned in
     * `lib/__tests__/new-agent-view-focus.test.ts`. It also passes with the
     * whole re-arm absent (nothing moves focus off the row), so it is a guard
     * against a focus-STEALING re-arm only; the sibling test above is the one
     * that proves the fix.
     */
    it('leaves a person who moved during the slow send where they are', async () => {
      const release = await createWithHeldSend();

      await outlastWindow();
      newAgentRow().focus();
      release();

      await waitFor(() => newAgentConversation());
      // Give a wrongly re-armed restore the frame it would need to land.
      await new Promise((r) => setTimeout(r, 50));
      expectFocusedAndConnected(newAgentRow);
    }, 10_000);
  });

  it('on a compact viewport, falls back to the hamburger — the row is in the closed sheet', async () => {
    setViewport(true);
    render(<App />);
    fireEvent.click(await waitFor(navTrigger));
    await openNewAgentCard();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });

    await waitFor(() => expectFocusedAndConnected(navTrigger));
    // The premise, asserted rather than assumed: the real opener is gone.
    expect(screen.queryByRole('button', { name: /New agent/ })).toBeNull();
  });
});

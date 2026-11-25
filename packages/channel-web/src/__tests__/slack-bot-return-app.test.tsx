/**
 * TASK-1167 — coming back from Slack's Allow page for an agent's own Slack bot.
 *
 * @ax/channel-slack's bot callback sends the person's browser to
 * `/?slack-bot=connected|cancelled|failed&agentId=<id>`. The app reads that
 * once, replaces the address with that agent's Slack settings, and says what
 * happened in one toast, for a team admin who is not a workspace admin too
 * (`?slack=`, the workspace install, stays admin-only: see
 * `slack-install-return-app.test.tsx`).
 *
 * The real `App` and `WorkspaceShell` mount here with the same mocks as
 * `slack-install-return-app.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { getSession, type AuthSession } from '../lib/auth';
import { fetchBootstrapStatus } from '../lib/bootstrap-status';
import { fetchSlackStatus } from '../lib/slack-admin';
import { toast } from '@project-ax/ui';
import { rail as railFixture } from '../components/workspace/__tests__/rail-fixture';

vi.mock('../lib/bootstrap-status', () => ({
  fetchBootstrapStatus: vi.fn(async () => 'completed'),
}));

vi.mock('../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth')>();
  return { ...actual, getSession: vi.fn(async () => null) };
});

vi.mock('../lib/slack-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/slack-admin')>();
  return { ...actual, fetchSlackStatus: vi.fn() };
});

vi.mock('../lib/workspace-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(async () => ({ agents: [] })),
      agent: vi.fn(),
      route: vi.fn(),
      decisions: vi.fn(async () => ({ decisions: [] })),
      conversationDecisions: vi.fn(async () => ({ decisions: [] })),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      tasks: vi.fn(async () => ({ tasks: [], unavailableAgents: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
    },
  };
});

const ALICE: AuthSession = {
  user: { id: 'u2', email: 'alice@local', name: 'Alice', role: 'user' },
};
const ALICE_ADMIN: AuthSession = { user: { ...ALICE.user, role: 'admin' } };

function installShellFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/chat/agents')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ agentId: 'a1', displayName: 'Scout', visibility: 'personal' }],
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

let originalLocation: Location;
let replaceState: MockInstance<History['replaceState']>;

function arriveAt(search: string): void {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...originalLocation, pathname: '/', search, hash: '', replace: vi.fn() },
  });
}

beforeEach(() => {
  originalLocation = window.location;
  toast.dismissAll();
  vi.mocked(getSession).mockReset();
  vi.mocked(fetchBootstrapStatus).mockReset();
  vi.mocked(fetchBootstrapStatus).mockResolvedValue('completed');
  vi.mocked(fetchSlackStatus).mockReset();
  vi.mocked(fetchSlackStatus).mockResolvedValue({
    state: 'connected',
    botName: 'canopy',
    workspaceName: 'Canopy Works',
    connectedBy: 'Alice',
    connectedAt: '2026-11-13T12:00:00.000Z',
    leftoverApps: [],
  });
  installShellFetch();
  replaceState = vi.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  replaceState.mockRestore();
  Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  toast.dismissAll();
});

/** Where the app put the address bar for the Slack bot return, if it did. */
function movedTo(): string | undefined {
  const call = replaceState.mock.calls.find(
    ([, , url]) => url === '/' || String(url).startsWith('/?') || String(url).startsWith('/workspace/'),
  );
  return call === undefined ? undefined : String(call[2]);
}

describe('back from Slack for an agent\'s own bot (TASK-1167)', () => {
  it('a team admin who is not a workspace admin ends on the agent\'s Slack settings, hearing it once', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt('?slack-bot=connected&agentId=a1');
    render(<App />);

    const message = 'The Slack bot is live. Invite it to a channel with /invite.';
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(movedTo()).toBe('/workspace/agents/a1/settings/slack');
  });

  it.each([
    ['cancelled', "Slack install was cancelled. You can continue it from the agent's Slack settings."],
    ['failed', "We couldn't finish adding the Slack bot. Try again from the agent's Slack settings."],
  ])('%s: the toast says so, once', async (outcome, message) => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt(`?slack-bot=${outcome}&agentId=a1`);
    render(<App />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(movedTo()).toBe('/workspace/agents/a1/settings/slack');
  });

  it('an outcome with no usable agent id still says what happened, and only cleans the address', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt('?slack-bot=connected&agentId=..');
    render(<App />);
    expect(await screen.findByText('The Slack bot is live. Invite it to a channel with /invite.')).toBeInTheDocument();
    expect(movedTo()).toBe('/');
  });

  it('a word that is not one of the three is not a return: nothing is said and the address is left alone', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt('?slack-bot=hacked&agentId=a1');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument());
    expect(screen.queryByText(/Slack bot is live/)).toBeNull();
    expect(screen.queryByText(/Slack install was cancelled/)).toBeNull();
    expect(movedTo()).toBeUndefined();
  });

  it('?slack= is still the workspace install: for someone who is not an admin it says nothing', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt('?slack=connected');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument());
    expect(screen.queryByText('Slack is connected.')).toBeNull();
    expect(screen.queryByText(/Slack bot is live/)).toBeNull();
  });
});

describe("back from Slack after approving a team's bot request (TASK-1169)", () => {
  it('an admin back from approving lands in Admin › Slack with one toast, and the address ends /', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?slack-bot=connected&from=admin');
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Slack' })).toBeInTheDocument();
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
    const message = 'The Slack bot is live. Its team can add it to a channel with /invite.';
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(movedTo()).toBe('/');
  });

  it('ignores an agentId that rides along: that admin may not be able to open the agent', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?slack-bot=connected&from=admin&agentId=a1');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Slack' })).toBeInTheDocument();
    expect(movedTo()).toBe('/');
  });

  it.each([
    [
      'cancelled',
      "Slack install was cancelled, so the bot isn't added yet. Its team can cancel the request in the agent's Slack settings and ask again.",
    ],
    [
      'failed',
      "We couldn't finish adding the Slack bot. Its team can cancel the request in the agent's Slack settings and ask again.",
    ],
  ])('%s: the toast says so, once', async (outcome, message) => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt(`?slack-bot=${outcome}&from=admin`);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Slack' })).toBeInTheDocument();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(1);
  });

  it('a non-admin with from=admin gets nothing, and the address is still cleaned', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt('?slack-bot=connected&from=admin');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { level: 1, name: 'Slack' })).toBeNull();
    expect(screen.queryByText(/Slack bot is live/)).toBeNull();
    expect(fetchSlackStatus).not.toHaveBeenCalled();
    expect(movedTo()).toBe('/');
  });

  it('without from=admin an admin still lands on the agent, not in Admin › Slack', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?slack-bot=connected&agentId=a1');
    render(<App />);
    expect(await screen.findByText('The Slack bot is live. Invite it to a channel with /invite.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Slack' })).toBeNull();
    expect(movedTo()).toBe('/workspace/agents/a1/settings/slack');
  });
});

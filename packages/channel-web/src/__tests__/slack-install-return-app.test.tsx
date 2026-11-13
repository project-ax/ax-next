/**
 * TASK-1093 — coming back from Slack's Allow page.
 *
 * @ax/channel-slack's OAuth callback sends the admin's browser to
 * `/?slack=connected|cancelled|failed`. The app reads that once, takes it out
 * of the address bar, says what happened in a toast and opens Admin › Slack,
 * where the tab shows how things stand. Only an admin can have started an
 * install, so for anyone else the word is cleaned away and nothing else
 * happens: a link someone sends round can't make the app announce a
 * connection.
 *
 * The real `App`, `AdminShell` and `WorkspaceShell` mount here; their data
 * layers are mocked (the same mocks as `settings-return-focus.test.tsx`), and
 * so is Slack's (its requests are pinned in `admin-slack.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { getSession, type AuthSession } from '../lib/auth';
import { fetchBootstrapStatus } from '../lib/bootstrap-status';
import { fetchSlackStatus } from '../lib/slack-admin';
import { toastActions } from '../lib/toast-store';
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
  toastActions.reset();
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
  });
  installShellFetch();
  replaceState = vi.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  replaceState.mockRestore();
  Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  toastActions.reset();
});

/** The address the app put in the bar for the Slack return, if it did. */
function cleanedTo(): string | undefined {
  const call = replaceState.mock.calls.find(([, , url]) => url === '/' || String(url).startsWith('/?'));
  return call === undefined ? undefined : String(call[2]);
}

describe('back from Slack (TASK-1093)', () => {
  it('an admin lands on Admin › Slack, hears it is connected, and the address loses ?slack', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?slack=connected');
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Slack' })).toBeInTheDocument();
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
    expect(await screen.findByText('Slack is connected.')).toBeInTheDocument();
    expect(cleanedTo()).toBe('/');
  });

  it.each([
    ['cancelled', 'Slack install was cancelled.'],
    ['failed', "We couldn't finish connecting Slack. Try again."],
  ])('%s: the toast says so, once', async (outcome, message) => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt(`?slack=${outcome}`);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Slack' })).toBeInTheDocument();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(1);
  });

  it('someone who is not an admin gets no toast and no Settings, and the address is still cleaned', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt('?slack=connected');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { level: 1, name: 'Slack' })).toBeNull();
    expect(screen.queryByText('Slack is connected.')).toBeNull();
    expect(fetchSlackStatus).not.toHaveBeenCalled();
    expect(cleanedTo()).toBe('/');
  });

  it('a word that is not one of the three is not a return: nothing opens and nothing is said', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?slack=hacked');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { level: 1, name: 'Slack' })).toBeNull();
    expect(screen.queryByText(/Slack/)).toBeNull();
    expect(cleanedTo()).toBeUndefined();
  });
});

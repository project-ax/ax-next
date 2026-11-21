/**
 * TASK-1170 — an AX admin's DM about a bot request links to `/?admin=slack`.
 * An admin lands in Admin › Slack with no toast; anyone else gets the
 * workspace; either way the address is cleaned. Mocks mirror
 * `slack-bot-return-app.test.tsx`.
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
    leftoverApps: [],
  });
  installShellFetch();
  replaceState = vi.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  replaceState.mockRestore();
  Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  toastActions.reset();
});

function addressUrls(): string[] {
  return replaceState.mock.calls.map(([, , url]) => String(url));
}

describe('the Approve link in an admin DM (TASK-1170)', () => {
  it('an admin lands in Admin › Slack with no toast, and the address becomes /', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?admin=slack');
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Slack' })).toBeInTheDocument();
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
    expect(screen.queryByText(/Slack bot is live/)).toBeNull();
    expect(screen.queryByText('Slack is connected.')).toBeNull();
    expect(addressUrls()).toContain('/');
  });

  it('someone who is not an admin gets the workspace, no Settings, and a cleaned address', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE);
    arriveAt('?admin=slack');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { level: 1, name: 'Slack' })).toBeNull();
    expect(fetchSlackStatus).not.toHaveBeenCalled();
    expect(addressUrls()).toContain('/');
  });

  it('any other value is not a link: the address is left alone and Settings stays closed', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?admin=Slack');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { level: 1, name: 'Slack' })).toBeNull();
    expect(addressUrls()).not.toContain('/');
  });

  it('with ?slack=connected too, the install toast still shows once', async () => {
    vi.mocked(getSession).mockResolvedValue(ALICE_ADMIN);
    arriveAt('?slack=connected&admin=slack');
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Slack' })).toBeInTheDocument();
    expect(await screen.findByText('Slack is connected.')).toBeInTheDocument();
    expect(screen.getAllByText('Slack is connected.')).toHaveLength(1);
  });
});

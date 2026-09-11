/**
 * The workspace's URL, from the shell's side.
 *
 * `workspace-route.test.ts` pins the grammar; this pins that the shell
 * actually uses it — that a deep link opens what it names, that navigating
 * leaves an address behind, and that Back unwinds inside the workspace
 * instead of leaving it.
 *
 * Everything here mounts at a real `window.location`, so each test sets one
 * and the shared `beforeEach` puts it back. jsdom keeps one location per
 * FILE: without the reset, a test that drills into an agent leaves the next
 * one mounting on that agent's URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { workspaceApi } from '@/lib/workspace-api';
import { HttpError } from '@/lib/http';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const agentMock = vi.mocked(workspaceApi.agent);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

const AGENTS = [
  {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting' as const,
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  },
];

/** Mount at `path`, as a browser landing there would. */
function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: AGENTS });
  agentMock.mockReset();
  agentMock.mockResolvedValue({
    agent: AGENTS[0]!,
    conversationId: null,
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: [],
  });
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
});

describe('landing on a URL', () => {
  it('opens the agent a deep link names, on the tab it names', async () => {
    // The whole point of the card: a reload used to land on Today no matter
    // where you were.
    renderAt('/workspace/agents/a-quill/files');

    expect(await screen.findByRole('tab', { name: /files/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens Activity from its own URL', async () => {
    renderAt('/workspace/activity');

    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeTruthy();
  });

  it('rewrites bare / to the workspace root without adding history', async () => {
    // App renders the workspace at `/` when the preview is on. One canonical
    // URL per view is the goal — but a PUSH here would put a phantom entry
    // between the visitor and wherever they came from, so this must replace.
    const before = window.history.length;
    renderAt('/');

    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
    expect(window.history.length).toBe(before);
  });

  it('keeps a query string when it canonicalizes', async () => {
    renderAt('/?ref=email');

    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
    expect(window.location.search).toBe('?ref=email');
  });

  it('says so honestly when the link names an agent that is not there', async () => {
    // A shared link outlives the agent it names, and a URL is the first way
    // to reach an agent the roster never listed. The panel already has a
    // sentence for this; what is new is that a stranger's link can land on
    // it, so pin that it lands there and not on a blank shell.
    // A real HttpError: toReadOutcome classifies on the CLASS, so a plain
    // Error with a status property lands on 'failed' and the wrong sentence.
    agentMock.mockRejectedValue(
      new HttpError('/api/workspace/agents/a-gone', 404),
    );

    renderAt('/workspace/agents/a-gone');

    expect(
      await screen.findByText(/We could not open this agent/i),
    ).toBeTruthy();
  });

  it('falls back to Today on a path it cannot read', async () => {
    renderAt('/workspace/agents/%E0%A4%A');

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
  });
});

describe('navigating', () => {
  it('gives an opened agent an address', async () => {
    renderAt('/workspace');

    fireEvent.click(await screen.findByText('Quill'));

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill'),
    );
  });

  it('puts the tab in the URL, so a tab is linkable', async () => {
    renderAt('/workspace/agents/a-quill');

    // Radix Tabs activates a trigger on mousedown, not click — a bare
    // fireEvent.click leaves the tab exactly where it was.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /files/i }));

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill/files'),
    );
  });

  it('unwinds in-workspace navigation with Back', async () => {
    renderAt('/workspace');
    fireEvent.click(await screen.findByText('Quill'));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill'),
    );

    // jsdom moves the URL on back() but does not dispatch popstate for it.
    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(window.location.pathname).toBe('/workspace');
  });

  it('does not stack a history entry for the view already on screen', async () => {
    renderAt('/workspace');
    await screen.findByText('Quill');
    const before = window.history.length;

    // The sidebar's Today button, while Today is what is showing.
    fireEvent.click(screen.getByRole('button', { name: /today/i }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
    expect(window.history.length).toBe(before);
  });
});

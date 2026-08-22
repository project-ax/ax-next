/**
 * The workspace stands on the real host now, and the rule this whole task
 * exists to enforce is: everything with no real source yet renders its EMPTY
 * STATE, not a fixture. These tests pin both halves of that — what the shell
 * shows comes from the API, and what the API has nothing for says so.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { ActivityFeed } from '../ActivityFeed';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: { board: vi.fn(), agent: vi.fn(), route: vi.fn() },
  };
});

const boardMock = vi.mocked(workspaceApi.board);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

function renderShell() {
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

beforeEach(() => {
  boardMock.mockReset();
});

describe('WorkspaceShell', () => {
  it('renders the roster from the API, not a fixture', async () => {
    // Names that appear nowhere in the component sources — if they render,
    // they came off the wire.
    boardMock.mockResolvedValue({
      agents: [
        {
          id: 'a-quill',
          name: 'Quill',
          state: 'resting',
          now: null,
          counter: null,
          startedAt: null,
          stoppedReason: null,
        },
        {
          id: 'a-tern',
          name: 'Tern',
          state: 'working',
          now: null,
          counter: null,
          startedAt: null,
          stoppedReason: null,
        },
      ],
      decisions: [],
      activity: [],
    });

    renderShell();

    expect(await screen.findByText('Quill')).toBeTruthy();
    expect(screen.getByText('Tern')).toBeTruthy();
    // The prototype's cast is gone with the mock that invented it.
    expect(screen.queryByText('Scheduler')).toBeNull();
    expect(screen.queryByText('Inbox')).toBeNull();
  });

  it('shows the honest empty state when there are no decisions', async () => {
    boardMock.mockResolvedValue({ agents: [], decisions: [], activity: [] });

    renderShell();

    expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy();
  });

  it('does not offer a demo strip or a global stop', async () => {
    // Both drove mock-only routes. A control wired to nothing is worse than no
    // control, because it reads as a promise.
    boardMock.mockResolvedValue({ agents: [], decisions: [], activity: [] });

    renderShell();
    await screen.findByText('Nothing is waiting on you.');

    expect(screen.queryByText('Prototype')).toBeNull();
    expect(screen.queryByText(/Stop everything/)).toBeNull();
    expect(screen.queryByText('New agent')).toBeNull();
  });

  it('does not badge a tab with a zero', async () => {
    // "Needs you 0" is a measurement we have not made: `decisions` is empty
    // because nothing produces decisions yet, not because none are pending.
    boardMock.mockResolvedValue({ agents: [], decisions: [], activity: [] });

    renderShell();
    const tab = await screen.findByRole('radio', { name: /Needs you/ });

    expect(tab.textContent).toBe('Needs you');
    expect(tab.textContent).not.toMatch(/0/);
  });

  it('says what we know and what to try when the board will not load', async () => {
    boardMock.mockRejectedValue(new Error('workspace /state → 503'));

    renderShell();

    expect(
      await screen.findByText('We could not load your workspace.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('ActivityFeed', () => {
  it('says "Nothing recorded yet." when the feed is empty', () => {
    render(<ActivityFeed events={[]} agents={[]} />);
    expect(screen.getByText('Nothing recorded yet.')).toBeTruthy();
    // …and says WHY it is empty, so it does not read as "your agents did
    // nothing".
    expect(
      screen.getByText(/have not started keeping a record/),
    ).toBeTruthy();
  });

  it('names the agent when it is one agent\'s tab', () => {
    // The same component backs the per-agent "What it did" tab. Answering a
    // question about Quill with a sentence about "agents" reads like the
    // wrong screen.
    render(
      <ActivityFeed
        events={[]}
        agents={[
          {
            id: 'a-quill',
            name: 'Quill',
            state: 'resting',
            now: null,
            counter: null,
            startedAt: null,
            stoppedReason: null,
          },
        ]}
        agentId="a-quill"
      />,
    );

    expect(screen.getByText(/record of what Quill does/)).toBeTruthy();
    expect(screen.queryByText(/what agents do/)).toBeNull();
  });
});

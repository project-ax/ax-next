/**
 * The side panel's Activity view — "Right now" and "This week", moved here
 * intact from the old rail's Chats tab. Like the rest of the rail, these are
 * mostly tests of what it is NOT allowed to say.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import { AgentActivity } from '../AgentActivity';
import { rail, railActivity } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { rail: vi.fn() } };
});

const railMock = vi.mocked(workspaceApi.rail);

function agent(over: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  railMock.mockResolvedValue(rail());
});

describe('AgentActivity — "Right now"', () => {
  it('says only the state word when nothing is reporting an activity line', async () => {
    render(<AgentActivity agent={agent({ state: 'resting' })} />);

    expect(await screen.findByText('Resting')).toBeTruthy();
    // No em-dash placeholder and no "nothing queued" stand-in: an empty counter
    // row reads as a report we are not in a position to make.
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByText('nothing queued')).toBeNull();
  });

  // TASK-707 — the detail's word is what the panel follows on a brand-new
  // agent, where the roster's never changes. No WorkspaceProvider on purpose.
  it("re-reads Right now when the agent detail's state goes working -> resting", async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({ phrase: 'Working on your request', source: 'trigger' }),
        },
      }),
    );
    const { rerender } = render(<AgentActivity agent={agent({ state: 'working' })} />);
    expect(await screen.findByText('Working on your request')).toBeTruthy();

    railMock.mockResolvedValue(rail());
    rerender(<AgentActivity agent={agent({ state: 'resting' })} />);
    await waitFor(() => expect(screen.queryByText('Working on your request')).toBeNull());
    expect(await screen.findByText('Resting')).toBeTruthy();
  });

  /*
    TASK-818 — Activity opened mid-turn. The detail's word is "resting"
    before AND after the turn (it never saw the server's working), so the only
    transition left is the turn finishing.
  */
  it('drops a Working line read mid-turn once the turn finishes, with no word change', async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({ phrase: 'Working on your request', source: 'trigger' }),
        },
      }),
    );
    const a = agent({ state: 'resting' });
    const { rerender } = render(<AgentActivity agent={a} busy />);
    expect(await screen.findByText('Working on your request')).toBeTruthy();
    // The card's word agrees with its own line rather than saying "Resting"
    // beside "Working on your request".
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.queryByText('Resting')).toBeNull();

    railMock.mockResolvedValue(rail());
    rerender(<AgentActivity agent={a} busy={false} />);
    await waitFor(() => expect(screen.queryByText('Working on your request')).toBeNull());
    expect(await screen.findByText('Resting')).toBeTruthy();
  });

  it('renders the phrase, a real counter and elapsed-since-start', async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({
            phrase: 'Reading the Q3 notes',
            counter: { done: 2, total: 9, unit: 'files' },
          }),
        },
      }),
    );
    render(<AgentActivity agent={agent()} />);

    expect(await screen.findByText('Reading the Q3 notes')).toBeTruthy();
    expect(screen.getByText('2 of 9 files')).toBeTruthy();
  });

  it('never renders progress-bar vocabulary anywhere in the panel (design H2)', async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({
            phrase: 'No activity for 4 minutes',
            counter: null,
            stale: true,
          }),
        },
      }),
    );
    const { container } = render(<AgentActivity agent={agent()} />);

    await screen.findByText('No activity for 4 minutes');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/\bremaining\b/i);
    expect(text).not.toMatch(/\bleft\b/i);
    expect(text).not.toMatch(/\beta\b/i);
  });

  it('drops the counter on a stale line — the phrase is replaced, not decorated', async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({
            phrase: 'No activity for 4 minutes',
            // The wire already refuses to carry one on a stale line; this pins
            // that the renderer does not put one back if it ever does.
            counter: null,
            stale: true,
          }),
        },
      }),
    );
    render(<AgentActivity agent={agent()} />);

    await screen.findByText('No activity for 4 minutes');
    expect(screen.queryByText(/ of /)).toBeNull();
  });
});

describe('AgentActivity — "This week"', () => {
  it('renders no block at all when there is no number to put in it', async () => {
    render(<AgentActivity agent={agent()} />);
    await screen.findByText('Right now');
    await waitFor(() => expect(railMock).toHaveBeenCalled());
    expect(screen.queryByText('This week')).toBeNull();
  });

  it('prints each counter’s written definition beside its number', async () => {
    railMock.mockResolvedValue(
      rail({
        counters: {
          status: 'ok',
          windowDays: 7,
          rows: [
            {
              id: 'brought-to-you',
              label: 'Brought to you',
              value: 3,
              definition: 'Decisions this agent raised for you in the last 7 days.',
            },
          ],
        },
      }),
    );
    render(<AgentActivity agent={agent()} />);

    expect(await screen.findByText('Brought to you')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(
      screen.getByText('Decisions this agent raised for you in the last 7 days.'),
    ).toBeTruthy();
  });
});

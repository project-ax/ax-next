/**
 * One feed over one collection (design §7, plan task AW-10).
 *
 * The thing under test here is mostly HONESTY, not layout:
 *
 *   - a row's day and clock are computed from the reader's LOCAL date, never
 *     from a label the server picked. The prototype shipped `day: "Today"` and
 *     `time: "4:12 PM"` on the wire, which files a row under the wrong day for
 *     everyone outside the server's timezone. Those fields no longer exist, and
 *     these tests are what stops them coming back.
 *   - "we could not read it" and "there is nothing here" are different
 *     sentences, and the feed must never say the second when it means the first.
 *   - a silenced fire produced nothing, so it renders as nothing (H1). The
 *     server drops it; the client's half of that contract is that it invents no
 *     row to stand in its place.
 *
 * Every ISO instant below is built from a LOCAL `Date`, so the assertions hold
 * whatever timezone the suite runs in — a test that hardcoded `...T23:30:00Z`
 * would pass in UTC and fail in Auckland, which is the very bug being guarded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ActivityEvent, WorkspaceAgent } from '@/lib/workspace-api';
import { ActivityFeed } from '../ActivityFeed';

/** Pinned so "Today" and "Yesterday" mean something fixed. Local noon, on purpose. */
const NOW = new Date(2026, 7, 21, 12, 0, 0);

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

/** An ISO instant for a LOCAL wall-clock moment, N days before the pinned now. */
function localIso(daysAgo: number, hour = 9, minute = 30): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function event(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'a-quill|daily.md|1',
    agentId: 'a-quill',
    at: localIso(0),
    text: 'Morning inbox sweep',
    kind: 'done',
    detail: null,
    tag: 'Scheduled',
    decisionId: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActivityFeed', () => {
  it('renders a silenced fire as nothing at all', () => {
    /*
      A silenced fire never reaches this component — the route drops it, because
      claiming an outcome nobody observed is honesty rule H1. The client's half
      of that contract is the one testable here: handed the empty collection a
      silenced-only page produces, it renders its empty state and invents no row
      to fill the space.
    */
    render(<ActivityFeed events={[]} agents={[agent()]} />);
    expect(screen.getByText('Nothing recorded yet.')).toBeInTheDocument();
    expect(screen.queryByText('Scheduled')).not.toBeInTheDocument();
    expect(screen.queryByText('Morning inbox sweep')).not.toBeInTheDocument();
  });

  it('renders an errored fire as a stopped row carrying the real error', () => {
    render(
      <ActivityFeed
        events={[
          event({
            kind: 'stopped',
            text: 'Nightly backup',
            detail: 'SMTP connect timed out',
          }),
        ]}
        agents={[agent()]}
      />,
    );
    expect(screen.getByText('Nightly backup')).toBeInTheDocument();
    // The REAL error, verbatim. Not "something went wrong".
    expect(screen.getByText('SMTP connect timed out')).toBeInTheDocument();
  });

  it('buckets by local date, not by a server-supplied day label', () => {
    /*
      Two instants ~24h apart, each pinned to a local wall-clock time. They fall
      on two different LOCAL days in every timezone, so two buckets must appear
      — and neither label can have come from the payload, because `ActivityEvent`
      has no day field to carry one.
    */
    const today = event({ id: 'e-today', at: localIso(0), text: 'Ran today' });
    const earlier = event({ id: 'e-prev', at: localIso(1), text: 'Ran yesterday' });

    expect(Object.keys(today)).not.toContain('day');
    expect(Object.keys(today)).not.toContain('time');

    render(<ActivityFeed events={[today, earlier]} agents={[agent()]} />);

    expect(screen.getByText('Ran today')).toBeInTheDocument();
    expect(screen.getByText('Ran yesterday')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
  });

  it('labels an older day with a real local date rather than a relative word', () => {
    render(
      <ActivityFeed
        events={[event({ id: 'e-old', at: localIso(5), text: 'Ran last week' })]}
        agents={[agent()]}
      />,
    );
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    expect(screen.queryByText('Yesterday')).not.toBeInTheDocument();
    // Whatever the runtime's locale formats it as — the point is that it is the
    // LOCAL date of the instant, computed here, not a string off the wire.
    const expected = new Date(localIso(5)).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders the clock from the local time of the instant', () => {
    const at = localIso(0, 16, 12);
    render(<ActivityFeed events={[event({ at })]} agents={[agent()]} />);
    const expected = new Date(at).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders a row with an unreadable instant without printing "Invalid Date"', () => {
    render(
      <ActivityFeed
        events={[event({ at: 'not-a-date', text: 'Undateable run' })]}
        agents={[agent()]}
      />,
    );
    expect(screen.getByText('Undateable run')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('shows the agent column unfiltered and drops it when scoped', () => {
    const agents = [agent(), agent({ id: 'a-tern', name: 'Tern' })];
    const { rerender } = render(
      <ActivityFeed events={[event()]} agents={agents} onOpenAgent={vi.fn()} />,
    );
    expect(screen.getByText('Quill')).toBeInTheDocument();

    rerender(
      <ActivityFeed events={[event()]} agents={agents} agentId="a-quill" />,
    );
    // Under one agent's own tab its name on every row is noise, not information.
    expect(screen.queryByText('Quill')).not.toBeInTheDocument();
  });

  it('offers Load more only when there is more, and calls back when clicked', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <ActivityFeed events={[event()]} agents={[agent()]} onLoadMore={onLoadMore} />,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    rerender(
      <ActivityFeed
        events={[event()]}
        agents={[agent()]}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('says it could not read the record instead of saying there is nothing', () => {
    /*
      The failure this guards is the one that costs the most trust: a failed
      read rendered as an empty feed tells a reader their agents did nothing.
      An error is a state (H7), and it must not be collapsed into an absence.
    */
    render(
      <ActivityFeed events={[]} agents={[agent()]} error="workspace /activity → 500" />,
    );
    expect(screen.queryByText('Nothing recorded yet.')).not.toBeInTheDocument();
    expect(screen.getByText(/could not load the record/i)).toBeInTheDocument();
  });

  it('names the agent in its own empty state', () => {
    render(<ActivityFeed events={[]} agents={[agent()]} agentId="a-quill" />);
    expect(screen.getByText(/what Quill does/i)).toBeInTheDocument();
  });
});

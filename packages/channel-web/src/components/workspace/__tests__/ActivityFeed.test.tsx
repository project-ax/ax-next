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

/*
  TASK-436 — a summary and its error are both CSS-clamped to one line, and CSS
  is exactly what jsdom does not have. So these assert the recoverable half:
  the clamping element carries the untruncated string in `title`. Asserting the
  clamp itself here would be vacuous by construction.
*/
describe('a clamped activity row (TASK-436)', () => {
  it('keeps the whole summary reachable in `title`', () => {
    const text =
      'Swept the shared inbox, filed 14 receipts under 2026-Q3 and flagged three that had no matching purchase order';
    render(<ActivityFeed events={[event({ text })]} agents={[agent()]} />);
    expect(screen.getByText(text).getAttribute('title')).toBe(text);
  });

  it('keeps the whole error reachable in `title` too', () => {
    // The error is the only actionable thing on a stopped row, and it is the
    // longest — clamping it with nothing behind it loses the reason outright.
    const detail =
      'SMTP connect to mail.corp.example:587 timed out after 30s (attempt 3 of 3); last error ETIMEDOUT';
    render(
      <ActivityFeed
        events={[event({ kind: 'stopped', text: 'Nightly backup', detail })]}
        agents={[agent()]}
      />,
    );
    expect(screen.getByText(detail).getAttribute('title')).toBe(detail);
  });

  /*
    TASK-453. `awaitingScope` is the caller saying "the rows I am handing you
    belong to a collection you are not rendering" — which happens for exactly
    one render after the reader switches scope, because the feed hook re-scopes
    in an effect.

    Both false options put a sentence on screen that we have not read anything
    to back: holding the rows attributes them to the wrong agent (this feed
    drops the agent column when scoped, so there is nothing left to correct
    the reader with), and blanking lands on the empty state, whose copy says
    the record IS empty. The placeholders say the only true thing.
  */
  describe('while the rows in hand describe a different collection', () => {
    it('shows placeholders instead of the rows it was handed', () => {
      render(
        <ActivityFeed
          events={[event({ text: 'Somebody else\u2019s row' })]}
          agents={[agent()]}
          agentId="a-tern"
          awaitingScope
        />,
      );
      expect(screen.getByText('Reading the record\u2026')).toBeInTheDocument();
      expect(screen.queryByText('Somebody else\u2019s row')).toBeNull();
    });

    it('does not claim the record is empty either', () => {
      render(
        <ActivityFeed
          events={[event()]}
          agents={[agent()]}
          agentId="a-tern"
          awaitingScope
        />,
      );
      expect(screen.queryByText('Nothing recorded yet.')).toBeNull();
    });

    it('drops the previous scope\u2019s error along with its rows', () => {
      /*
        The hook clears `error` in the same reset effect that clears the list,
        so on the stale frame the error belongs to the collection just left.
        "We could not load Quill's record" is no more true of Tern's tab than
        Quill's rows are.
      */
      render(
        <ActivityFeed
          events={[]}
          agents={[agent()]}
          agentId="a-tern"
          awaitingScope
          error="We could not load the record."
        />,
      );
      expect(screen.getByText('Reading the record\u2026')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows the same placeholders before the first page of a fresh mount', () => {
      /*
        The same false emptiness reached by a different route: on mount the
        list is empty because nothing has landed yet, and the empty copy would
        tell the reader their agents have done nothing. The caller cannot
        distinguish this one by scope — both scopes agree on mount — so the
        component answers it from `loading` itself.
      */
      render(<ActivityFeed events={[]} agents={[agent()]} loading />);
      expect(screen.getByText('Reading the record\u2026')).toBeInTheDocument();
      expect(screen.queryByText('Nothing recorded yet.')).toBeNull();
    });

    it('still says the record is empty once the page has landed empty', () => {
      // The guard above must not swallow the genuinely empty record.
      render(<ActivityFeed events={[]} agents={[agent()]} loading={false} />);
      expect(screen.getByText('Nothing recorded yet.')).toBeInTheDocument();
      expect(screen.queryByText('Reading the record\u2026')).toBeNull();
    });

    it('makes no announcement promise it cannot keep', () => {
      /*
        TASK-501. The placeholder is born in the same commit as its text, so a
        live role on it would not reliably announce — and the announcement is
        not wanted (see FeedPlaceholder). Nothing in it may claim otherwise.
      */
      const { container } = render(
        <ActivityFeed events={[]} agents={[agent()]} loading />,
      );
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(container.querySelector('[aria-live]')).toBeNull();
    });
  });

  /*
    TASK-501. The props-level half of `ActivityFeedLoadMore.test.tsx`: rows in
    hand plus an error is a failed LATER page, and the rows stay.
  */
  describe('when a later page fails', () => {
    it('keeps the rows it has and puts the failure beneath them', () => {
      render(
        <ActivityFeed
          events={[event({ text: 'Morning inbox sweep' })]}
          agents={[agent()]}
          error="We could not load the record."
          hasMore
        />,
      );
      expect(screen.getByText('Morning inbox sweep')).toBeInTheDocument();
      expect(
        screen.getByText(/could not load the older entries/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/could not load the record/i)).toBeNull();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    });

    it('still says it could not read anything when there is nothing in hand', () => {
      render(
        <ActivityFeed
          events={[]}
          agents={[agent()]}
          error="We could not load the record."
        />,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        /could not load the record/i,
      );
      expect(screen.queryByText('Nothing recorded yet.')).toBeNull();
    });
  });
});

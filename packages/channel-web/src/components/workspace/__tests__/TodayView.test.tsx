/**
 * Today is where a zero does the most damage, because it sits next to a green
 * tick. "0 agents working · 0 waiting on you" under a check mark reads as a
 * report on a healthy system — and the surface cannot even know it: without
 * `session:is-alive` registered, every agent reads `resting` regardless of what
 * it is actually doing. A number we cannot back does not get rendered.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';
import { TodayView } from '../TodayView';
import { decisionFixture } from './decision-fixture';

/** The reassuring green tick that must not sit over a row of zeros. */
const CHECK_ICON = 'svg[class*="check"]';

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

/**
 * The queue's rows come from the SHARED fixture — see `decision-fixture.ts`.
 * A per-file copy would let this component and the two renderers drift apart
 * while every test still passed, each agreeing with its own invention.
 */
const decision = (over: Partial<Decision> = {}): Decision =>
  decisionFixture({
    id: 'd1',
    agentId: 'a-quill',
    attendance: 'attended',
    freshness: null,
    summary: 'Send the reply to Dana?',
    detail: 'It answers her question about the roof quote.',
    primaryLabel: 'Send it',
    secondaryLabel: 'Let me edit',
    ghostLabel: 'Leave it',
    approvedText: 'Quill sent the reply to Dana',
    dismissedText: 'You left the reply to Dana unsent',
    createdAt: new Date().toISOString(),
    ...over,
  });

function renderToday(
  over: Partial<React.ComponentProps<typeof TodayView>> = {},
) {
  return render(
    <TodayView
      decisions={[]}
      agents={[agent()]}
      filter="needs"
      expandedId={null}
      onExpand={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      onSeeActivity={vi.fn()}
      {...over}
    />,
  );
}

describe('the summary line', () => {
  it('renders no row of zeros, and no tick over one', () => {
    const { container } = renderToday();

    expect(container.textContent).not.toMatch(/0 agents working/);
    expect(container.textContent).not.toMatch(/0 waiting on you/);
    // Nothing positive to report → the whole line, tick included, is absent.
    expect(container.querySelector(CHECK_ICON)).toBeNull();
  });

  it('counts one agent in the singular', () => {
    const { container } = renderToday({ agents: [agent({ state: 'working' })] });
    // Positive control for the assertion above: with real signal the tick is
    // back, so its absence there means something.
    expect(container.querySelector(CHECK_ICON)).not.toBeNull();
    expect(screen.getByText(/1 agent working/)).toBeTruthy();
    expect(screen.queryByText(/1 agents working/)).toBeNull();
    // Still nothing waiting → that half stays off rather than reading "· 0".
    expect(screen.queryByText(/0 waiting/)).toBeNull();
  });

  it('pluralises past one', () => {
    renderToday({
      agents: [agent({ state: 'working' }), agent({ id: 'a2', state: 'working' })],
    });
    expect(screen.getByText(/2 agents working/)).toBeTruthy();
  });
});

describe('doneToday', () => {
  it('renders in the summary line when positive', () => {
    renderToday({ doneToday: 3 });
    expect(screen.getByText(/3 done today/)).toBeTruthy();
  });

  it('renders nothing when zero', () => {
    const { container } = renderToday({ doneToday: 0 });
    expect(container.textContent).not.toMatch(/done today/);
  });

  it('renders nothing when absent', () => {
    const { container } = renderToday();
    expect(container.textContent).not.toMatch(/done today/);
  });
});

describe('the empty queue', () => {
  it('orients a first-timer instead of repeating the headline', () => {
    renderToday();

    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    // The card slot used to say "Nothing needs you right now." — the same
    // sentence as the headline, two inches lower.
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();
    expect(screen.getByText(/wants your OK on/)).toBeTruthy();
  });

  it('hides the "open a row" hint when there is nothing to open', () => {
    const { container } = renderToday();
    expect(container.textContent).not.toMatch(/Open a row/);
    // "line" read like a phone line; it is a row in a list.
    expect(container.textContent).not.toMatch(/Open a line/);
  });

  it('shows the hint, in plain words, once there is a row', () => {
    renderToday({ decisions: [decision()] });

    expect(screen.getByText(/Open a row to see the detail/)).toBeTruthy();
  });
});

/*
  An empty queue is the most reassuring claim this page makes. It is only ever
  true when we managed to READ the queue — and a failed read looks exactly like
  an empty one from the outside, which is what makes this the worst place on the
  whole surface to be quietly wrong (design H7).
*/
describe('a queue we could not read', () => {
  it('never says nothing is waiting on you', () => {
    const { container } = renderToday({ error: 'workspace /decisions → 503' });

    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
    expect(
      screen.getByText('We could not check what is waiting on you.'),
    ).toBeTruthy();
    // And not the first-timer orientation either — that is the empty state,
    // and this is not empty, it is unknown.
    expect(container.textContent).not.toMatch(/wants your OK on/);
  });

  it('offers a way to try again and shows what went wrong', () => {
    const onRetry = vi.fn();
    renderToday({ error: 'workspace /decisions → 503', onRetry });

    const retry = screen.getByRole('button', { name: 'Try again' });
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('workspace /decisions → 503')).toBeTruthy();
  });

  it('does not count rows it could not read into the summary line', () => {
    const { container } = renderToday({
      error: 'boom',
      decisions: [decision(), decision({ id: 'd2' })],
    });
    expect(container.textContent).not.toMatch(/waiting on you\b.*\d/);
  });
});

describe('the first read, before it lands', () => {
  it('does not flash the empty-queue claim while it is still checking', () => {
    renderToday({ loading: true });
    expect(screen.getByText(/Checking what is waiting on you/)).toBeTruthy();
    expect(screen.queryByText(/wants your OK on/)).toBeNull();
  });
});

describe('resolved rows', () => {
  it('keeps a just-resolved row on screen so its receipt lands where the click did', () => {
    renderToday({
      decisions: [
        decision({
          status: 'executed',
          resolvedAt: new Date().toISOString(),
          undoable: true,
        }),
      ],
    });
    expect(screen.getByText('Quill sent the reply to Dana')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('drops one resolved long enough ago that nobody is still looking at it', () => {
    const { container } = renderToday({
      decisions: [
        decision({
          status: 'executed',
          resolvedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      ],
    });
    expect(container.textContent).not.toContain('Quill sent the reply to Dana');
  });
});

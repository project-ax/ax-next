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

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    agentId: 'a-quill',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'attended',
    status: 'pending',
    call: { id: 'call-1', name: 'mail__send', input: {} },
    freshness: null,
    summary: 'Send the reply to Dana?',
    detail: 'It answers her question about the roof quote.',
    preview: null,
    primaryLabel: 'Send it',
    secondaryLabel: 'Let me edit',
    ghostLabel: 'Leave it',
    approvedText: 'Quill sent the reply to Dana',
    dismissedText: 'You left the reply to Dana unsent',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    resolvedAt: null,
    staleReason: null,
    ...over,
  };
}

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
    renderToday({
      decisions: [decision()],
      onApprove: vi.fn(),
      onDismiss: vi.fn(),
      onUndo: vi.fn(),
    });

    expect(screen.getByText(/Open a row to see the detail/)).toBeTruthy();
  });
});

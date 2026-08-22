/**
 * `<InThreadApprovals />` — the approval control on the default `/` surface.
 *
 * The bug this guards is not a rendering nicety. Before TASK-261 a held tool
 * call on `/` produced prose asking the reader to approve something, and there
 * was nothing on screen able to approve it — the card only ever mounted behind
 * a preview flag on `/workspace`.
 *
 * These tests drive the REAL `useDecisionQueue` against a stubbed
 * `workspaceApi`, because the parts most worth protecting (a failed read is not
 * an empty queue; a click reaches the route) live in the seam between them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InThreadApprovals } from '../components/InThreadApprovals';
import { decisionRaisedActions } from '../lib/decision-raised-store';
import { workspaceApi, type Decision } from '../lib/workspace-api';
import {
  DECISION_READ_FAILED_TITLE,
} from '../components/workspace/decision-copy';
import {
  decisionFixture,
  resolvedFixture,
} from '../components/workspace/__tests__/decision-fixture';

// Same shape as permission-card.test.tsx: a plain function over a mutable
// holder. Spying on the real hook would swap a `useSyncExternalStore`-backed
// hook for a constant mid-lifecycle and break the rules of hooks.
let mockConversationId: string | null = 'c1';
vi.mock('../lib/use-conversation-id', () => ({
  useConversationId: () => mockConversationId,
  setActiveConversationId: () => undefined,
}));

/** The list route answers with these rows. */
function serveDecisions(decisions: Decision[]) {
  return vi
    .spyOn(workspaceApi, 'decisions')
    .mockResolvedValue({ decisions });
}

describe('InThreadApprovals', () => {
  beforeEach(() => {
    mockConversationId = 'c1';
    decisionRaisedActions.resetForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    decisionRaisedActions.resetForTest();
  });

  it('renders the open decision for the active conversation, with its own labels', async () => {
    serveDecisions([decisionFixture()]);
    render(<InThreadApprovals />);

    expect(await screen.findByTestId('approval-d-marcus')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave it' })).toBeInTheDocument();
    // The region is announced, but nothing steals focus.
    expect(
      screen.getByRole('region', { name: 'Waiting for your approval' }),
    ).toBeInTheDocument();
  });

  it('renders nothing for a decision belonging to a different conversation', async () => {
    const read = serveDecisions([
      decisionFixture({ id: 'd-other', conversationId: 'c2' }),
    ]);
    const { container } = render(<InThreadApprovals />);

    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByTestId('approval-d-other')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on the welcome state, where there is no conversation yet', async () => {
    mockConversationId = null;
    const read = serveDecisions([decisionFixture({ conversationId: 'c1' })]);
    const { container } = render(<InThreadApprovals />);

    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('shows ONE card — the oldest — plus a count of what is behind it', async () => {
    serveDecisions([
      decisionFixture({
        id: 'd-newer',
        summary: 'Newer',
        createdAt: new Date(Date.now() - 1000).toISOString(),
      }),
      decisionFixture({
        id: 'd-older',
        summary: 'Older',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    render(<InThreadApprovals />);

    // The oldest is the one on screen; the newer one waits its turn rather than
    // being pushed off the top of a fixed, upward-growing cluster.
    expect(await screen.findByTestId('approval-d-older')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-d-newer')).toBeNull();
    expect(screen.getByText('1 of 2 waiting on you')).toBeInTheDocument();
  });

  it('says nothing about a queue of one', async () => {
    serveDecisions([decisionFixture()]);
    render(<InThreadApprovals />);
    await screen.findByTestId('approval-d-marcus');
    expect(screen.queryByText(/waiting on you$/)).toBeNull();
  });

  it('draws a resolved row as a receipt that can still be taken back', async () => {
    serveDecisions([resolvedFixture('executed')]);
    render(<InThreadApprovals />);

    const receipt = await screen.findByTestId('approval-d-marcus');
    expect(receipt).toHaveAttribute('data-status', 'executed');
    expect(
      screen.getByText('Scheduler moved your 1:1 with Marcus to Thursday 9:30'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
  });

  /*
    Quiet ON SCREEN, and the second half of that sentence is the point. This
    test used to assert only the silence, which enshrined it: on a default
    deployment `/workspace` and the Today queue are flag-gated off, so this is
    the ONLY decision surface, and a failed first read with no signal anywhere
    leaves the reader with prose saying the agent is waiting and nothing to act
    on — this card's own dead end, on the error path.
  */
  it('stays quiet on screen when the read fails and nothing says a decision exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = vi
      .spyOn(workspaceApi, 'decisions')
      .mockRejectedValue(new Error('boom'));
    const { container } = render(<InThreadApprovals />);

    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByText(DECISION_READ_FAILED_TITLE)).toBeNull();
    expect(container.firstChild).toBeNull();

    // Quiet is not silent — an operator can still find this.
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0]?.[0]).toContain('[decisions]');
  });

  it('logs a failed read even when it DOES surface it, and only once per failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(workspaceApi, 'decisions').mockRejectedValue(new Error('boom'));
    decisionRaisedActions.raise();
    const { rerender } = render(<InThreadApprovals />);

    await waitFor(() =>
      expect(screen.getByText(DECISION_READ_FAILED_TITLE)).toBeInTheDocument(),
    );
    const after = warn.mock.calls.length;
    expect(after).toBeGreaterThan(0);

    // A re-render is not a new failure. The cards on this surface re-render on
    // their own clock, so an un-deduped log would spam a console once a second.
    rerender(<InThreadApprovals />);
    expect(warn.mock.calls.length).toBe(after);
  });

  it('speaks up when the read fails AND a live frame says something is waiting', async () => {
    vi.spyOn(workspaceApi, 'decisions').mockRejectedValue(new Error('boom'));
    decisionRaisedActions.raise();
    render(<InThreadApprovals />);

    expect(
      await screen.findByText(DECISION_READ_FAILED_TITLE),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });

    const readAgain = vi
      .spyOn(workspaceApi, 'decisions')
      .mockResolvedValue({ decisions: [decisionFixture()] });
    fireEvent.click(retry);
    expect(await screen.findByTestId('approval-d-marcus')).toBeInTheDocument();
    expect(readAgain).toHaveBeenCalled();
    expect(screen.queryByText(DECISION_READ_FAILED_TITLE)).toBeNull();
  });

  it('the primary button reaches the approve route and applies the row it returns', async () => {
    serveDecisions([decisionFixture()]);
    const approve = vi
      .spyOn(workspaceApi, 'approveDecision')
      .mockResolvedValue({
        decision: resolvedFixture('executed'),
        executed: true,
        path: 'host-replays',
        error: null,
        pendingUntil: null,
      });

    render(<InThreadApprovals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith('d-marcus'));
    // The card became its own receipt — from the server's row, not a guess.
    await waitFor(() =>
      expect(screen.getByTestId('approval-d-marcus')).toHaveAttribute(
        'data-status',
        'executed',
      ),
    );
  });

  /*
    Review finding 5. A resolved row keeps its Undo for ten seconds, so this
    region renders with nothing open in it — and announcing "waiting for your
    approval" over something already answered tells a screen-reader user the
    opposite of the truth.
  */
  it('does not announce a wait when it is holding receipts only', async () => {
    serveDecisions([resolvedFixture('executed')]);
    render(<InThreadApprovals />);

    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Recent approvals' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: 'Waiting for your approval' })).toBeNull();
  });

  /*
    Review finding: the live region must not contain the Undo countdown.

    `aria-live` used to sit on the whole cluster, which announced arrival — and
    also announced every mutation inside it. A settled receipt inside its undo
    window re-renders `Undo | Ns` once a SECOND off `useDecisionClock`, so a
    screen-reader user got up to ten announcements per resolved decision and the
    one that mattered was buried. The announcer is now a separate node holding
    one stable sentence.
  */
  it('keeps the ticking undo countdown out of the live region', async () => {
    serveDecisions([resolvedFixture('executed')]);
    const { container } = render(<InThreadApprovals />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument(),
    );

    const live = container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    // The one live node holds a sentence, never a card and never a counter.
    expect(live[0]!.querySelector('button')).toBeNull();
    expect(live[0]!.textContent ?? '').not.toMatch(/\d+s/);
  });

  it('announces a wait when something really is open', async () => {
    serveDecisions([decisionFixture()]);
    render(<InThreadApprovals />);

    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Waiting for your approval' }),
      ).toBeInTheDocument(),
    );
  });
});

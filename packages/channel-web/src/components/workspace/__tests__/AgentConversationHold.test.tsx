/**
 * TASK-275 — the `/workspace` composer holds while an approval is open.
 *
 * `AgentConversation` owns its own composer (it is not the `/` `Composer`),
 * so the hold is pinned here separately: while an approval pointed at BY THIS
 * THREAD is still open the field and Send go quiet, the reason copy names
 * why, and a send — click or Enter — goes nowhere with the draft left where
 * it was. Thread-scoped, deliberately: `decisions` is the global queue, so an
 * open row for another agent must not quiet this composer (false-hold test
 * below).
 *
 * The announcer pin matters for the same reason it mattered on `/`: a settled
 * receipt inside its undo window re-renders `Undo · Ns` twice a second off
 * `useDecisionClock`, so the live sentence must live on a node of its own with
 * no counter inside it.
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { decisionFixture, resolvedFixture } from './decision-fixture';

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const HOLD_COPY =
  "We're waiting on your approval above — send is paused until you choose.";
const LIVE_SENTENCE = 'Your agent is waiting for your approval.';

function renderConversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return render(
    <AgentConversation
      agent={quill}
      thread={[]}
      decisions={[]}
      readOnly={false}
      onSend={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      approvalRead="ok"
      onRetryApprovals={vi.fn()}
      {...over}
    />,
  );
}

function box() {
  return screen.getByPlaceholderText('Message Quill');
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send' });
}

afterEach(() => {
  vi.useRealTimers();
});

/** This thread points at the fixture's open row (`d-marcus`). */
const threadFor = (decisionId: string) => [
  { kind: 'approval', id: `m-${decisionId}`, decisionId } as const,
];

describe('AgentConversation — composer hold while an approval is open', () => {
  it('disables the field and Send and names the reason when an open decision is present', () => {
    renderConversation({
      thread: [...threadFor('d-marcus')],
      decisions: [decisionFixture()],
    });

    expect(box()).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText(HOLD_COPY)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(LIVE_SENTENCE);
  });

  it("stays live over another thread's open decision — the queue is global, the hold is not", () => {
    // The open row belongs to a thread this pane is not showing: no pointer
    // in `thread`, so no hold, no copy, no announcement. This is the false
    // hold the review caught — `decisions.some(isOpenDecision)` alone quiets
    // every composer's field over one agent's waiting approval.
    renderConversation({
      thread: [],
      decisions: [decisionFixture({ id: 'd-elsewhere' })],
    });

    expect(box()).not.toBeDisabled();
    expect(sendButton()).not.toBeDisabled();
    expect(screen.queryByText(HOLD_COPY)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('stays live with no copy when only settled decisions remain', () => {
    renderConversation({
      decisions: [resolvedFixture('dismissed', { id: 'd-settled' })],
    });

    expect(box()).not.toBeDisabled();
    expect(sendButton()).not.toBeDisabled();
    expect(screen.queryByText(HOLD_COPY)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('treats a stale row as still open — it is a question again, not a receipt', () => {
    renderConversation({
      thread: [...threadFor('d-stale')],
      decisions: [decisionFixture({ id: 'd-stale', status: 'stale' })],
    });

    expect(box()).toBeDisabled();
    expect(screen.getByText(HOLD_COPY)).toBeTruthy();
  });

  it('a streaming reply quiets the field without the hold copy', () => {
    renderConversation({ decisions: [], busy: true });

    expect(box()).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    expect(screen.queryByText(HOLD_COPY)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('sends nothing while held — click or Enter — and keeps the draft', () => {
    const onSend = vi.fn();
    renderConversation({
      thread: [...threadFor('d-marcus')],
      decisions: [decisionFixture()],
      onSend,
    });

    fireEvent.change(box(), { target: { value: 'summarise the roof quote' } });
    fireEvent.click(sendButton());
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('summarise the roof quote');

    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    // Not cleared, not sent: the words are still there for after the choice.
    expect(box()).toHaveValue('summarise the roof quote');
  });

  it('sends normally once the hold clears', () => {
    const onSend = vi.fn();
    const { rerender } = renderConversation({
      thread: [...threadFor('d-marcus')],
      decisions: [decisionFixture()],
      onSend,
    });

    fireEvent.change(box(), { target: { value: 'summarise the roof quote' } });
    rerender(
      <AgentConversation
        agent={quill}
        thread={[...threadFor('d-marcus')]}
        decisions={[resolvedFixture('dismissed', { id: 'd-marcus' })]}
        readOnly={false}
        onSend={onSend}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
        approvalRead="ok"
        onRetryApprovals={vi.fn()}
      />,
    );

    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('summarise the roof quote');
  });

  it('moves no focus when the hold arrives', () => {
    const { rerender } = renderConversation({ decisions: [] });

    box().focus();
    const before = document.activeElement;
    rerender(
      <AgentConversation
        agent={quill}
        thread={[...threadFor('d-marcus')]}
        decisions={[decisionFixture()]}
        readOnly={false}
        onSend={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
        approvalRead="ok"
        onRetryApprovals={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(before);
  });
});

describe('AgentConversation — the hold announcer carries no counter', () => {
  it('stays one stable sentence while a settled receipt ticks its undo countdown', () => {
    vi.useFakeTimers();
    const settled = resolvedFixture('dismissed', { id: 'd-settled' });
    renderConversation({
      // This thread points at BOTH rows: the open one holds the composer
      // (so the announcer speaks) while the settled one ticks its undo
      // countdown on screen (so the announcer must not echo it).
      thread: [
        { kind: 'approval', id: 'm-open', decisionId: 'd-open' },
        { kind: 'approval', id: 'm-settled', decisionId: 'd-settled' },
      ],
      decisions: [decisionFixture({ id: 'd-open' }), settled],
    });

    // The ticking counter really is on screen — otherwise this proves nothing.
    expect(screen.getByText(/Undo · \d+s/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    const announcer = screen.getByRole('status');
    expect(announcer.textContent).toBe(LIVE_SENTENCE);
    expect(announcer.textContent).not.toMatch(/\d/);
  });
});

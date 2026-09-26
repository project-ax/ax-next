/**
 * THE THREAD'S OWN RE-READ MUST NOT DROP A RECEIPT EITHER (TASK-536).
 *
 * TASK-509 fixed half of this. Answering a consent in the agent's thread is
 * followed by TWO reads, not one: the shell's queue refresh
 * (`GET /api/workspace/decisions`) and the thread's own
 * `GET /api/workspace/agents/:id`. #683 taught the queue to keep a
 * just-resolved row — but the card is drawn only where the THREAD carries an
 * approval pointer for it, and the server's `approvalMessages` emits pointers
 * for OPEN decisions only. So the thread's re-read took the pointer away, the
 * card unmounted, and focus fell to `<body>` ~1.2s after the click. Measured on
 * the TASK-358 walk on kind (main 5f6f0730); Today kept its receipt.
 *
 * `workspace-thread-receipt-retention.test.tsx` could not see it: it hands the
 * thread in as a fixed prop, so the re-read that drops the pointer never runs.
 * These tests drive the REAL `AgentView.load` and the REAL `useDecisionQueue`
 * through a mocked transport, so the second re-read is the actual code path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentDetail, ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';
import { JUST_RESOLVED_MS } from '@/lib/workspace-types';

const agentRead = vi.fn();
const listDecisions = vi.fn();
const readDecision = vi.fn();
const approveDecision = vi.fn();
const undoDecision = vi.fn();

vi.mock('../lib/workspace-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspace-api')>()),
  workspaceApi: {
    agent: (...a: unknown[]) => agentRead(...a),
    rail: vi.fn(async () => railFixture()),
    decisions: (...a: unknown[]) => listDecisions(...a),
    decision: (...a: unknown[]) => readDecision(...a),
    approveDecision: (...a: unknown[]) => approveDecision(...a),
    dismissDecision: vi.fn(),
    undoDecision: (...a: unknown[]) => undoDecision(...a),
    revokeGrant: vi.fn(),
    sendMessage: vi.fn(),
    streamReply: vi.fn(),
  },
}));

import { keepAnsweredApprovals, useDecisionQueue } from '../lib/workspace-decisions';
import { AgentView } from '../components/workspace/AgentView';
import {
  decisionFixture,
  resolvedFixture,
} from '../components/workspace/__tests__/decision-fixture';
import { rail as railFixture } from '../components/workspace/__tests__/rail-fixture';

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const quill: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const open = decisionFixture();
const pointer: ThreadMessage = {
  kind: 'approval',
  id: `decision-${open.id}`,
  decisionId: open.id,
};
const asked: ThreadMessage = { kind: 'user', id: 't1', text: 'move my 1:1' };
const replied: ThreadMessage = {
  kind: 'agent',
  id: 't2',
  text: 'Thursday 9:30 works for both of you.',
  at: new Date().toISOString(),
};

function detail(thread: ThreadMessage[], conversationId = 'c1'): AgentDetail {
  return {
    agent: quill,
    conversationId,
    thread,
    decisions: { status: 'ok' },
    past: [],
    memory: {
      rules: { status: 'unavailable', doc: null },
      learned: { status: 'unavailable', docs: [] },
    },
  };
}

/** The shell's wiring: ONE queue, its rows and handlers handed to the view. */
function Harness({ version }: { version: number }) {
  const q = useDecisionQueue();
  return (
    <AgentView
      agentId="scheduler"
      tab="chat"
      onTab={vi.fn()}
      decisions={q.decisions}
      threadGrants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      onApprove={q.approve}
      onDismiss={q.dismiss}
      onUndo={q.undo}
      busyIds={q.busyIds}
      notices={q.notices}
      activity={[]}
      agents={[quill]}
      onBack={vi.fn()}
      decisionsError={q.error}
      version={version}
      onChanged={() => void q.refresh()}
    />
  );
}

/** Mount with an open question in the thread, then answer it from the keyboard. */
async function approveInThread() {
  listDecisions.mockResolvedValue({ decisions: [open] });
  agentRead.mockResolvedValue(detail([asked, pointer]));
  const view = render(<Harness version={0} />);
  await settle();

  approveDecision.mockResolvedValue({
    decision: resolvedFixture('executed'),
    executed: true,
    path: null,
    error: null,
    pendingUntil: null,
    streamReqId: null,
  });
  const yes = screen.getByRole('button', { name: open.primaryLabel });
  yes.focus();
  fireEvent.click(yes);
  await settle();

  const outcome = screen.getByTestId(`approval-outcome-${open.id}`);
  // TASK-427's half, already correct before this card.
  expect(document.activeElement).toBe(outcome);
  return { view, outcome };
}

beforeEach(() => {
  agentRead.mockReset();
  listDecisions.mockReset();
  readDecision.mockReset();
  approveDecision.mockReset();
  undoDecision.mockReset();
  readDecision.mockImplementation(async (id: string) => ({
    decision: resolvedFixture('executed', { id }),
  }));
});

afterEach(() => {
  cleanup();
});

describe("in-thread receipt — survives the thread's own re-read (TASK-536)", () => {
  it('keeps the card, its focus and its Undo when the re-read no longer carries the pointer', async () => {
    const { view, outcome } = await approveInThread();

    // The turn resumes and finishes. Both reads land, and neither lists the
    // row: the queue is open-only, and so are the thread's approval pointers.
    listDecisions.mockResolvedValue({ decisions: [] });
    agentRead.mockResolvedValue(detail([asked, replied]));
    view.rerender(<Harness version={1} />);
    await settle();

    // THE BUG: on `main` the card is gone here and activeElement is <body>.
    expect(screen.getByTestId(`approval-outcome-${open.id}`)).toBe(outcome);
    expect(document.activeElement).toBe(outcome);
    // The continuation arrived too — the re-read was applied, not ignored.
    expect(screen.getByText('Thursday 9:30 works for both of you.')).toBeTruthy();

    // And the advertised Undo is still there and still works.
    undoDecision.mockResolvedValue({ decision: decisionFixture(), undone: true });
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await settle();
    expect(undoDecision).toHaveBeenCalledWith(open.id);
    expect(screen.getByRole('button', { name: open.primaryLabel })).toBeTruthy();
  });

  it('keeps the receipt where it was, above the continuation, rather than moving it', async () => {
    const { view } = await approveInThread();

    listDecisions.mockResolvedValue({ decisions: [] });
    agentRead.mockResolvedValue(detail([asked, replied]));
    view.rerender(<Harness version={1} />);
    await settle();

    const receipt = screen.getByTestId(`approval-outcome-${open.id}`);
    const reply = screen.getByText('Thursday 9:30 works for both of you.');
    // DOCUMENT_POSITION_FOLLOWING: the reply comes after the receipt.
    expect(receipt.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not carry a pointer across into a different conversation', async () => {
    const { view } = await approveInThread();

    listDecisions.mockResolvedValue({ decisions: [] });
    agentRead.mockResolvedValue(detail([replied], 'c-other'));
    view.rerender(<Harness version={1} />);
    await settle();

    expect(screen.queryByTestId(`approval-outcome-${open.id}`)).toBeNull();
  });

  it('retires the receipt once it is older than JUST_RESOLVED_MS — without dropping focus on <body>', async () => {
    const { view, outcome } = await approveInThread();
    listDecisions.mockResolvedValue({ decisions: [] });
    agentRead.mockResolvedValue(detail([asked, replied]));
    view.rerender(<Harness version={1} />);
    await settle();
    expect(document.activeElement).toBe(outcome);

    // A minute on: the same reads, but the receipt's window has closed.
    const later = Date.now() + JUST_RESOLVED_MS + 1_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      view.rerender(<Harness version={2} />);
      await settle();
    } finally {
      spy.mockRestore();
    }

    expect(screen.queryByTestId(`approval-outcome-${open.id}`)).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: `Conversation with ${quill.name}` }),
    );
  });
});

describe('in-thread question — keeps its focus through a re-read after Undo (TASK-543)', () => {
  /*
    MEASURED on the TASK-358 walk (attempt 2): Undo reopened the card and put
    focus on its question, then ~2.6s later focus moved to the "Conversation
    with …" region with the card still pending. The re-read after the Undo lists
    the row as open again, and the server appends open pointers AFTER every
    turn — below the continuation — while the kept receipt had been sitting
    ABOVE it. The transcript keys each message by position, so the card
    remounted, and `ThreadApproval`'s cleanup handed focus to the region.
  */
  it('stays on the reopened question when the next re-read lists the row at the tail again', async () => {
    const { view } = await approveInThread();

    // The approve's re-read: the continuation lands, the pointer is kept above it.
    listDecisions.mockResolvedValue({ decisions: [] });
    agentRead.mockResolvedValue(detail([asked, replied]));
    view.rerender(<Harness version={1} />);
    await settle();

    // Undo from the keyboard: the card asks again and focus lands on the question.
    undoDecision.mockResolvedValue({ decision: decisionFixture(), undone: true });
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await settle();
    const question = screen.getByTestId(`approval-question-${open.id}`);
    expect(document.activeElement).toBe(question);

    // A later re-read: the row is open, so the server carries its pointer — at
    // the END of the thread, after the continuation.
    listDecisions.mockResolvedValue({ decisions: [open] });
    agentRead.mockResolvedValue(detail([asked, replied, pointer]));
    view.rerender(<Harness version={2} />);
    await settle();

    // THE BUG: on `main` the card remounts here and focus is on the region.
    expect(screen.getByTestId(`approval-question-${open.id}`)).toBe(question);
    expect(document.activeElement).toBe(question);
    // And it is still where the reader saw it: above the continuation.
    const reply = screen.getByText('Thursday 9:30 works for both of you.');
    expect(question.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps an open question focused when a re-read brings a turn in above its tail pointer', async () => {
    listDecisions.mockResolvedValue({ decisions: [open] });
    agentRead.mockResolvedValue(detail([asked, pointer]));
    const view = render(<Harness version={0} />);
    await settle();
    const yes = screen.getByRole('button', { name: open.primaryLabel });
    yes.focus();

    agentRead.mockResolvedValue(detail([asked, replied, pointer]));
    view.rerender(<Harness version={1} />);
    await settle();

    expect(screen.getByRole('button', { name: open.primaryLabel })).toBe(yes);
    expect(document.activeElement).toBe(yes);
  });
});

describe('keepAnsweredApprovals — which dropped pointers come back, and where', () => {
  const now = Date.now();
  const other: ThreadMessage = { kind: 'approval', id: 'decision-d-2', decisionId: 'd-2' };

  it('keeps nothing when the queue no longer holds the row', () => {
    expect(keepAnsweredApprovals([asked, pointer], [asked, replied], [], now)).toEqual([
      asked,
      replied,
    ]);
  });

  it('drops a receipt older than JUST_RESOLVED_MS — the same rule the queue applies', () => {
    const old = resolvedFixture('executed', {
      resolvedAt: new Date(now - JUST_RESOLVED_MS - 1).toISOString(),
    });
    expect(keepAnsweredApprovals([asked, pointer], [asked], [old], now)).toEqual([asked]);
  });

  it('keeps an OPEN row the queue still holds — a read that landed after an Undo', () => {
    expect(keepAnsweredApprovals([asked, pointer], [asked], [open], now)).toEqual([
      asked,
      pointer,
    ]);
  });

  it('puts a kept pointer back after its nearest surviving neighbour, ahead of later rows', () => {
    const got = keepAnsweredApprovals(
      [asked, pointer],
      [asked, replied],
      [resolvedFixture('executed')],
      now,
    );
    expect(got).toEqual([asked, pointer, replied]);
  });

  it('holds a pointer the fresh read still carries where it was, not at the server tail (TASK-543)', () => {
    // Every pointer the previous read had keeps its slot, so neither card
    // changes position — a moved card remounts, and a remount drops focus.
    const got = keepAnsweredApprovals(
      [asked, pointer, other],
      [asked, replied, other],
      [resolvedFixture('executed'), decisionFixture({ id: 'd-2' })],
      now,
    );
    expect(got).toEqual([asked, pointer, other, replied]);
  });

  it('holds a reopened pointer above the continuation after an Undo (TASK-543)', () => {
    expect(
      keepAnsweredApprovals([asked, pointer, replied], [asked, replied, pointer], [open], now),
    ).toEqual([asked, pointer, replied]);
  });

  it('leaves a pointer that is new to this read where the server put it', () => {
    expect(
      keepAnsweredApprovals([asked, replied], [asked, replied, pointer], [open], now),
    ).toEqual([asked, replied, pointer]);
  });

  it('still drops a pointer the fresh read does not carry once the queue has let go of it', () => {
    expect(
      keepAnsweredApprovals([asked, pointer, other], [asked, replied, other], [decisionFixture({ id: 'd-2' })], now),
    ).toEqual([asked, other, replied]);
  });

  it('never keeps a message that is not an approval pointer', () => {
    expect(keepAnsweredApprovals([asked, replied], [asked], [open], now)).toEqual([asked]);
  });
});

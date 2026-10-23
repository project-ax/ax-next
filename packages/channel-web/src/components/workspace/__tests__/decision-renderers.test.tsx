/**
 * ONE ROW, THREE RENDERERS — the invariant, pinned.
 *
 * `DecisionRow` (the Today queue) and `ApprovalCard` (the in-thread card) draw
 * the same `Decision`. Slack will be the third. They are allowed to differ in
 * LAYOUT — one is a scannable line that expands, the other is a card inside a
 * conversation. They are not allowed to differ in what they SAY about an
 * outcome, because then a person who approves something in the thread and then
 * opens Today reads two different accounts of one event, and learns to trust
 * neither.
 *
 * So these tests render both from the same fixture and compare the strings.
 * `decision-copy.ts` is what makes them agree; this is what proves they still do.
 *
 * The row that matters most is `approved-pending-agent`. It is a REAL approval
 * for an action that HAS NOT HAPPENED — the host cannot make the call itself and
 * the agent will do it on its next run. Both renderers say exactly that, and
 * neither of them says "Sent".
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalCard } from '../ApprovalCard';
import { DecisionRow } from '../DecisionRow';
import {
  DECISION_EXPIRED,
  DECISION_FAILED,
  DECISION_GOING_OUT,
  DECISION_PENDING_AGENT,
  DECISION_STALE_LEAD,
} from '../decision-copy';
import { decisionFixture, resolvedFixture } from './decision-fixture';
import {
  DECISION_REQUEST_HEADING,
  DECISION_REQUEST_NO_INPUT,
  DECISION_REQUEST_TRUNCATED,
} from '../DecisionRequestBlock';
import {
  DECISION_TASK_CHECKS_IN_LABEL,
  DECISION_TASK_GOOD_WHEN_LABEL,
  DECISION_TASK_HEADING_CHANGE,
  DECISION_TASK_HEADING_START,
  DECISION_TASK_NAME_LABEL,
  DECISION_TASK_LINE_COLUMNS,
  DECISION_TASK_SCROLL_NOTE,
  DECISION_TASK_TRUNCATED,
  DECISION_TASK_VISIBLE_LINES,
  decisionTaskInstructionsLabel,
} from '../DecisionTaskBlock';
import { toWireDecision } from '@/server/routes-workspace';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';

const agent: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Scheduler',
  state: 'waiting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/** What the queue row says about this decision. */
function queueText(d: Decision): string {
  const { container, unmount } = render(
    <DecisionRow
      decision={d}
      agent={agent}
      expanded
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
    />,
  );
  const text = container.textContent ?? '';
  unmount();
  return text;
}

/** What the in-thread card says about the same one. */
function cardText(d: Decision): string {
  const { container, unmount } = render(
    <ApprovalCard
      decision={d}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
    />,
  );
  const text = container.textContent ?? '';
  unmount();
  return text;
}

describe('one row, three renderers — the outcome line', () => {
  const cases: Array<{ name: string; decision: Decision; line: string }> = [
    {
      name: 'executed',
      decision: resolvedFixture('executed'),
      line: decisionFixture().approvedText,
    },
    {
      name: 'approved-pending-agent',
      decision: resolvedFixture('approved-pending-agent'),
      line: DECISION_PENDING_AGENT,
    },
    {
      name: 'dismissed',
      decision: resolvedFixture('dismissed'),
      line: decisionFixture().dismissedText,
    },
    {
      name: 'failed',
      decision: resolvedFixture('failed', { undoable: false }),
      line: DECISION_FAILED,
    },
    {
      name: 'expired',
      decision: resolvedFixture('expired', { undoable: false }),
      line: DECISION_EXPIRED,
    },
  ];

  for (const c of cases) {
    it(`says the same thing in both places — ${c.name}`, () => {
      const inQueue = queueText(c.decision);
      const inThread = cardText(c.decision);
      expect(inQueue).toContain(c.line);
      expect(inThread).toContain(c.line);
    });
  }

  it('never claims an unattended-parked approval was sent', () => {
    // The one sentence this whole surface exists to get right. The host CANNOT
    // make this call; the approval stands and the agent performs it later.
    const parked = resolvedFixture('approved-pending-agent');
    for (const text of [queueText(parked), cardText(parked)]) {
      expect(text).toContain(DECISION_PENDING_AGENT);
      expect(text).not.toMatch(/\bSent\b/i);
      expect(text).not.toContain(parked.approvedText);
    }
  });

  it('does not say an irreversible action has happened while it is still deferred', () => {
    const deferred = resolvedFixture('executed', {
      irreversible: true,
      pendingUntil: new Date(Date.now() + 9_000).toISOString(),
    });
    for (const text of [queueText(deferred), cardText(deferred)]) {
      expect(text).toContain(DECISION_GOING_OUT);
      // `approvedText` is the "it went out" sentence. Not yet, it hasn't.
      expect(text).not.toContain(deferred.approvedText);
      expect(text).toMatch(/Undo/);
    }
  });

  it('shows the same three authored labels on an open row', () => {
    const open = decisionFixture();
    // The card drops `secondaryLabel` — there is nowhere for "open the agent"
    // to go from inside the agent's own thread — so the two agree on the two
    // labels that resolve the decision, which are the ones that matter.
    for (const text of [queueText(open), cardText(open)]) {
      expect(text).toContain(open.primaryLabel);
      expect(text).toContain(open.ghostLabel);
      expect(text).toContain(open.summary);
    }
    // And the drop is ASSERTED, not just described. A leftover secondary button
    // on the card has nowhere to go, so it gets wired to dismiss instead — a
    // control reading "Pick another time" that turns the request down. This
    // comment claimed the button was gone while it was still there; the line
    // below is what keeps the claim honest.
    expect(cardText(open)).not.toContain(open.secondaryLabel);
    expect(queueText(open)).toContain(open.secondaryLabel);
  });

  it('re-words the primary action on a stale row in both places', () => {
    const stale = decisionFixture({
      status: 'stale',
      staleReason: 'Thursday 9:30 was booked by someone else at 11:04.',
    });
    for (const text of [queueText(stale), cardText(stale)]) {
      expect(text).toContain('Move it anyway');
      expect(text).toContain(DECISION_STALE_LEAD);
      expect(text).toContain('booked by someone else at 11:04');
    }
  });
});

/*
  The queue is read once and then updated by the responses to a person's own
  clicks — there is no poll. So anything a row says that stops being true on a
  CLOCK has to change itself, or the screen quietly keeps making a claim nobody
  is checking any more (design H7).

  Two of those, and they close together: the undo window, and whether a deferred
  irreversible action has actually gone ahead.
*/
describe('a row that changes on its own', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops saying an action is about to happen once it has happened', () => {
    vi.useFakeTimers();
    /*
      `pendingUntil` is deliberately LATER than the undo window closes. The two
      normally land together — the deferral IS the window — but the row reads
      the server's instant against the browser's clock, and those two machines
      do not agree to the second. With even a little skew the countdown finishes
      first, and a row that only re-rendered while the countdown was running
      would freeze on "it is about to go ahead" and stay there for as long as
      the tab was open.
    */
    const deferred = resolvedFixture('executed', {
      irreversible: true,
      resolvedAt: new Date().toISOString(),
      pendingUntil: new Date(Date.now() + 20_000).toISOString(),
    });
    const { container } = render(
      <DecisionRow
        decision={deferred}
        agent={agent}
        expanded={false}
        onToggle={vi.fn()}
        onOpenAgent={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(DECISION_GOING_OUT);

    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    // The undo window has closed; the action still has not happened, and the
    // row still says so rather than reporting an outcome nobody has observed.
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(container.textContent).toContain(DECISION_GOING_OUT);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // It went ahead. The row says the authored approved line now.
    expect(container.textContent).not.toContain(DECISION_GOING_OUT);
    expect(container.textContent).toContain(deferred.approvedText);
  });
});

describe('the undo affordance', () => {
  it('is offered while the server says the row can still be taken back', () => {
    render(
      <ApprovalCard
        decision={resolvedFixture('executed')}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('is NOT offered once the call has actually been made', () => {
    // `undoable: false` is the server's answer, and it is the gate that matters:
    // the ten-second clock has not run out here, but the email has already gone.
    // Offering "Undo" would promise something we cannot do.
    render(
      <ApprovalCard
        decision={resolvedFixture('executed', { undoable: false })}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('is NOT offered on either surface while the host replay flight is claimed', () => {
    // The flight: the host stamped `replayClaimedAt` and is performing the call
    // right now — `replayedAt` is still null, but the call is already going out
    // and the undo POST would refuse it. One stored fixture, projected through
    // the real `toWireDecision`, drawn by BOTH renderers: neither may offer a
    // control that cannot do what it names.
    const now = new Date().toISOString();
    const flight: Parameters<typeof toWireDecision>[0] = {
      id: 'd-flight',
      agentId: 'scheduler',
      ownerUserId: 'u1',
      conversationId: 'c1',
      kind: 'action',
      attendance: 'unattended',
      status: 'executed',
      call: { id: 'tu1', name: 'gmail_send', input: {} },
      callFingerprint: 'sha256:abcdef',
      ruleId: null,
      irreversible: true,
      freshness: null,
      summary: 'Send the reply to Priya',
      detail: 'It drafted a reply about the Thursday slot.',
      preview: null,
      primaryLabel: 'Send it',
      secondaryLabel: 'Pick another time',
      ghostLabel: "Don't send",
      approvedText: 'You approved this — the reply went out.',
      dismissedText: 'You turned this down. Nothing was sent.',
      createdAt: now,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      resolvedAt: now,
      staleReason: null,
      consumedAt: null,
      replayDueAt: null,
      replayClaimedAt: now,
      replayedAt: null,
      replayError: null,
    };
    const projected = toWireDecision(flight);
    expect(projected.undoable).toBe(false);

    const { unmount: unmountCard } = render(
      <ApprovalCard
        decision={projected}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    unmountCard();

    render(
      <DecisionRow
        decision={projected}
        agent={agent}
        expanded
        onToggle={vi.fn()}
        onOpenAgent={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});

describe('TASK-699 — both renderers show which tool and what it will send', () => {
  const HOSTILE = '{\n  "title": "<img src=x onerror=alert(1)>"\n}';
  const held = decisionFixture({
    summary: 'Wants to use mcp.github.create_issue',
    request: { tool: 'mcp.github.create_issue', input: HOSTILE, truncated: false },
  });

  it('the queue row and the in-thread card both name the tool and quote the input', () => {
    for (const text of [queueText(held), cardText(held)]) {
      expect(text).toContain(DECISION_REQUEST_HEADING);
      expect(text).toContain('mcp.github.create_issue');
      expect(text).toContain('<img src=x onerror=alert(1)>');
    }
  });

  it('draws the input as TEXT — markup in it never becomes an element', () => {
    for (const ui of [
      <DecisionRow
        key="q"
        decision={held}
        agent={agent}
        expanded
        onToggle={vi.fn()}
        onOpenAgent={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
      <ApprovalCard key="c" decision={held} onApprove={vi.fn()} onDismiss={vi.fn()} onUndo={vi.fn()} />,
    ]) {
      const { container, unmount } = render(ui);
      expect(container.querySelector('img')).toBeNull();
      const pre = screen.getByTestId('decision-request-input');
      expect(pre.tagName).toBe('PRE');
      expect(pre.textContent).toBe(HOSTILE);
      unmount();
    }
  });

  it('"Edit first" is never offered off the agent-authored request — only off a host preview', () => {
    render(
      <ApprovalCard
        decision={held}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
        onEdit={vi.fn(async () => {})}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit first' })).toBeNull();
  });

  it('says when the input was cut, and when there was none', () => {
    const cut = decisionFixture({
      request: { tool: 'mcp.github.create_issue', input: '{', truncated: true },
    });
    const none = decisionFixture({
      request: { tool: 'mcp.github.list_issues', input: null, truncated: false },
    });
    expect(cardText(cut)).toContain(DECISION_REQUEST_TRUNCATED);
    expect(queueText(cut)).toContain(DECISION_REQUEST_TRUNCATED);
    expect(cardText(none)).toContain(DECISION_REQUEST_NO_INPUT);
    expect(queueText(none)).toContain(DECISION_REQUEST_NO_INPUT);
  });

  it('a row with no request draws no block', () => {
    const plain = decisionFixture();
    expect(cardText(plain)).not.toContain(DECISION_REQUEST_HEADING);
    expect(queueText(plain)).not.toContain(DECISION_REQUEST_HEADING);
  });
});

describe('TASK-906 — both renderers show a proposed task as text', () => {
  // Model-authored, so it carries markup, markdown and a line break: all three
  // must reach the screen as the characters they are.
  const HOSTILE = 'Keep the queue empty.\n<img src=x onerror=alert(1)>\n**Leave** enterprise customers to me.';
  const GOOD_WHEN = 'No ticket open **longer** than an hour.';
  const task: NonNullable<Decision['task']> = {
    action: 'start',
    name: 'Zero open tickets',
    instructions: { text: HOSTILE, truncated: false },
    goodWhen: { text: GOOD_WHEN, truncated: false },
    checksIn: 'Runs every hour',
  };
  const held = decisionFixture({
    summary: 'Wants to start a task',
    routineOperation: 'routine_create',
    task,
  });

  /** Both renderers of one row, to render one at a time and look inside. */
  const both = (d: Decision) => [
    <DecisionRow
      key="q"
      decision={d}
      agent={agent}
      expanded
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
    />,
    <ApprovalCard key="c" decision={d} onApprove={vi.fn()} onDismiss={vi.fn()} onUndo={vi.fn()} />,
  ];

  it('uses the decided words', () => {
    expect([
      DECISION_TASK_HEADING_START,
      DECISION_TASK_HEADING_CHANGE,
      DECISION_TASK_NAME_LABEL,
      decisionTaskInstructionsLabel('Scheduler'),
      DECISION_TASK_GOOD_WHEN_LABEL,
      DECISION_TASK_CHECKS_IN_LABEL,
      DECISION_TASK_TRUNCATED,
      DECISION_TASK_SCROLL_NOTE,
    ]).toEqual([
      'The task',
      'What changes',
      'Name',
      'What Scheduler will do',
      'Going well when',
      'Checks in',
      'This is only the beginning. The full text is longer.',
      'Scroll to read all of it.',
    ]);
  });

  it('the queue row and the in-thread card both show the name, instructions, going-well-when and schedule', () => {
    for (const text of [queueText(held), cardText(held)]) {
      expect(text).toContain('The task');
      for (const label of ['Name', 'Going well when', 'Checks in']) expect(text).toContain(label);
      for (const value of ['Zero open tickets', HOSTILE, GOOD_WHEN, 'Runs every hour']) {
        expect(text).toContain(value);
      }
    }
  });

  it("labels the instructions with each renderer's agent name", () => {
    expect(queueText(held)).toContain('What Scheduler will do');
    // ApprovalCard's default `agentName`; `cardText` passes none.
    expect(cardText(held)).toContain('What This agent will do');
  });

  it('draws every value as TEXT — markup and markdown never become elements', () => {
    for (const ui of both(held)) {
      const { container, unmount } = render(ui);
      expect(container.querySelector('[data-testid="decision-task"]')).not.toBeNull();
      expect(
        container.querySelector('[data-testid="decision-task"] img, [data-testid="decision-task"] strong'),
      ).toBeNull();
      // Nothing in the block turns model text into an attribute either.
      expect(
        container.querySelector('[data-testid="decision-task"] [title], [data-testid="decision-task"] [href]'),
      ).toBeNull();
      expect(screen.getByTestId('decision-task-instructions').textContent).toBe(HOSTILE);
      expect(screen.getByTestId('decision-task-good-when').textContent).toBe(GOOD_WHEN);
      unmount();
    }
  });

  it('sits above the request block, which still shows the whole call', () => {
    const withRequest = decisionFixture({
      ...held,
      request: { tool: 'routine_create', input: '{\n  "requestId": "r"\n}', truncated: false },
    });
    for (const ui of both(withRequest)) {
      const { unmount } = render(ui);
      const block = screen.getByTestId('decision-task');
      const request = screen.getByTestId('decision-request');
      expect(block.compareDocumentPosition(request) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }
  });

  // The box shows twelve lines and then scrolls, and on systems that hide
  // scrollbars nothing else says there is more. A field the box can't show
  // whole says so under it, in both renderers. Two signals, either enough: the
  // browser's own layout (the box's content taller than the box), and an
  // estimate from the text that errs toward "scroll" for the narrowest box we
  // lay out (a 360px phone). jsdom has no layout, so these tests pin the
  // estimate, and mock the layout to pin the other half.
  describe('says when a field is taller than its box', () => {
    const lines = (n: number, separator = '\n') => Array.from({ length: n }, (_, i) => `Step ${i + 1}.`).join(separator);
    const withFields = (instructions: string, goodWhen: string) =>
      decisionFixture({
        ...held,
        task: {
          ...task,
          instructions: { text: instructions, truncated: false },
          goodWhen: { text: goodWhen, truncated: false },
        },
      });
    const noteCount = (text: string) => text.split(DECISION_TASK_SCROLL_NOTE).length - 1;
    /** CJK ideographs, which take two columns each. Built from code points so the source holds none. */
    const ideographs = (n: number) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + (i % 200))).join('');

    it('pins the box: twelve lines of 28 columns', () => {
      expect([DECISION_TASK_VISIBLE_LINES, DECISION_TASK_LINE_COLUMNS]).toEqual([12, 28]);
    });

    it('under each tall field, as muted text, for line breaks and for one long line', () => {
      // 13 short lines, and one 2,000-character line with no line break at all.
      const tall = withFields(lines(13), 'x'.repeat(2000));
      for (const ui of both(tall)) {
        const { unmount } = render(ui);
        const notes = screen.getAllByText(DECISION_TASK_SCROLL_NOTE);
        expect(notes).toHaveLength(2);
        // Each note follows its own field.
        expect(screen.getByTestId('decision-task-instructions').nextElementSibling).toBe(notes[0]);
        expect(screen.getByTestId('decision-task-good-when').nextElementSibling).toBe(notes[1]);
        for (const note of notes) expect(note).toHaveClass('text-muted-foreground');
        unmount();
      }
    });

    it('counts wrapped lines: a line of 29 columns takes two', () => {
      const wrapped = withFields(Array(7).fill('y'.repeat(29)).join('\n'), Array(6).fill('y'.repeat(29)).join('\n'));
      for (const text of [queueText(wrapped), cardText(wrapped)]) expect(noteCount(text)).toBe(1);
    });

    it('counts a wide character as two columns: CJK fills the box at half the characters', () => {
      // 200 ideographs are 400 columns, fifteen lines; 200 narrow characters are eight.
      const cjk = withFields(ideographs(200), 'z'.repeat(200));
      for (const text of [queueText(cjk), cardText(cjk)]) expect(noteCount(text)).toBe(1);
      // The review's case: one line of 700 ideographs.
      const long = withFields(ideographs(700), 'Inbox at zero.');
      for (const text of [queueText(long), cardText(long)]) expect(noteCount(text)).toBe(1);
      // An emoji is wide too.
      const emoji = withFields(Array.from({ length: 170 }, () => String.fromCodePoint(0x1f600)).join(''), 'Inbox at zero.');
      for (const text of [queueText(emoji), cardText(emoji)]) expect(noteCount(text)).toBe(1);
    });

    it('treats CR and CRLF as line breaks too', () => {
      const cr = withFields(lines(13, '\r'), lines(13, '\r\n'));
      for (const text of [queueText(cr), cardText(cr)]) expect(noteCount(text)).toBe(2);
    });

    it('not for a field that fits: twelve lines, or one line of 336 columns', () => {
      const fits = withFields(lines(12), 'z'.repeat(12 * 28));
      for (const text of [queueText(fits), cardText(fits)]) expect(noteCount(text)).toBe(0);
      const justOver = withFields(lines(12), 'z'.repeat(12 * 28 + 1));
      for (const text of [queueText(justOver), cardText(justOver)]) expect(noteCount(text)).toBe(1);
      for (const text of [queueText(held), cardText(held)]) expect(noteCount(text)).toBe(0);
    });

    describe('where the browser lays the box out', () => {
      const layout = { scroll: 0, client: 0 };
      let resized: (() => void)[] = [];
      beforeEach(() => {
        layout.scroll = 0;
        layout.client = 0;
        resized = [];
        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() => layout.scroll);
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(() => layout.client);
        // A callback counts only while its observer watches something.
        vi.stubGlobal(
          'ResizeObserver',
          class {
            constructor(private readonly callback: () => void) {}
            observe() {
              resized.push(this.callback);
            }
            unobserve() {}
            disconnect() {
              resized = resized.filter((callback) => callback !== this.callback);
            }
          },
        );
      });
      afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      });
      const short = withFields('Keep the queue empty.', 'Inbox at zero.');

      it('a short text whose box overflows says so: the layout is enough', () => {
        layout.scroll = 300;
        layout.client = 256;
        for (const text of [queueText(short), cardText(short)]) expect(noteCount(text)).toBe(2);
      });

      it('a short text whose box doesn’t overflow says nothing, and a pixel of rounding isn’t overflow', () => {
        layout.scroll = 42;
        layout.client = 42;
        for (const text of [queueText(short), cardText(short)]) expect(noteCount(text)).toBe(0);
        layout.scroll = 43;
        for (const text of [queueText(short), cardText(short)]) expect(noteCount(text)).toBe(0);
      });

      it('checks again when the box resizes, as a narrower window wraps the text', () => {
        layout.scroll = 42;
        layout.client = 42;
        const { container, unmount } = render(both(short)[1]!);
        expect(noteCount(container.textContent ?? '')).toBe(0);
        expect(resized.length).toBeGreaterThan(0);
        layout.scroll = 300;
        layout.client = 256;
        act(() => {
          for (const callback of resized) callback();
        });
        expect(noteCount(container.textContent ?? '')).toBe(2);
        // Unmounted, the box is watched no more.
        unmount();
        expect(resized).toEqual([]);
      });

      it('without ResizeObserver it still measures once, and the estimate still decides', () => {
        vi.stubGlobal('ResizeObserver', undefined);
        layout.scroll = 300;
        layout.client = 256;
        for (const text of [queueText(short), cardText(short)]) expect(noteCount(text)).toBe(2);
        layout.scroll = 0;
        layout.client = 0;
        const tall = withFields(lines(13), 'Inbox at zero.');
        for (const text of [queueText(tall), cardText(tall)]) expect(noteCount(text)).toBe(1);
      });
    });
  });

  it('says when a field was cut, in both renderers', () => {
    const cut = decisionFixture({ ...held, task: { ...task, instructions: { text: 'Keep the queue', truncated: true } } });
    expect(queueText(cut)).toContain(DECISION_TASK_TRUNCATED);
    expect(cardText(cut)).toContain(DECISION_TASK_TRUNCATED);
    expect(queueText(held)).not.toContain(DECISION_TASK_TRUNCATED);
    expect(cardText(held)).not.toContain(DECISION_TASK_TRUNCATED);
  });

  it('a change shows only what it changes', () => {
    const change = decisionFixture({
      summary: 'Wants to change a task',
      routineOperation: 'routine_update',
      task: {
        action: 'change',
        name: null,
        instructions: null,
        goodWhen: { text: 'Inbox at zero.', truncated: false },
        checksIn: null,
      },
    });
    for (const ui of both(change)) {
      const { unmount } = render(ui);
      const block = screen.getByTestId('decision-task');
      expect(block.textContent).toContain(DECISION_TASK_HEADING_CHANGE);
      expect(block.textContent).not.toContain(DECISION_TASK_HEADING_START);
      expect([...block.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([DECISION_TASK_GOOD_WHEN_LABEL]);
      expect(screen.getByTestId('decision-task-good-when').textContent).toBe('Inbox at zero.');
      expect(screen.queryByTestId('decision-task-instructions')).toBeNull();
      unmount();
    }
  });

  it('a row with no task draws no block', () => {
    const plain = decisionFixture();
    for (const ui of both(plain)) {
      const { container, unmount } = render(ui);
      expect(container.querySelector('[data-testid="decision-task"]')).toBeNull();
      unmount();
    }
    expect(queueText(plain)).not.toContain(DECISION_TASK_GOOD_WHEN_LABEL);
    expect(cardText(plain)).not.toContain(DECISION_TASK_GOOD_WHEN_LABEL);
  });
});

describe('TASK-932 — both renderers name the task a check-in raised it in', () => {
  const CHECK_IN = { routineId: 't1', taskName: 'Zero open support tickets' };
  const CHECKED = ' · checked against: Thursday 9:30 still free for both of you';

  it('the queue row and the in-thread card say the same line', () => {
    const d = decisionFixture({ checkIn: CHECK_IN });
    for (const text of [queueText(d), cardText(d)]) {
      expect(text).toContain(`Held during a check-in on “Zero open support tickets”${CHECKED}`);
      expect(text).not.toContain('unattended run');
    }
  });

  it('draws the task name as text', () => {
    const name = '<img src=x onerror=alert(1)> **Zero** _open_';
    const d = decisionFixture({ freshness: null, checkIn: { routineId: 't1', taskName: name } });
    const line = `Held during a check-in on “${name}”`;
    const ui = [
      <DecisionRow
        key="row"
        decision={d}
        agent={agent}
        expanded
        onToggle={vi.fn()}
        onOpenAgent={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
      <ApprovalCard key="card" decision={d} onApprove={vi.fn()} onDismiss={vi.fn()} onUndo={vi.fn()} />,
    ];
    for (const el of ui) {
      const { container, unmount } = render(el);
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(container.querySelector('img, strong, em')).toBeNull();
      unmount();
    }
  });
});

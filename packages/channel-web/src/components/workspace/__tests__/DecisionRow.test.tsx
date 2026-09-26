import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DecisionRow } from '../DecisionRow';
import {
  DECISION_EXPIRED,
  DECISION_FAILED,
  DECISION_PENDING_AGENT,
  DECISION_STALE_LEAD,
} from '../decision-copy';
import { decisionFixture, resolvedFixture } from './decision-fixture';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';

const agent: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Scheduler',
  state: 'waiting',
  now: 'Waiting on your decision',
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function renderRow(
  d: Decision,
  expanded = true,
  over: Partial<React.ComponentProps<typeof DecisionRow>> = {},
) {
  return render(
    <DecisionRow
      decision={d}
      agent={agent}
      expanded={expanded}
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      {...over}
    />,
  );
}

describe('DecisionRow — pending', () => {
  it('shows what the decision was checked against', () => {
    renderRow(decisionFixture());
    expect(
      screen.getByText(/checked against: Thursday 9:30 still free/),
    ).toBeTruthy();
  });

  it('says nothing rather than "null" when the tool supplied no label', () => {
    // A producer may capture a predicate it has no legible sentence for. The
    // guard still works; there is simply no clause to print.
    renderRow(decisionFixture({ freshness: { kind: 'slot-etag', value: 'etag-free', label: null } }));
    expect(screen.queryByText(/checked against:/)).toBeNull();
  });

  it('offers the three ways out and says nothing happens yet', () => {
    renderRow(decisionFixture());
    expect(screen.getByRole('button', { name: 'Move it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick another time' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave it' })).toBeTruthy();
    expect(screen.getByText('Nothing happens until you choose')).toBeTruthy();
  });

  it('every control actually calls something — no button swallows a click', () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const onOpenAgent = vi.fn();
    renderRow(decisionFixture(), true, { onApprove, onDismiss, onOpenAgent });

    screen.getByRole('button', { name: 'Move it' }).click();
    screen.getByRole('button', { name: 'Leave it' }).click();
    screen.getByRole('button', { name: 'Pick another time' }).click();

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpenAgent).toHaveBeenCalledTimes(1);
  });
});

describe('DecisionRow — the cost of doing nothing', () => {
  it('says when a decision is about to lapse, and what that means', () => {
    renderRow(
      decisionFixture({
        expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
      }),
    );
    // An expired decision cannot be approved at all, only raised again. A row
    // that just sits there gives a first-timer no way to know that.
    expect(screen.getByText(/expires in about 3 hours/)).toBeTruthy();
  });

  it('says nothing about a deadline that is days away', () => {
    const { container } = renderRow(
      decisionFixture({
        expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      }),
    );
    expect(container.textContent).not.toMatch(/expires/);
  });

  it('never counts backwards past an expiry it somehow outlived', () => {
    const { container } = renderRow(
      decisionFixture({
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      }),
    );
    expect(container.textContent).not.toMatch(/expires/);
  });
});

describe('DecisionRow — a click in flight', () => {
  it('disables the controls and says what it is doing, rather than hiding them', () => {
    // A control that VANISHES under the cursor reads as a crash. A disabled one
    // reads as "received, working on it" — which is the truth.
    renderRow(decisionFixture(), true, { busy: true });
    expect(
      (screen.getByRole('button', { name: 'Move it' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText('Working on it…')).toBeTruthy();
    expect(screen.queryByText('Nothing happens until you choose')).toBeNull();
  });

  it('shows the notice from an action that failed or was refused', () => {
    renderRow(decisionFixture(), true, {
      notice: 'We could not reach the server, so nothing changed.',
    });
    expect(screen.getByText(/could not reach the server/)).toBeTruthy();
  });
});

describe('DecisionRow — stale', () => {
  const stale = decisionFixture({
    status: 'stale',
    staleReason: 'Thursday 9:30 was booked by someone else at 11:04.',
  });

  it('leads with the fact that nothing was sent', () => {
    renderRow(stale);
    expect(screen.getByText(DECISION_STALE_LEAD)).toBeTruthy();
    expect(screen.getByText(/booked by someone else at 11:04/)).toBeTruthy();
  });

  it('drops the freshness claim once the guard has disproved it', () => {
    // The label describes hold-time. Repeating "still free for both of you"
    // directly under an alert saying the slot was taken is worse than silence.
    renderRow(stale);
    expect(screen.queryByText(/checked against:/)).toBeNull();
  });

  it('drops it on the shape the host actually writes, too (AW-7)', () => {
    // The row above still carries a label, and that is deliberate: it proves
    // the RENDERER refuses to print the clause on a stale row whatever the
    // wire says. This one is the wire's own shape — `@ax/decisions` strips
    // `label` as it moves the row to `stale`, so `label: null` is what a real
    // stale decision arrives with. Both have to be handled: a page loaded
    // fresh gets the null, and an optimistic client-side transition may not.
    renderRow(
      decisionFixture({
        status: 'stale',
        staleReason: 'Thursday 9:30 was booked by someone else at 11:04.',
        freshness: { kind: 'slot-etag', value: 'etag-taken', label: null },
      }),
    );
    expect(screen.queryByText(/checked against:/)).toBeNull();
    expect(screen.queryByText(/null/)).toBeNull();
  });

  it('re-words the primary action, because approving now means something else', () => {
    renderRow(stale);
    expect(screen.getByRole('button', { name: 'Move it anyway' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move it' })).toBeNull();
  });
});

describe('DecisionRow — resolved', () => {
  it('reports the authored approved line and offers undo inside the window', () => {
    renderRow(resolvedFixture('executed'), false);
    expect(
      screen.getByText('Scheduler moved your 1:1 with Marcus to Thursday 9:30'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('reports the authored dismissed line — never a derived one', () => {
    renderRow(resolvedFixture('dismissed'), false);
    expect(screen.getByText('You left the Marcus 1:1 where it was')).toBeTruthy();
  });

  it('drops undo once the window has closed', () => {
    renderRow(
      resolvedFixture('executed', {
        resolvedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      false,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('drops undo the moment the call has actually gone out, clock or no clock', () => {
    // The dangerous case: still inside the ten seconds, but the host already
    // made the call. `undoable: false` is the server saying so, and a button
    // offering to unsend a sent email is the worst control on this surface.
    renderRow(
      resolvedFixture('executed', { undoable: false }),
      false,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});

describe('DecisionRow — the outcomes the host cannot claim', () => {
  it('says an approved-but-unperformed action will happen NEXT RUN, never "Sent"', () => {
    const { container } = renderRow(
      resolvedFixture('approved-pending-agent'),
      false,
    );
    expect(screen.getByText(DECISION_PENDING_AGENT)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bSent\b/i);
    // And not the approved line either — that one is for a call that ran.
    expect(container.textContent).not.toContain(decisionFixture().approvedText);
  });

  it('says a failed replay completed nothing', () => {
    renderRow(resolvedFixture('failed', { undoable: false }), false);
    expect(screen.getByText(DECISION_FAILED)).toBeTruthy();
    expect(screen.getByText(/Nothing was completed/)).toBeTruthy();
  });

  it('says an expired decision simply ran out of time', () => {
    renderRow(resolvedFixture('expired', { undoable: false }), false);
    expect(screen.getByText(DECISION_EXPIRED)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});

/*
  TASK-436 — the collapsed summary is one clamped line, and it is the only
  thing the reader has to go on before opening the row. jsdom has no CSS, so
  this asserts the recoverable half: the whole summary is in `title`.
*/
describe('DecisionRow — a clamped summary (TASK-436)', () => {
  it('keeps the whole summary reachable in `title`', () => {
    const summary =
      'Move the quarterly review with the EMEA regional leads from Thursday 09:30 to Friday 14:00 and re-invite everyone';
    renderRow(decisionFixture({ summary }), false);
    expect(screen.getByText(summary).getAttribute('title')).toBe(summary);
  });
});

/*
  TASK-544 — the dot's shape varies with state (bits.tsx `STATE_SHAPE`: 6px
  diamond, 7px circle/square, 8px dash), so a bare dot shifted the text after
  it by a pixel or two from row to row. Every dot sits in the same fixed `w-2`
  slot the sidebar roster uses, so text starts at one x-offset whatever the
  state. jsdom has no layout, so this pins the STRUCTURE that guarantees it:
  one slot class for every state this row can draw.
*/
describe('DecisionRow — the dot sits in a fixed-width slot', () => {
  const cases: Array<[string, Decision]> = [
    ['held question', decisionFixture()],
    [
      'stale question',
      decisionFixture({ status: 'stale', staleReason: 'Thursday 9:30 was booked.' }),
    ],
    ['executed receipt', resolvedFixture('executed')],
    ['dismissed receipt', resolvedFixture('dismissed')],
    ['failed receipt', resolvedFixture('failed', { undoable: false })],
    ['expired receipt', resolvedFixture('expired', { undoable: false })],
    ['pending-agent receipt', resolvedFixture('approved-pending-agent')],
  ];

  function slotOf(d: Decision): string {
    const { container, unmount } = renderRow(d, false);
    const row = container.querySelector(`[data-testid="decision-${d.id}"]`)!;
    // The dot is the row's only aria-hidden SPAN (lucide icons are SVGs).
    const dots = row.querySelectorAll('span[aria-hidden="true"]');
    expect(dots).toHaveLength(1);
    const cls = dots[0]!.parentElement!.className;
    unmount();
    return cls;
  }

  it.each(cases)('%s: the dot is centred in a w-2 slot', (_label, d) => {
    expect(slotOf(d).split(/\s+/)).toEqual(
      expect.arrayContaining(['w-2', 'shrink-0', 'justify-center']),
    );
  });

  it('every state uses the SAME slot, so the text starts at one offset', () => {
    const slots = new Set(cases.map(([, d]) => slotOf(d)));
    expect(slots.size).toBe(1);
  });
});

/*
  TASK-544 — on a held (non-stale) question the dot is the only thing that
  says the state: the text beside it is the question itself. The dot is
  `aria-hidden`, so the row says the state word too, after the agent's name,
  the way the sidebar roster does ("Scheduler, waiting on you").
*/
describe('DecisionRow — the held question says its state', () => {
  it("puts the state word in the question button's accessible name", () => {
    renderRow(decisionFixture(), false);
    expect(
      screen.getByRole('button', { name: /^Scheduler\s*, waiting on you\b/ }),
    ).toBeTruthy();
  });

  it('keeps the word out of sight — it is for assistive tech only', () => {
    renderRow(decisionFixture(), false);
    const word = screen.getByText(/^, waiting on you$/);
    expect(word.className.split(/\s+/)).toContain('sr-only');
  });

  it('does not add it to a stale row, whose visible summary already says it', () => {
    renderRow(
      decisionFixture({ status: 'stale', staleReason: 'Thursday 9:30 was booked.' }),
      false,
    );
    expect(screen.queryByText(/waiting on you/i)).toBeNull();
  });
});

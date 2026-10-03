/**
 * WHAT THE CARD'S BUTTONS ACTUALLY DO.
 *
 * `DecisionRow` has had a click-wiring test since it was written ("every control
 * actually calls something"). `ApprovalCard` did not, and that asymmetry is
 * exactly where the two renderers drifted: the card shipped a button labelled
 * "Pick another time" wired to DISMISS, so a person asking to reschedule turned
 * the held tool call down instead — recoverable only if they noticed the receipt
 * and hit Undo inside ten seconds.
 *
 * Parity of WORDS is covered in `decision-renderers.test.tsx`. This is parity of
 * CONSEQUENCE: render the open card, click each control, and assert precisely
 * which handler fired and how many times.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalCard } from '../ApprovalCard';
import { decisionFixture, resolvedFixture } from './decision-fixture';
import { toWireDecision } from '@/server/routes-workspace';

describe('ApprovalCard — what each control does', () => {
  it('offers exactly two controls on an open decision: approve and dismiss', () => {
    const d = decisionFixture();
    render(
      <ApprovalCard
        decision={d}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      d.primaryLabel,
      d.ghostLabel,
    ]);
    // The one that used to be here. In the queue it opens the agent; inside the
    // agent's own thread there is nowhere for it to go, so it is gone rather
    // than pointed at the nearest handler.
    expect(screen.queryByRole('button', { name: d.secondaryLabel })).toBeNull();
  });

  it('every control calls its own handler — and nothing else', () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const onUndo = vi.fn();
    const d = decisionFixture();
    render(
      <ApprovalCard
        decision={d}
        onApprove={onApprove}
        onDismiss={onDismiss}
        onUndo={onUndo}
      />,
    );

    screen.getByRole('button', { name: d.primaryLabel }).click();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(0);

    screen.getByRole('button', { name: d.ghostLabel }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledTimes(0);
  });

  it('has exactly one control that can turn the request down', () => {
    // Two dismiss buttons on one card is the regression this file exists for:
    // whatever a person clicks, at most one of them may be a refusal, and it
    // must be the one whose label says so.
    const onDismiss = vi.fn();
    const d = decisionFixture();
    render(
      <ApprovalCard
        decision={d}
        onApprove={vi.fn()}
        onDismiss={onDismiss}
        onUndo={vi.fn()}
      />,
    );
    for (const button of screen.getAllByRole('button')) button.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a stale card still approves from the primary and dismisses from the ghost', () => {
    // The stale branch re-words the primary ("Move it anyway"), which is the
    // kind of edit that quietly moves a handler onto the wrong button.
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const d = decisionFixture({
      status: 'stale',
      staleReason: 'Thursday 9:30 was booked by someone else at 11:04.',
    });
    render(
      <ApprovalCard
        decision={d}
        onApprove={onApprove}
        onDismiss={onDismiss}
        onUndo={vi.fn()}
      />,
    );
    screen.getByRole('button', { name: `${d.primaryLabel} anyway` }).click();
    screen.getByRole('button', { name: d.ghostLabel }).click();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('undo calls undo, not approve again', () => {
    const onUndo = vi.fn();
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        decision={resolvedFixture('executed')}
        onApprove={onApprove}
        onDismiss={vi.fn()}
        onUndo={onUndo}
      />,
    );
    screen.getByRole('button', { name: /Undo/ }).click();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(0);
  });

  it('a click in flight disables every control rather than removing it', () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const d = decisionFixture();
    render(
      <ApprovalCard
        decision={d}
        onApprove={onApprove}
        onDismiss={onDismiss}
        onUndo={vi.fn()}
        busy
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(2);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      button.click();
    }
    expect(onApprove).toHaveBeenCalledTimes(0);
    expect(onDismiss).toHaveBeenCalledTimes(0);
  });
});

/*
  TASK-744. The card draws `summary`/`detail` verbatim; the friendly connector
  name is WRITTEN by @ax/decisions at hold time (its canary pins that through
  the bus with a stubbed `connectors:tool-labels`). This pins the other half:
  the wire fence and the card carry "<connector> · <tool>" through intact —
  the middle dot is not eaten, and no step re-introduces the namespace.
*/
describe('ApprovalCard — a held connector tool (TASK-744)', () => {
  it('shows "<connector> · <tool>" as written, through the route fence', () => {
    const d = toWireDecision({
      ...decisionFixture(),
      summary: 'Wants to use Linear · Create issue',
      detail: 'It stopped before using Linear · Create issue and is waiting for your answer.',
    } as unknown as Parameters<typeof toWireDecision>[0]);
    const { container } = render(
      <ApprovalCard decision={d} onApprove={vi.fn()} onDismiss={vi.fn()} onUndo={vi.fn()} />,
    );
    expect(screen.getByText('Wants to use Linear · Create issue')).toBeTruthy();
    expect(container.textContent).not.toMatch(/mcp[._]+c[0-9a-f]{10}/);
  });
});

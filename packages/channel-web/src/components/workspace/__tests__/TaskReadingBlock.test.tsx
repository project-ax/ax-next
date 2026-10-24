/**
 * The task page's "{agent}’s reading" block (TASK-952): the agent's latest
 * reading, a small line of the earlier ones under its label, and the same
 * values in words.
 *
 * The copy is asserted verbatim because it is decided (TASK-952 plan, Task 6),
 * and its apostrophe is U+2019, not the ASCII one. The values are small whole
 * numbers, which every Latin-digit locale writes the same way.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { sparklinePoints } from '@/lib/task-reading';
import type { TaskDetailReport, TaskReading, TaskUpdate } from '@/lib/workspace-types';
import { TaskReadingBlock } from '../TaskReadingBlock';

const NOTE = 'These are the numbers Caveman reported at each check-in.';

const open = (value: number): TaskReading => ({ label: 'Open tickets', value });

/** The latest report, saying "Answered two." with `reading`. */
function report(reading: TaskReading | null): TaskDetailReport {
  return {
    status: 'on-track',
    update: 'Answered two.',
    ask: null,
    agentNotes: null,
    reading,
    reportedAt: '2026-10-24T10:00:00.000Z',
  };
}

/** A finished check-in whose report said `update` and sent `reading`. */
function checkIn(update: string, reading: TaskReading | null): TaskUpdate {
  return {
    firedAt: '2026-10-24T10:00:00.000Z',
    status: 'ok',
    error: null,
    report: { status: 'on-track', update, reading },
    conversationId: null,
  };
}

/** Newest first, the latest report's own check-in on top: the trend is 12, 9, 5, 3. */
const FOUR = [
  checkIn('Answered two.', open(3)),
  checkIn('Answered one.', open(5)),
  checkIn('Quiet morning.', open(9)),
  checkIn('Busy start.', open(12)),
];

function renderBlock(task: TaskDetailReport | null, updates: TaskUpdate[]) {
  return render(<TaskReadingBlock agentName="Caveman" task={task} updates={updates} />);
}

function block(): HTMLElement {
  return screen.getByRole('region', { name: 'Caveman’s reading' });
}

describe('TaskReadingBlock (TASK-952)', () => {
  it('is the agent’s reading: its label and its latest value', () => {
    renderBlock(report(open(3)), FOUR);
    const region = block();
    expect(
      within(region).getByRole('heading', { level: 2, name: 'Caveman’s reading' }),
    ).toBeInTheDocument();
    expect(within(region).getByText('Open tickets')).toBeInTheDocument();
    expect(within(region).getByText('3')).toBeInTheDocument();
  });

  it('draws the trend as one line the screen reader skips, and says the earlier values in words', () => {
    renderBlock(report(open(3)), FOUR);
    const region = block();
    const svg = region.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    // One line and nothing else: no fill, axes, target or forecast (design §3).
    expect(svg?.children).toHaveLength(1);
    const line = svg?.querySelector('polyline');
    expect(line).toHaveAttribute('fill', 'none');
    expect(line).toHaveAttribute('stroke', 'currentColor');
    expect(line).toHaveAttribute('points', sparklinePoints([12, 9, 5, 3], 96, 24, 2));
    expect(within(region).getByText('Earlier: 12 · 9 · 5')).toBeInTheDocument();
  });

  it('a first reading draws no line and has nothing earlier', () => {
    renderBlock(report(open(3)), [checkIn('Answered two.', open(3))]);
    expect(within(block()).getByText('3')).toBeInTheDocument();
    expect(block().querySelector('svg')).toBeNull();
    expect(screen.queryByText(/Earlier/)).toBeNull();
  });

  it('two readings draw the line, with one earlier value', () => {
    renderBlock(report(open(3)), [checkIn('Answered two.', open(3)), checkIn('Answered one.', open(5))]);
    expect(block().querySelector('svg')).not.toBeNull();
    expect(within(block()).getByText('Earlier: 5')).toBeInTheDocument();
  });

  it('says whose numbers they are', () => {
    renderBlock(report(open(3)), FOUR);
    const region = block();
    expect(region).toHaveAccessibleDescription(NOTE);
    const describedBy = region.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(NOTE);
  });

  it('draws nothing without a reading', () => {
    expect(renderBlock(null, FOUR).container.firstChild).toBeNull();
    expect(renderBlock(report(null), FOUR).container.firstChild).toBeNull();
  });

  it('draws the agent’s label as text', () => {
    const label = '<img src=x onerror=alert(1)>';
    renderBlock(report({ label, value: 3 }), []);
    expect(within(block()).getByText(label).textContent).toBe(label);
    expect(document.querySelector('img')).toBeNull();
  });
});

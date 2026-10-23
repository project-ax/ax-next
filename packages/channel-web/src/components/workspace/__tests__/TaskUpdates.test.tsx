/**
 * A task's Updates thread (TASK-910): its check-ins, newest first, with a run
 * of quiet "all on track" ones folded behind one line.
 *
 * The copy is asserted verbatim because it is decided (TASK-910 decisions rows
 * 13 and 14). Its apostrophe is U+2019, not the ASCII one.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { updateStamp } from '@/lib/workspace-time';
import type { TaskUpdate } from '@/lib/workspace-types';
import { TaskUpdates } from '../TaskUpdates';

const NOW = new Date('2026-10-22T15:00:00.000Z');

function update(over: Partial<TaskUpdate> = {}): TaskUpdate {
  return {
    firedAt: '2026-10-22T14:00:00.000Z',
    status: 'ok',
    error: null,
    report: { status: 'on-track', update: 'Nothing new.' },
    conversationId: null,
    ...over,
  };
}

/** Distinct times, newest first, so every entry has its own stamp. */
function onTrack(n: number): TaskUpdate {
  const at = new Date(NOW.getTime() - n * 3_600_000).toISOString();
  return update({ firedAt: at, report: { status: 'on-track', update: `Update ${n}` } });
}

function renderThread(updates: TaskUpdate[]) {
  return render(<TaskUpdates updates={updates} now={NOW} />);
}

describe('TaskUpdates (TASK-910)', () => {
  it('lists check-ins newest first, each with its mark, time and update', () => {
    renderThread([
      update({
        firedAt: '2026-10-22T14:00:00.000Z',
        report: { status: 'needs-you', update: 'Three invoices are overdue.' },
      }),
      update({
        firedAt: '2026-10-21T14:00:00.000Z',
        report: { status: 'off-track', update: 'The queue is backing up.' },
      }),
    ]);
    const section = screen.getByRole('region', { name: 'Updates' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Updates' })).toBeInTheDocument();
    const items = within(section).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe(
      `${updateStamp('2026-10-22T14:00:00.000Z', NOW)}Needs youThree invoices are overdue.`,
    );
    expect(items[1]!.textContent).toBe(
      `${updateStamp('2026-10-21T14:00:00.000Z', NOW)}Off trackThe queue is backing up.`,
    );
    // The mark is a shape, so each entry says its state in words too.
    expect(within(items[0]!).getByText('Needs you')).toHaveClass('sr-only');
    expect(within(items[1]!).getByText('Off track')).toHaveClass('sr-only');
  });

  it('a check-in that left no update says so', () => {
    renderThread([
      update({ report: null }),
      update({
        firedAt: '2026-10-22T13:00:00.000Z',
        report: { status: 'needs-you', update: null },
      }),
    ]);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('Checked in but didn’t leave an update')).toBeInTheDocument();
    expect(within(items[0]!).getByText('No update yet')).toHaveClass('sr-only');
    expect(within(items[1]!).getByText('It left an update we can’t show.')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Needs you')).toHaveClass('sr-only');
  });

  it('a failed check-in says it didn’t finish, with the reason it recorded', () => {
    renderThread([
      update({ status: 'error', error: 'The mailbox said no.', report: null }),
      update({ firedAt: '2026-10-22T13:00:00.000Z', status: 'error', error: null, report: null }),
      update({
        firedAt: '2026-10-22T12:00:00.000Z',
        status: 'error',
        error: 'It ran out of time.',
        report: { status: 'off-track', update: 'Got partway through the inbox.' },
      }),
    ]);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('This check-in didn’t finish.')).toBeInTheDocument();
    expect(within(items[0]!).getByText('The mailbox said no.')).toHaveClass('text-muted-foreground');
    expect(within(items[1]!).getByText('This check-in didn’t finish.')).toBeInTheDocument();
    expect(within(items[1]!).getByText('No reason was recorded.')).toBeInTheDocument();
    // A report that landed before the failure is still shown, with the reason under it.
    expect(within(items[2]!).getByText('Got partway through the inbox.')).toBeInTheDocument();
    expect(within(items[2]!).getByText('It ran out of time.')).toBeInTheDocument();
    expect(within(items[2]!).queryByText('This check-in didn’t finish.')).toBeNull();
  });

  it('folds a run of on-track check-ins behind one line that opens', () => {
    renderThread([onTrack(1), onTrack(2), onTrack(3), onTrack(4), onTrack(5), onTrack(6)]);
    expect(screen.getAllByText(/^Update \d$/)).toHaveLength(1);
    expect(screen.getByText('Update 1')).toBeInTheDocument();
    const fold = screen.getByRole('button', { name: '5 earlier check-ins, all on track' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText(/^Update \d$/).map((e) => e.textContent)).toEqual([
      'Update 1',
      'Update 2',
      'Update 3',
      'Update 4',
      'Update 5',
      'Update 6',
    ]);
  });

  it('keeps a failed check-in out of the fold', () => {
    renderThread([
      onTrack(1),
      onTrack(2),
      onTrack(3),
      update({ firedAt: '2026-10-22T10:00:00.000Z', status: 'error', error: 'Boom.', report: null }),
      onTrack(5),
    ]);
    expect(
      screen.getByRole('button', { name: '2 earlier check-ins, all on track' }),
    ).toBeInTheDocument();
    expect(screen.getByText('This check-in didn’t finish.')).toBeInTheDocument();
    expect(screen.getByText('Update 5')).toBeInTheDocument();
  });

  it('says when there are no check-ins yet', () => {
    renderThread([]);
    expect(screen.getByRole('heading', { level: 2, name: 'Updates' })).toBeInTheDocument();
    expect(screen.getByText('No check-ins yet.')).toHaveClass('text-muted-foreground');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('draws an update as plain text', () => {
    const text =
      '**bold** <b>b</b> <img src="x"> [link](https://x.test) <a href="https://x.test">a</a>';
    const { container } = renderThread([
      update({ report: { status: 'needs-you', update: text } }),
      update({
        firedAt: '2026-10-22T13:00:00.000Z',
        status: 'error',
        error: '**boom** <img src="y">',
        report: null,
      }),
    ]);
    expect(screen.getByText(text).textContent).toBe(text);
    expect(screen.getByText('**boom** <img src="y">')).toBeInTheDocument();
    expect(container.querySelector('strong, b, a, img')).toBeNull();
  });

  it('leaves room after an update for a link to follow', () => {
    renderThread([update()]);
    const body = screen.getByText('Nothing new.').closest('div');
    expect(body).toHaveClass('min-w-0', 'flex-1');
  });
});

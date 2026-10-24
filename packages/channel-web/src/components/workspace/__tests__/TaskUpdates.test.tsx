/**
 * A task's Updates thread (TASK-910): its check-ins, newest first, with a run
 * of quiet "all on track" ones folded behind one line.
 *
 * TASK-931 adds the person's replies to the same thread.
 *
 * The copy is asserted verbatim because it is decided (TASK-910 decisions rows
 * 13 and 14). Its apostrophe is U+2019, not the ASCII one.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { updateStamp } from '@/lib/workspace-time';
import type { TaskReply, TaskUpdate } from '@/lib/workspace-types';
import { TaskUpdates } from '../TaskUpdates';

const NOW = new Date('2026-10-22T15:00:00.000Z');

function update(over: Partial<TaskUpdate> = {}): TaskUpdate {
  return {
    firedAt: '2026-10-22T14:00:00.000Z',
    status: 'ok',
    error: null,
    report: { status: 'on-track', update: 'Nothing new.', reading: null },
    conversationId: null,
    ...over,
  };
}

/** Distinct times, newest first, so every entry has its own stamp. */
function onTrack(n: number): TaskUpdate {
  const at = new Date(NOW.getTime() - n * 3_600_000).toISOString();
  return update({ firedAt: at, report: { status: 'on-track', update: `Update ${n}`, reading: null } });
}

function renderThread(updates: TaskUpdate[], replies: TaskReply[] = []) {
  const onNavigate = vi.fn<(route: WorkspaceRoute) => void>();
  const view = render(
    <TaskUpdates
      updates={updates}
      replies={replies}
      now={NOW}
      agentId="a1"
      routineId="t1"
      onNavigate={onNavigate}
    />,
  );
  return { ...view, onNavigate };
}

describe('TaskUpdates (TASK-910)', () => {
  it('lists check-ins newest first, each with its mark, time and update', () => {
    renderThread([
      update({
        firedAt: '2026-10-22T14:00:00.000Z',
        report: { status: 'needs-you', update: 'Three invoices are overdue.', reading: null },
      }),
      update({
        firedAt: '2026-10-21T14:00:00.000Z',
        report: { status: 'off-track', update: 'The queue is backing up.', reading: null },
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
        report: { status: 'needs-you', update: null, reading: null },
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
        report: { status: 'off-track', update: 'Got partway through the inbox.', reading: null },
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
      update({ report: { status: 'needs-you', update: text, reading: null } }),
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

  it('each check-in links to what it did', () => {
    const { onNavigate } = renderThread([update({ conversationId: 'c1' })]);
    const stamp = updateStamp('2026-10-22T14:00:00.000Z', NOW);
    // The name carries the entry's time, so a list of these still says which is
    // which. jsdom puts a space before the visually hidden span when it
    // computes the name (a real browser doesn't), so the exact words are
    // pinned on the text and the name is matched around that space.
    const link = screen.getByRole('link', {
      name: new RegExp(`^See what it did ?, ${stamp}$`),
    });
    expect(link.textContent).toBe(`See what it did, ${stamp}`);
    expect(within(link).getByText(`, ${stamp}`)).toHaveClass('sr-only');
    expect(link).toHaveAttribute('href', '/workspace/tasks/a1/t1/checkins/c1');
    // A modified click is the browser's (a new tab), not a route change.
    // jsdom can't navigate, so the click the link leaves to the browser is
    // cancelled once React has seen it (the document listener runs after).
    const cancel = (e: Event) => e.preventDefault();
    document.addEventListener('click', cancel);
    fireEvent.click(link, { ctrlKey: true });
    document.removeEventListener('click', cancel);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'task-checkin',
      agentId: 'a1',
      routineId: 't1',
      conversationId: 'c1',
    });
  });

  it('a check-in that recorded no conversation has no link', () => {
    renderThread([update({ conversationId: null })]);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('check-ins that share one conversation have no link, since the route answers 404 for it', () => {
    // A routine that was once a repeat routine with a shared conversation: its
    // runs all recorded the same id, and no one check-in owns that transcript.
    renderThread([
      { ...onTrack(1), conversationId: 'c1' },
      update({ firedAt: onTrack(2).firedAt, report: { status: 'needs-you', update: 'Shared 2', reading: null }, conversationId: 'shared' }),
      update({ firedAt: onTrack(3).firedAt, report: { status: 'off-track', update: 'Shared 3', reading: null }, conversationId: 'shared' }),
    ]);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/workspace/tasks/a1/t1/checkins/c1');
  });

  it('a folded check-in links too', () => {
    renderThread(
      [1, 2, 3, 4, 5, 6].map((n) => ({ ...onTrack(n), conversationId: `c${n}` })),
    );
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/workspace/tasks/a1/t1/checkins/c1',
    ]);
    fireEvent.click(screen.getByRole('button', { name: '5 earlier check-ins, all on track' }));
    // Each entry links to its own check-in, in the thread's order.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(6);
    links.forEach((link, i) => {
      const entry = link.closest('li') as HTMLElement;
      expect(within(entry).getByText(`Update ${i + 1}`)).toBeInTheDocument();
      expect(link.getAttribute('href')).toMatch(new RegExp(`/checkins/c${i + 1}$`));
    });
  });

  describe('the person’s replies (TASK-931)', () => {
    function reply(over: Partial<TaskReply> = {}): TaskReply {
      return {
        sentAt: '2026-10-22T14:30:00.000Z',
        text: 'Refunds under $100 are fine.',
        byYou: true,
        ...over,
      };
    }

    it('a reply shows its time, You and the text, with no mark and no link', () => {
      renderThread([update({ firedAt: '2026-10-22T14:00:00.000Z', conversationId: 'c1' })], [reply()]);
      const items = screen.getAllByRole('listitem');
      expect(items).toHaveLength(2);
      const item = items[0]!;
      expect(item.textContent).toBe(
        `${updateStamp('2026-10-22T14:30:00.000Z', NOW)}You Refunds under $100 are fine.`,
      );
      expect(within(item).queryByRole('link')).toBeNull();
      expect(item.querySelector('.sr-only')).toBeNull();
    });

    it('someone else’s reply says so', () => {
      renderThread([], [reply({ byYou: false })]);
      expect(screen.getByText('Someone else')).toHaveClass('font-medium');
      expect(screen.queryByText('You')).toBeNull();
    });

    it('a reply that can’t be shown says so', () => {
      renderThread([], [reply({ text: null })]);
      expect(screen.getByRole('listitem').textContent).toBe(
        `${updateStamp('2026-10-22T14:30:00.000Z', NOW)}You We can’t show this reply.`,
      );
    });

    it('a reply keeps its line breaks and draws as plain text', () => {
      const text = '**bold** <img src=x onerror=alert(1)>\nsecond line';
      const { container } = renderThread([], [reply({ text })]);
      const p = container.querySelector('li p') as HTMLElement;
      expect(p).toHaveClass('whitespace-pre-wrap');
      expect(p.textContent).toBe(`You ${text}`);
      expect(container.querySelector('img, strong')).toBeNull();
    });

    it('a reply between quiet check-ins breaks the fold', () => {
      renderThread(
        [onTrack(1), onTrack(2), onTrack(4), onTrack(5), onTrack(6)],
        [reply({ sentAt: onTrack(3).firedAt })],
      );
      expect(
        screen.getByRole('button', { name: '2 earlier check-ins, all on track' }),
      ).toBeInTheDocument();
      expect(screen.getByText('Refunds under $100 are fine.', { exact: false })).toBeInTheDocument();
    });
  });
});

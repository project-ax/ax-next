/**
 * The rail's "What I learned in this chat" block (TASK-627), driven through
 * the real `useConversationMemory` with the network mocked — so a Fix or a
 * Forget is checked against the list the person actually sees, not against a
 * stub that cannot change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  workspaceApi,
  type FactMemoryStatement,
  type MemoryEventFrame,
} from '@/lib/workspace-api';
import { useConversationMemory } from '@/lib/use-conversation-memory';
import { jumpToSource, MEMORY_SOURCE_ATTR, TURN_ID_ATTR } from '@/lib/thread-jump';
import { LearnedAnnouncer, LearnedInChat, LEARNED_ROW_CAP } from '../LearnedInChat';
import {
  LEARNED_EARLIER,
  LEARNED_EXTRACTING,
  LEARNED_FROM_YOUR_MESSAGE,
  LEARNED_NOTHING_NEW,
  LEARNED_NOT_ENABLED,
  LEARNED_PAUSED,
  LEARNED_PAUSED_ACTION,
  LEARNED_READ_FAILED,
  LEARNED_READ_FAILED_ACTION,
  LEARNED_SAVE_FAILED,
  LEARNED_SEE_ALL,
  MEMORY_FIX_SAVE,
  MEMORY_FORGET,
  MEMORY_FORGOTTEN,
  MEMORY_RESTORED,
  MEMORY_UPDATED,
  learnedAnnouncement,
  learnedMore,
  learnedNewBadge,
  memoryFixLabel,
  memoryForgetLabel,
  memoryStatementText,
  memoryUndoLabel,
} from '../memory-copy';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      recallMemory: vi.fn(),
      memoryEvents: vi.fn(),
      correctMemory: vi.fn(),
      forgetMemory: vi.fn(),
      rememberMemory: vi.fn(),
    },
  };
});

const recall = vi.mocked(workspaceApi.recallMemory);
const events = vi.mocked(workspaceApi.memoryEvents);
const correct = vi.mocked(workspaceApi.correctMemory);
const forget = vi.mocked(workspaceApi.forgetMemory);
const remember = vi.mocked(workspaceApi.rememberMemory);

function st(id: string, over: Partial<FactMemoryStatement> = {}): FactMemoryStatement {
  return {
    id,
    about: 'user',
    relation: 'likes',
    value: `value ${id}`,
    when: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

let push: (f: MemoryEventFrame) => void = () => {};

function Harness({
  enabled = true,
  conversationId = 'c1',
  onJump = vi.fn(),
  onSeeAll = vi.fn(),
  onOpenModelKeys,
}: {
  enabled?: boolean;
  conversationId?: string | null;
  onJump?: (id: string) => void;
  onSeeAll?: () => void;
  onOpenModelKeys?: () => void;
}) {
  const memory = useConversationMemory({
    agentId: 'a1',
    conversationId,
    enabled,
    announce: learnedAnnouncement,
  });
  return (
    <>
      <LearnedInChat
        memory={memory}
        agentId="a1"
        visibility="personal"
        onOpenModelKeys={onOpenModelKeys}
        onJumpToSource={onJump}
        onSeeAll={onSeeAll}
      />
      <LearnedAnnouncer announcement={memory.announcement} />
    </>
  );
}

/** Rows recorded by a live pass: re-read returns them, then a `recorded` frame. */
async function recordBatch(all: FactMemoryStatement[], ids: string[]) {
  recall.mockResolvedValueOnce({ statements: all, degraded: [] });
  act(() => push({ kind: 'activity', state: 'recorded', statementIds: ids }));
}

let observers: { cb: IntersectionObserverCallback; el: Element | null }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  events.mockImplementation((_c, onFrame) => {
    push = onFrame;
    return new Promise(() => {});
  });
  recall.mockResolvedValue({ statements: [], degraded: [] });
  observers = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly entry: { cb: IntersectionObserverCallback; el: Element | null };
      constructor(cb: IntersectionObserverCallback) {
        this.entry = { cb, el: null };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.el = el;
      }
      disconnect() {
        observers = observers.filter((o) => o !== this.entry);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function scrollIntoView() {
  act(() => {
    for (const o of observers) {
      o.cb(
        [{ isIntersecting: true, target: o.el } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
  });
}

describe('LearnedInChat — the six states', () => {
  it('nothing new: says so, rather than showing an empty card', async () => {
    render(<Harness />);
    expect(await screen.findByText(LEARNED_NOTHING_NEW)).toBeTruthy();
    expect(screen.getByRole('button', { name: LEARNED_SEE_ALL })).toBeTruthy();
  });

  it('extracting: a pulse and a sentence, no progress bar', async () => {
    render(<Harness />);
    await waitFor(() => expect(events).toHaveBeenCalled());
    act(() => push({ kind: 'activity', state: 'extracting', statementIds: [] }));
    expect(screen.getByText(LEARNED_EXTRACTING)).toBeTruthy();
    expect(screen.queryByText(LEARNED_NOTHING_NEW)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('paused: explains, and offers "Fix this" only to someone who can', async () => {
    const onOpenModelKeys = vi.fn();
    const { unmount } = render(<Harness onOpenModelKeys={onOpenModelKeys} />);
    await waitFor(() => expect(events).toHaveBeenCalled());
    act(() => push({ kind: 'status', extraction: 'paused', conversation: 'idle' }));
    expect(screen.getByText(LEARNED_PAUSED)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: LEARNED_PAUSED_ACTION }));
    expect(onOpenModelKeys).toHaveBeenCalledTimes(1);
    unmount();

    render(<Harness />);
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    act(() => push({ kind: 'status', extraction: 'paused', conversation: 'idle' }));
    expect(screen.getByText(LEARNED_PAUSED)).toBeTruthy();
    expect(screen.queryByRole('button', { name: LEARNED_PAUSED_ACTION })).toBeNull();
  });

  it('save failed: says nothing is lost, and offers no button nothing backs', async () => {
    render(<Harness />);
    await waitFor(() => expect(events).toHaveBeenCalled());
    act(() => push({ kind: 'activity', state: 'failed', statementIds: [] }));
    expect(screen.getByText(LEARNED_SAVE_FAILED)).toBeTruthy();
    expect(screen.queryByRole('button', { name: LEARNED_READ_FAILED_ACTION })).toBeNull();
  });

  it('read failed: unknown, not empty — and Try again reads again', async () => {
    recall.mockRejectedValueOnce(new Error('down'));
    render(<Harness />);
    expect(await screen.findByText(LEARNED_READ_FAILED)).toBeTruthy();
    expect(screen.queryByText(LEARNED_NOTHING_NEW)).toBeNull();
    recall.mockResolvedValueOnce({ statements: [st('a')], degraded: [] });
    fireEvent.click(screen.getByRole('button', { name: LEARNED_READ_FAILED_ACTION }));
    expect(await screen.findByText(memoryStatementText(st('a')))).toBeTruthy();
  });

  it('not enabled: says the workspace has no memory, with no action and no link', () => {
    render(<Harness enabled={false} />);
    expect(screen.getByText(LEARNED_NOT_ENABLED)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });
});

describe('LearnedInChat — rows', () => {
  it('shows a live batch on top with its time, the first read under "Earlier in this chat"', async () => {
    recall.mockResolvedValueOnce({ statements: [st('old')], degraded: [] });
    render(<Harness />);
    await screen.findByText(memoryStatementText(st('old')));
    // Nothing to be earlier than yet.
    expect(screen.queryByText(LEARNED_EARLIER)).toBeNull();

    await recordBatch([st('old'), st('new')], ['new']);
    await screen.findByText(memoryStatementText(st('new')));
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    const newAt = items.findIndex((t) => t.includes('value new'));
    const earlierAt = items.findIndex((t) => t === LEARNED_EARLIER);
    const oldAt = items.findIndex((t) => t.includes('value old'));
    expect(newAt).toBeLessThan(earlierAt);
    expect(earlierAt).toBeLessThan(oldAt);
    expect(screen.getByText('just now')).toBeTruthy();
  });

  it(`caps the list at ${LEARNED_ROW_CAP} and offers the rest`, async () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      st(`r${i}`, { when: `2026-09-0${i + 1}T00:00:00.000Z` }),
    );
    recall.mockResolvedValueOnce({ statements: seven, degraded: [] });
    render(<Harness />);
    await screen.findByText(memoryStatementText(seven[6]!));
    expect(screen.getAllByRole('button', { name: /^Fix: / })).toHaveLength(LEARNED_ROW_CAP);
    fireEvent.click(screen.getByRole('button', { name: learnedMore(2) }));
    expect(screen.getAllByRole('button', { name: /^Fix: / })).toHaveLength(7);
    expect(screen.queryByRole('button', { name: learnedMore(2) })).toBeNull();
  });

  it('See all memory opens the Memory tab', async () => {
    const onSeeAll = vi.fn();
    render(<Harness onSeeAll={onSeeAll} />);
    fireEvent.click(await screen.findByRole('button', { name: LEARNED_SEE_ALL }));
    expect(onSeeAll).toHaveBeenCalledTimes(1);
  });
});

describe('LearnedInChat — "N new"', () => {
  it('counts a batch as new, and clears only once the block has been on screen', async () => {
    render(<Harness />);
    await waitFor(() => expect(events).toHaveBeenCalled());
    await recordBatch([st('a'), st('b')], ['a', 'b']);
    expect(await screen.findByText(learnedNewBadge(2))).toBeTruthy();
    // Rendering is not seeing: nothing has intersected yet.
    await act(async () => {});
    expect(screen.getByText(learnedNewBadge(2))).toBeTruthy();

    scrollIntoView();
    expect(screen.queryByText(learnedNewBadge(2))).toBeNull();
  });

  it('announces each batch once, politely', async () => {
    render(<Harness />);
    await waitFor(() => expect(events).toHaveBeenCalled());
    const region = document.querySelector('[data-learned-announcer]') as HTMLElement;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    // Mounted before it has anything to say.
    expect(region.textContent).toBe('');

    await recordBatch([st('a'), st('b'), st('c')], ['a', 'b', 'c']);
    await waitFor(() => expect(region.textContent).toBe(learnedAnnouncement(3)));
  });

  it('keys each announcement by batch, so the same sentence twice is still said twice', () => {
    const { rerender } = render(<LearnedAnnouncer announcement={{ text: 'Learned 1.', seq: 1 }} />);
    const first = screen.getByText('Learned 1.');
    rerender(<LearnedAnnouncer announcement={{ text: 'Learned 1.', seq: 2 }} />);
    expect(screen.getByText('Learned 1.')).not.toBe(first);
  });
});

describe('LearnedInChat — Fix, Forget, Undo', () => {
  it('Fix uses the shared dialog, keeps the row in its fixed form and says "Updated."', async () => {
    recall.mockResolvedValueOnce({ statements: [st('a', { value: 'Boston' })], degraded: [] });
    correct.mockResolvedValue({ id: 'a2' });
    render(<Harness />);
    const text = memoryStatementText(st('a', { value: 'Boston' }));
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel(text) }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Denver' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'It was never right' }));
    fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FIX_SAVE }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(correct).toHaveBeenCalledWith('a1', {
      id: 'a',
      about: 'user',
      relation: 'likes',
      value: 'Denver',
      reason: 'never-right',
    });
    expect(screen.getByText(memoryStatementText(st('a2', { value: 'Denver' })))).toBeTruthy();
    expect(screen.getByText(MEMORY_UPDATED)).toBeTruthy();

    // The fixed row is not in the feed any more; it stays listed anyway.
    await recordBatch([], []);
    await waitFor(() => expect(recall).toHaveBeenCalledTimes(2));
    expect(screen.getByText(memoryStatementText(st('a2', { value: 'Denver' })))).toBeTruthy();
  });

  it('Forget collapses the row into its receipt, focuses Undo, and Undo brings it back', async () => {
    recall.mockResolvedValueOnce({ statements: [st('a')], degraded: [] });
    forget.mockResolvedValue({ forgotten: true });
    remember.mockResolvedValue({ id: 'a3' });
    render(<Harness />);
    const text = memoryStatementText(st('a'));
    fireEvent.click(await screen.findByRole('button', { name: memoryForgetLabel(text) }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FORGET }));

    const undo = await screen.findByRole('button', { name: memoryUndoLabel(st('a').value) });
    expect(forget).toHaveBeenCalledWith('a1', ['a']);
    expect(screen.getByText(MEMORY_FORGOTTEN)).toBeTruthy();
    expect(undo.textContent).toMatch(/^Undo \d+s$/);
    expect(screen.queryByText(text)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(undo));

    fireEvent.click(undo);
    expect(await screen.findByText(MEMORY_RESTORED)).toBeTruthy();
    expect(remember).toHaveBeenCalledWith('a1', {
      about: 'user',
      relation: 'likes',
      value: st('a').value,
    });
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('a forgotten row leaves the list when the Undo offer runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    recall.mockResolvedValueOnce({ statements: [st('a'), st('b')], degraded: [] });
    forget.mockResolvedValue({ forgotten: true });
    render(<Harness />);
    fireEvent.click(
      await screen.findByRole('button', { name: memoryForgetLabel(memoryStatementText(st('a'))) }),
    );
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: MEMORY_FORGET }));
    await screen.findByText(MEMORY_FORGOTTEN);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    await waitFor(() => expect(screen.queryByText(MEMORY_FORGOTTEN)).toBeNull());
    expect(screen.getAllByRole('button', { name: /^Fix: / })).toHaveLength(1);
  });
});

describe('LearnedInChat — "from your message"', () => {
  it('hover highlights the source message without scrolling; click jumps to it', async () => {
    const onJump = vi.fn();
    const msg = document.createElement('div');
    msg.setAttribute(TURN_ID_ATTR, 't-7');
    document.body.appendChild(msg);
    recall.mockResolvedValueOnce({
      statements: [st('a', { sourceTurnId: 't-7' }), st('b')],
      degraded: [],
    });
    render(<Harness onJump={onJump} />);
    const links = await screen.findAllByRole('button', { name: LEARNED_FROM_YOUR_MESSAGE });
    // Only the row that came from a message points at one.
    expect(links).toHaveLength(1);

    fireEvent.mouseEnter(links[0]!);
    expect(msg.getAttribute(MEMORY_SOURCE_ATTR)).toBe('preview');
    fireEvent.mouseLeave(links[0]!);
    expect(msg.hasAttribute(MEMORY_SOURCE_ATTR)).toBe(false);

    fireEvent.click(links[0]!);
    expect(onJump).toHaveBeenCalledWith('t-7');
    msg.remove();
  });

  it('jumpToSource scrolls the message into view and highlights it briefly', () => {
    vi.useFakeTimers();
    const msg = document.createElement('div');
    msg.setAttribute(TURN_ID_ATTR, 'weird "id"]');
    const scroll = vi.fn();
    msg.scrollIntoView = scroll;
    document.body.appendChild(msg);

    expect(jumpToSource('weird "id"]')).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(msg.getAttribute(MEMORY_SOURCE_ATTR)).toBe('flash');
    vi.advanceTimersByTime(2_000);
    expect(msg.hasAttribute(MEMORY_SOURCE_ATTR)).toBe(false);
    expect(jumpToSource('not-on-screen')).toBe(false);
    msg.remove();
  });
});

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
import {
  jumpToSource,
  MEMORY_SOURCE_ATTR,
  TURN_ID_ATTR,
  type TurnSource,
} from '@/lib/thread-jump';
import { LearnedAnnouncer, LearnedInChat, LEARNED_ROW_CAP } from '../LearnedInChat';
import {
  LEARNED_EARLIER,
  LEARNED_EXTRACTING,
  LEARNED_FROM_MY_REPLY,
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
  MEMORY_FIX_UNDONE,
  MEMORY_FORGET,
  MEMORY_FORGOTTEN,
  MEMORY_RESTORED,
  MEMORY_UPDATED,
  learnedAnnouncement,
  learnedMore,
  learnedNewBadge,
  learnedSourceLabel,
  memoryFixLabel,
  memoryForgetLabel,
  memoryStatementText,
  memoryUndoFixLabel,
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
      unforgetMemory: vi.fn(),
      uncorrectMemory: vi.fn(),
    },
  };
});

const recall = vi.mocked(workspaceApi.recallMemory);
const events = vi.mocked(workspaceApi.memoryEvents);
const correct = vi.mocked(workspaceApi.correctMemory);
const forget = vi.mocked(workspaceApi.forgetMemory);
const unforget = vi.mocked(workspaceApi.unforgetMemory);
const uncorrect = vi.mocked(workspaceApi.uncorrectMemory);

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
  sources = new Map(),
}: {
  enabled?: boolean;
  conversationId?: string | null;
  onJump?: (id: string) => void;
  onSeeAll?: () => void;
  onOpenModelKeys?: () => void;
  sources?: ReadonlyMap<string, TurnSource>;
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
        sourceOf={(turnId) => sources.get(turnId)}
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
    const newRow = screen.getByText(memoryStatementText(st('new')));
    const label = screen.getByText(LEARNED_EARLIER);
    const oldRow = screen.getByText(memoryStatementText(st('old')));
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(newRow.compareDocumentPosition(label) & FOLLOWING).toBeTruthy();
    expect(label.compareDocumentPosition(oldRow) & FOLLOWING).toBeTruthy();
    // A group label, not a memory: it does not count as a list item.
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).not.toContain(
      LEARNED_EARLIER,
    );
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

  it('Undo on a Fix puts the original row back in place of the fixed one (TASK-634)', async () => {
    const original = st('a', { value: 'Boston' });
    recall.mockResolvedValueOnce({ statements: [original], degraded: [] });
    correct.mockResolvedValue({ id: 'a2' });
    uncorrect.mockResolvedValue({ undone: true });
    render(<Harness />);
    fireEvent.click(
      await screen.findByRole('button', { name: memoryFixLabel(memoryStatementText(original)) }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Denver' } });
    fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FIX_SAVE }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const fixedText = memoryStatementText(st('a2', { value: 'Denver' }));
    expect(screen.getByText(fixedText)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: memoryUndoFixLabel('Denver') }));
    await waitFor(() => expect(uncorrect).toHaveBeenCalledWith('a1', { id: 'a2', restore: 'a' }));
    expect(await screen.findByText(memoryStatementText(original))).toBeTruthy();
    expect(screen.queryByText(fixedText)).toBeNull();
    // The receipt follows the row back: it sits on the original, which offers Fix again.
    const row = screen.getByText(memoryStatementText(original)).closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText(MEMORY_FIX_UNDONE)).toBeTruthy();
    expect(
      within(row!).getByRole('button', { name: memoryFixLabel(memoryStatementText(original)) }),
    ).toBeTruthy();

    // The original is not a new row in the feed; it stays listed anyway.
    await recordBatch([], []);
    await waitFor(() => expect(recall).toHaveBeenCalledTimes(2));
    expect(screen.getByText(memoryStatementText(original))).toBeTruthy();
  });

  it('Forget collapses the row into its receipt, focuses Undo, and Undo brings it back', async () => {
    recall.mockResolvedValueOnce({ statements: [st('a')], degraded: [] });
    forget.mockResolvedValue({ forgotten: true });
    unforget.mockResolvedValue({ restored: ['a'] });
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
    // The same memory comes back (TASK-630's un-forget), so the row keeps its id.
    expect(unforget).toHaveBeenCalledWith('a1', ['a']);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('a forgotten row stays gone when a second Forget replaces its receipt', async () => {
    recall.mockResolvedValueOnce({ statements: [st('a'), st('b'), st('c')], degraded: [] });
    forget.mockResolvedValue({ forgotten: true });
    render(<Harness />);
    const forgetRow = async (id: string) => {
      fireEvent.click(
        await screen.findByRole('button', {
          name: memoryForgetLabel(memoryStatementText(st(id))),
        }),
      );
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: MEMORY_FORGET }),
      );
      await screen.findByRole('button', { name: memoryUndoLabel(st(id).value) });
    };
    await forgetRow('a');
    await forgetRow('b');
    // "a" was forgotten; losing its receipt must not bring it back as a live row.
    expect(screen.queryByText(memoryStatementText(st('a')))).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Fix: / })).toHaveLength(1);
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
    const sources = new Map([['t-7', { speaker: 'person' as const, excerpt: 'Moving to Denver' }]]);
    render(<Harness onJump={onJump} sources={sources} />);
    const links = await screen.findAllByRole('button', {
      name: learnedSourceLabel('person', 'Moving to Denver'),
    });
    expect(links[0]).toHaveTextContent(LEARNED_FROM_YOUR_MESSAGE);
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

  it('labels a row by who said its source turn, not by who the fact is about', async () => {
    // Both facts are ABOUT the person; one was said back in the agent's reply.
    recall.mockResolvedValueOnce({
      statements: [
        st('mine', { sourceTurnId: 't-user' }),
        st('echoed', { sourceTurnId: 't-agent' }),
      ],
      degraded: [],
    });
    const sources = new Map<string, TurnSource>([
      ['t-user', { speaker: 'person', excerpt: 'Our go-live moved to Oct 14' }],
      ['t-agent', { speaker: 'agent', excerpt: 'Got it — Oct 14 for the go-live' }],
    ]);
    render(<Harness sources={sources} />);
    const yours = await screen.findByRole('button', {
      name: learnedSourceLabel('person', 'Our go-live moved to Oct 14'),
    });
    const reply = screen.getByRole('button', {
      name: learnedSourceLabel('agent', 'Got it — Oct 14 for the go-live'),
    });
    expect(yours).toHaveTextContent(LEARNED_FROM_YOUR_MESSAGE);
    expect(reply).toHaveTextContent(LEARNED_FROM_MY_REPLY);
    // Each link says WHICH message — no two read the same.
    expect(yours.getAttribute('aria-label')).not.toBe(reply.getAttribute('aria-label'));
  });

  it('draws no link for a turn that is not in the thread on screen — nothing to jump to', async () => {
    recall.mockResolvedValueOnce({
      statements: [st('a', { sourceTurnId: 't-gone' })],
      degraded: [],
    });
    render(<Harness />);
    await screen.findByText(memoryStatementText(st('a')));
    expect(screen.queryByText(LEARNED_FROM_YOUR_MESSAGE)).toBeNull();
    expect(screen.queryByText(LEARNED_FROM_MY_REPLY)).toBeNull();
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  workspaceApi,
  type FactMemoryStatement,
  type MemoryEventFrame,
  type MemoryEventsEnd,
} from '../workspace-api';
import { useConversationMemory } from '../use-conversation-memory';

vi.mock('../workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../workspace-api');
  return { ...actual, workspaceApi: { recallMemory: vi.fn(), memoryEvents: vi.fn() } };
});

const recall = vi.mocked(workspaceApi.recallMemory);
const events = vi.mocked(workspaceApi.memoryEvents);

function st(id: string, over: Partial<FactMemoryStatement> = {}): FactMemoryStatement {
  return {
    id,
    about: 'user',
    relation: 'likes',
    value: id,
    when: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function page(...statements: FactMemoryStatement[]) {
  return { statements, degraded: [] };
}

/** A stream the test drives: push frames, then end it. */
function controllableStream() {
  let push: (f: MemoryEventFrame) => void = () => {};
  let finish: (end: MemoryEventsEnd) => void = () => {};
  events.mockImplementation((_c, onFrame, signal) => {
    push = onFrame;
    return new Promise<MemoryEventsEnd>((resolve) => {
      finish = resolve;
      signal?.addEventListener('abort', () => resolve('aborted'));
    });
  });
  return {
    push: (f: MemoryEventFrame) => act(() => push(f)),
    end: (e: MemoryEventsEnd) => act(() => finish(e)),
  };
}

const announce = (n: number) => `Learned ${n}.`;

function mount(conversationId: string | null = 'c1', enabled = true) {
  return renderHook(() =>
    useConversationMemory({ agentId: 'a1', conversationId, enabled, announce }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('useConversationMemory', () => {
  it('reads the conversation feed newest first, as the first read (not new)', async () => {
    controllableStream();
    recall.mockResolvedValue(
      page(st('old', { when: '2026-01-01T00:00:00Z' }), st('new', { when: '2026-02-01T00:00:00Z' })),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(recall).toHaveBeenCalledWith('a1', { conversationId: 'c1' });
    expect(result.current.rows.map((r) => r.row.id)).toEqual(['new', 'old']);
    expect(result.current.rows.every((r) => r.batch === 0 && r.arrivedAt === null)).toBe(true);
    expect(result.current.unseen).toBe(0);
    expect(result.current.announcement).toBeNull();
  });

  it('turns a recorded frame into one batch on top: unseen, announced once', async () => {
    const s = controllableStream();
    recall.mockResolvedValueOnce(page(st('a')));
    const { result } = mount();
    await waitFor(() => expect(events).toHaveBeenCalled());

    recall.mockResolvedValueOnce(page(st('a'), st('b'), st('c')));
    await s.push({ kind: 'activity', state: 'recorded', statementIds: ['b', 'c'] });
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows[0]?.batch).toBe(1);
    expect(result.current.rows[2]?.row.id).toBe('a');
    expect(result.current.unseen).toBe(2);
    expect(result.current.announcement).toEqual({ text: 'Learned 2.', seq: 1 });

    act(() => result.current.markSeen());
    expect(result.current.unseen).toBe(0);
  });

  it('follows the pass state from the snapshot and activity frames', async () => {
    const s = controllableStream();
    recall.mockResolvedValue(page());
    const { result } = mount();
    await waitFor(() => expect(events).toHaveBeenCalled());
    await s.push({ kind: 'status', extraction: 'ok', conversation: 'extracting' });
    expect(result.current.pass).toBe('extracting');
    await s.push({ kind: 'activity', state: 'failed', statementIds: [] });
    expect(result.current.pass).toBe('failed');
    await s.push({ kind: 'activity', state: 'paused', statementIds: [] });
    expect(result.current.extraction).toBe('paused');
    expect(result.current.pass).toBe('idle');
  });

  it('says not-enabled on a 503 stream, and never reads when memory is off', async () => {
    const s = controllableStream();
    recall.mockResolvedValue(page());
    const { result } = mount();
    await waitFor(() => expect(events).toHaveBeenCalled());
    await s.end('unavailable');
    expect(result.current.status).toBe('not-enabled');

    vi.clearAllMocks();
    const off = mount('c1', false);
    expect(off.result.current.status).toBe('not-enabled');
    expect(recall).not.toHaveBeenCalled();
  });

  it('says read-failed when the list cannot be read, and retry starts over', async () => {
    controllableStream();
    recall.mockRejectedValueOnce(new Error('boom'));
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe('read-failed'));
    // An unread list gets no live stream stacked on it.
    expect(events).not.toHaveBeenCalled();

    recall.mockResolvedValueOnce(page(st('a')));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows).toHaveLength(1);
  });

  it('says read-failed when the stream will not open', async () => {
    const s = controllableStream();
    recall.mockResolvedValue(page());
    const { result } = mount();
    await waitFor(() => expect(events).toHaveBeenCalled());
    await s.end('failed');
    expect(result.current.status).toBe('read-failed');
  });

  it('is an honest empty list with no conversation yet, and opens nothing', () => {
    const { result } = mount(null);
    expect(result.current.status).toBe('ready');
    expect(result.current.rows).toEqual([]);
    expect(recall).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it('keeps a fixed row listed in its new form after the feed stops returning it', async () => {
    const s = controllableStream();
    recall.mockResolvedValueOnce(page(st('a'), st('b')));
    const { result } = mount();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    act(() => result.current.replaceRow('a', st('a2', { value: 'fixed' })));
    // The fixed row is a person's write with no conversation: the feed has neither.
    recall.mockResolvedValueOnce(page(st('b'), st('c')));
    await s.push({ kind: 'activity', state: 'recorded', statementIds: ['c'] });
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows.map((r) => r.row.id)).toEqual(['c', 'a2', 'b']);
    expect(result.current.rows[1]?.row.value).toBe('fixed');
  });

  it('removeRow takes a row off for good, even if the feed still lists it', async () => {
    const s = controllableStream();
    recall.mockResolvedValueOnce(page(st('a'), st('b')));
    const { result } = mount();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => result.current.removeRow('a'));
    recall.mockResolvedValueOnce(page(st('a'), st('b')));
    await s.push({ kind: 'activity', state: 'recorded', statementIds: [] });
    await waitFor(() => expect(recall).toHaveBeenCalledTimes(2));
    expect(result.current.rows.map((r) => r.row.id)).toEqual(['b']);
    expect(result.current.unseen).toBe(0);
  });

  it('keeps a shown list on screen when a background re-read fails', async () => {
    const s = controllableStream();
    recall.mockResolvedValueOnce(page(st('a'), st('b')));
    const { result } = mount();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    recall.mockRejectedValueOnce(new Error('blip'));
    await s.push({ kind: 'activity', state: 'recorded', statementIds: ['c'] });
    await waitFor(() => expect(recall).toHaveBeenCalledTimes(2));
    await act(async () => {});
    // Known-good rows are not thrown away over a blip.
    expect(result.current.status).toBe('ready');
    expect(result.current.rows).toHaveLength(2);
  });

  it('keeps reconnecting when the re-read after a reconnect fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = controllableStream();
    recall.mockResolvedValueOnce(page(st('a')));
    const { result } = mount();
    await waitFor(() => expect(events).toHaveBeenCalledTimes(1));
    recall.mockRejectedValueOnce(new Error('blip'));
    await s.end('ended');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    // The stream is not gated on one feed read succeeding.
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    expect(result.current.rows).toHaveLength(1);
  });

  it('reconnects after the stream ends, and a row recorded meanwhile is a batch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = controllableStream();
    recall.mockResolvedValueOnce(page());
    const { result } = mount();
    await waitFor(() => expect(events).toHaveBeenCalledTimes(1));
    recall.mockResolvedValueOnce(page(st('late')));
    await s.end('ended');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    expect(result.current.rows[0]?.row.id).toBe('late');
    expect(result.current.unseen).toBe(1);
  });
});

/*
  TASK-643: one ledger of fixes for the conversation, written by the rail and
  by the "Used N memories" chip alike.
*/
describe('useConversationMemory — the fix ledger', () => {
  it('records a fix and swaps the listed row for its fixed form, in place', async () => {
    controllableStream();
    recall.mockResolvedValueOnce(page(st('a', { value: 'Boston', sourceTurnId: 't1' }), st('b')));
    const { result } = mount();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    // The chip hands in ITS copy of the row, which carries no source turn.
    act(() =>
      result.current.recordFix({ row: st('a', { value: 'Boston' }), id: 'a2', value: 'Denver' }, 'changed'),
    );
    expect(result.current.fixes.get('a')).toEqual({ kind: 'replaced', id: 'a2', value: 'Denver' });
    expect(result.current.rows.map((r) => r.row.id)).toEqual(['a2', 'b']);
    // The rail keeps its own fields (the source link) on the fixed row.
    expect(result.current.rows[0]?.row).toMatchObject({ id: 'a2', value: 'Denver', sourceTurnId: 't1' });
  });

  it('"It was never right" is recorded as retracted', async () => {
    controllableStream();
    recall.mockResolvedValueOnce(page(st('a')));
    const { result } = mount();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.recordFix({ row: st('a'), id: 'a2', value: 'x' }, 'never-right'));
    expect(result.current.fixes.get('a')?.kind).toBe('retracted');
  });

  it('records a fix to a row the rail does not list, without adding it to the list', async () => {
    controllableStream();
    recall.mockResolvedValueOnce(page(st('b')));
    const { result } = mount();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.recordFix({ row: st('elsewhere'), id: 'e2', value: 'x' }, 'changed'));
    expect(result.current.fixes.has('elsewhere')).toBe(true);
    expect(result.current.rows.map((r) => r.row.id)).toEqual(['b']);
  });

  it('undoFix drops the entry and puts back the row the rail listed, not the caller’s copy', async () => {
    controllableStream();
    const listed = st('a', { value: 'Boston', sourceTurnId: 't1' });
    recall.mockResolvedValueOnce(page(listed));
    const { result } = mount();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const fix = { row: st('a', { value: 'Boston' }), id: 'a2', value: 'Denver' };
    act(() => result.current.recordFix(fix, 'changed'));
    act(() => result.current.undoFix(fix));
    expect(result.current.fixes.has('a')).toBe(false);
    expect(result.current.rows.map((r) => r.row)).toEqual([listed]);
  });

  it('keeps the ledger through a retry, and starts over for another conversation', async () => {
    controllableStream();
    recall.mockResolvedValue(page(st('a')));
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useConversationMemory({ agentId: 'a1', conversationId, enabled: true, announce }),
      { initialProps: { conversationId: 'c1' } },
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.recordFix({ row: st('a'), id: 'a2', value: 'x' }, 'changed'));

    act(() => result.current.retry());
    await waitFor(() => expect(recall).toHaveBeenCalledTimes(2));
    expect(result.current.fixes.has('a')).toBe(true);

    rerender({ conversationId: 'c2' });
    await waitFor(() => expect(result.current.fixes.size).toBe(0));
  });
});

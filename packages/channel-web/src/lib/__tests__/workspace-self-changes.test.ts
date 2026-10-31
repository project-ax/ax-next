/**
 * The client half of "agents' own identity changes on Today" (TASK-990): the
 * host's words, the rows built from the roster, and the hook that reads on each
 * Today entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { workspaceApi } from '../workspace-api';
import type { SelfChange, SelfChangesResponse } from '../workspace-types';
import { SELF_CHANGE_WORDS, selfChangeRows, useSelfChanges } from '../workspace-self-changes';

vi.mock('../workspace-api', async () => {
  const actual = await vi.importActual<typeof import('../workspace-api')>('../workspace-api');
  return { ...actual, workspaceApi: { ...actual.workspaceApi, selfChanges: vi.fn() } };
});

const selfChangesMock = vi.mocked(workspaceApi.selfChanges);

const change = (over: Partial<SelfChange> = {}): SelfChange => ({
  agentId: 'a-quill',
  section: 'soul',
  changedAt: '2026-10-30T10:00:00.000Z',
  ...over,
});

describe('SELF_CHANGE_WORDS', () => {
  it('is the host wording, keyed by section', () => {
    expect(SELF_CHANGE_WORDS).toEqual({
      identity: 'changed how it describes itself',
      soul: 'changed its personality',
    });
  });
});

describe('selfChangeRows', () => {
  const roster = [
    { id: 'a-quill', name: 'Quill' },
    { id: 'a-tern', name: 'Tern' },
  ];

  it('drops a change whose agent the roster does not have', () => {
    const rows = selfChangeRows([change({ agentId: 'a-gone' }), change()], roster);
    expect(rows.map((r) => r.agentId)).toEqual(['a-quill']);
    expect(selfChangeRows([change()], [])).toEqual([]);
  });

  it('orders newest first and names each row from the roster', () => {
    const rows = selfChangeRows(
      [
        change({ agentId: 'a-quill', section: 'soul', changedAt: '2026-10-28T10:00:00.000Z' }),
        change({ agentId: 'a-tern', section: 'identity', changedAt: '2026-10-30T10:00:00.000Z' }),
        change({ agentId: 'a-tern', section: 'soul', changedAt: 'not a date' }),
      ],
      roster,
    );
    expect(rows.map((r) => [r.agentName, r.words])).toEqual([
      ['Tern', 'changed how it describes itself'],
      ['Quill', 'changed its personality'],
      ['Tern', 'changed its personality'],
    ]);
    expect(rows[0]?.key).toBe(JSON.stringify(['a-tern', 'identity']));
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });
});

describe('useSelfChanges', () => {
  beforeEach(() => {
    selfChangesMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  /** A read the test settles by hand. */
  function deferred() {
    let resolve!: (v: SelfChangesResponse) => void;
    const promise = new Promise<SelfChangesResponse>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('reads when it becomes active and again on each re-activation', async () => {
    selfChangesMock.mockResolvedValue({ changes: [change()] });
    const { result, rerender } = renderHook(({ active }) => useSelfChanges(active), {
      initialProps: { active: false },
    });
    expect(selfChangesMock).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);

    rerender({ active: true });
    await act(async () => {});
    expect(selfChangesMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([change()]);

    rerender({ active: false });
    expect(selfChangesMock).toHaveBeenCalledTimes(1);

    selfChangesMock.mockResolvedValue({ changes: [change({ section: 'identity' })] });
    rerender({ active: true });
    await act(async () => {});
    expect(selfChangesMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual([change({ section: 'identity' })]);
  });

  it('ignores a reply that lands after a newer read began', async () => {
    const first = deferred();
    const second = deferred();
    selfChangesMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ active }) => useSelfChanges(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    rerender({ active: true });
    expect(selfChangesMock).toHaveBeenCalledTimes(2);

    const newer = [change({ agentId: 'a-tern' })];
    await act(async () => {
      second.resolve({ changes: newer });
    });
    await act(async () => {
      first.resolve({ changes: [change({ agentId: 'a-quill', section: 'identity' })] });
    });
    expect(result.current).toEqual(newer);
  });

  it('keeps what it had when a read fails, and says so once', async () => {
    selfChangesMock.mockResolvedValueOnce({ changes: [change()] });
    const { result, rerender } = renderHook(({ active }) => useSelfChanges(active), {
      initialProps: { active: true },
    });
    await act(async () => {});
    expect(result.current).toEqual([change()]);

    selfChangesMock.mockRejectedValueOnce(new Error('503'));
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => {});
    expect(result.current).toEqual([change()]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toBe(
      '[workspace] could not read agent self-changes',
    );
  });

  it('never throws when the read method is missing', async () => {
    const api = workspaceApi as unknown as { selfChanges?: unknown };
    api.selfChanges = undefined;
    try {
      const { result } = renderHook(() => useSelfChanges(true));
      await act(async () => {});
      expect(result.current).toEqual([]);
      expect(console.warn).toHaveBeenCalledTimes(1);
    } finally {
      api.selfChanges = selfChangesMock;
    }
  });
});

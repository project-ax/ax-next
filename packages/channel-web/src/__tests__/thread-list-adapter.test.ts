import { describe, it, expect, beforeEach, vi } from 'vitest';
import { axThreadListAdapter } from '../lib/thread-list-adapter';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('axThreadListAdapter', () => {
  it('lists threads from /api/chat/sessions', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessions: [{ id: 's-1', title: 't1' }, { id: 's-2', title: 't2' }] }),
    });
    const result = await axThreadListAdapter.list!();
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions');
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0]).toMatchObject({ status: 'regular', remoteId: 's-1', title: 't1' });
  });

  it('initialize is a pass-through', async () => {
    const r = await axThreadListAdapter.initialize!('thread-x');
    expect(r).toMatchObject({ remoteId: 'thread-x' });
  });

  it('handles 5xx as empty list', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await axThreadListAdapter.list!();
    expect(result.threads).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { axThreadListAdapter } from '../lib/thread-list-adapter';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('axThreadListAdapter', () => {
  it('lists threads from /api/chat/conversations and uses conversationId as remoteId', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          conversationId: 'c-1', userId: 'u', agentId: 'a', title: 't1',
          activeSessionId: null, activeReqId: null,
          createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z',
        },
        {
          conversationId: 'c-2', userId: 'u', agentId: 'a', title: 't2',
          activeSessionId: null, activeReqId: null,
          createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z',
        },
      ],
    });
    const result = await axThreadListAdapter.list!();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0]).toMatchObject({ status: 'regular', remoteId: 'c-1', title: 't1' });
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

  it('handles non-array response shape as empty list', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'unexpected' }),
    });
    const result = await axThreadListAdapter.list!();
    expect(result.threads).toHaveLength(0);
  });
});

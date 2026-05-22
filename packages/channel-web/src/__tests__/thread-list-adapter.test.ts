import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  axThreadListAdapter,
  pollConversationTitle,
} from '../lib/thread-list-adapter';

function rowsResponse(rows: unknown) {
  return { ok: true, json: async () => rows };
}

function convRow(conversationId: string, title: string | null) {
  return {
    conversationId,
    userId: 'u',
    agentId: 'a',
    title,
    activeSessionId: null,
    activeReqId: null,
    createdAt: '2026-05-21T00:00:00Z',
    updatedAt: '2026-05-21T00:00:00Z',
  };
}

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

describe('pollConversationTitle', () => {
  it('returns the title once it appears on a later poll', async () => {
    // Regression: the title-LLM round-trip can outlast the first poll. The
    // poll must keep trying (not settle on "New Chat" after one miss) and
    // surface the title the moment it lands.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rowsResponse([convRow('c-1', null)]))
      .mockResolvedValueOnce(rowsResponse([convRow('c-1', 'Real Title')]));
    const title = await pollConversationTitle('c-1', {
      attempts: 5,
      intervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(title).toBe('Real Title');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting attempts when the title never lands', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(rowsResponse([convRow('c-1', null)]));
    const title = await pollConversationTitle('c-1', {
      attempts: 3,
      intervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(title).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps polling through transient fetch failures', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(rowsResponse([convRow('c-1', 'Eventually')]));
    const title = await pollConversationTitle('c-1', {
      attempts: 5,
      intervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(title).toBe('Eventually');
  });

  it('does not hang on a never-resolving fetch — times out the attempt and returns null', async () => {
    // A browser fetch has no default timeout; without the per-attempt bound a
    // single stuck request would stall the whole poll forever. The dummy
    // fetch ignores the abort signal, so the timeout race (not the abort) is
    // what must win.
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const title = await pollConversationTitle('c-1', {
      attempts: 2,
      intervalMs: 0,
      perAttemptTimeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(title).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

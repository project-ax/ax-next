import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAxHistoryAdapter } from '../lib/history-adapter';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('createAxHistoryAdapter', () => {
  it('load returns empty when no remoteId', async () => {
    const adapter = createAxHistoryAdapter(() => undefined);
    const result = await adapter.load();
    expect(result.messages).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withFormat.load fetches /api/chat/sessions/:id/history and converts text content', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ role: 'user', content: 'hello', created_at: 1 }, { role: 'assistant', content: 'hi back', created_at: 2 }] }),
    });
    const adapter = createAxHistoryAdapter(() => 'sess-1');
    const formatAdapter = {
      format: 'aui-v1' as any,
      decode: (entry: any) => entry,
      encode: () => ({}) as any,
    };
    const result = await adapter.withFormat!(formatAdapter as any).load();
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/sess-1/history');
    expect(result.messages).toHaveLength(2);
  });

  it('withFormat.load returns empty on 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const adapter = createAxHistoryAdapter(() => 'sess-x');
    const formatAdapter = {
      format: 'aui-v1' as any,
      decode: (entry: any) => entry,
      encode: () => ({}) as any,
    };
    const result = await adapter.withFormat!(formatAdapter as any).load();
    expect(result.messages).toHaveLength(0);
  });

  it('withFormat.load throws on non-404 errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const adapter = createAxHistoryAdapter(() => 'sess-x');
    const formatAdapter = {
      format: 'aui-v1' as any,
      decode: (entry: any) => entry,
      encode: () => ({}) as any,
    };
    await expect(adapter.withFormat!(formatAdapter as any).load()).rejects.toThrow();
  });
});

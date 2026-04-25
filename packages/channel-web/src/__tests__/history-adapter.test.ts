import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageFormatAdapter, MessageFormatItem, MessageStorageEntry } from '@assistant-ui/react';
import { createAxHistoryAdapter } from '../lib/history-adapter';

type StorageFormat = Record<string, unknown>;
type TestMessage = MessageStorageEntry<StorageFormat>;

/** A minimal MessageFormatAdapter for tests — decode is identity. */
const makeFormatAdapter = (): MessageFormatAdapter<TestMessage, StorageFormat> => ({
  format: 'aui-v1',
  decode: (entry: MessageStorageEntry<StorageFormat>): MessageFormatItem<TestMessage> => ({
    parentId: entry.parent_id,
    message: entry,
  }),
  encode: (): StorageFormat => ({}),
  getId: (message: TestMessage): string => message.id,
});

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
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/sess-1/history');
    expect(result.messages).toHaveLength(2);
  });

  it('withFormat.load returns empty on 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const adapter = createAxHistoryAdapter(() => 'sess-x');
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    expect(result.messages).toHaveLength(0);
  });

  it('withFormat.load throws on non-404 errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const adapter = createAxHistoryAdapter(() => 'sess-x');
    await expect(adapter.withFormat!(makeFormatAdapter()).load()).rejects.toThrow();
  });
});

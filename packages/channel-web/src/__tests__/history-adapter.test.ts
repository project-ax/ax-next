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
  it('load returns empty when no conversationId', async () => {
    const adapter = createAxHistoryAdapter(() => undefined);
    const result = await adapter.load();
    expect(result.messages).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withFormat.load fetches /api/chat/conversations/:id and decodes turns', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'conv-1', title: 't' },
        turns: [
          { turnId: 't0', turnIndex: 0, role: 'user', contentBlocks: [{ type: 'text', text: 'hello' }], createdAt: '2026-04-01T00:00:00Z' },
          { turnId: 't1', turnIndex: 1, role: 'assistant', contentBlocks: [{ type: 'text', text: 'hi back' }], createdAt: '2026-04-01T00:00:01Z' },
        ],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1');
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/conv-1',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(result.messages).toHaveLength(2);
  });

  it('withFormat.load passes ?includeThinking=true when option enabled', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'conv-1', title: null },
        turns: [],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1', { includeThinking: true });
    await adapter.withFormat!(makeFormatAdapter()).load();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/conv-1?includeThinking=true',
      expect.objectContaining({ credentials: 'include' }),
    );
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

  it('thinking blocks are tagged with providerMetadata so the renderer can hide them', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'conv-1', title: null },
        turns: [
          {
            turnId: 't0',
            turnIndex: 0,
            role: 'assistant',
            contentBlocks: [
              { type: 'thinking', thinking: 'reasoning step' },
              { type: 'text', text: 'final answer' },
            ],
            createdAt: '2026-04-01T00:00:00Z',
          },
        ],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1', { includeThinking: true });
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    const decoded = result.messages[0]!.message;
    const parts = (decoded.content as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: 'reasoning step',
      providerMetadata: { ax: { thinking: true } },
    });
    expect(parts[1]).toMatchObject({ type: 'text', text: 'final answer' });
    expect(parts[1]?.['providerMetadata']).toBeUndefined();
  });

  it('image block (base64) decodes to a data: URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'conv-1', title: null },
        turns: [
          {
            turnId: 't0',
            turnIndex: 0,
            role: 'user',
            contentBlocks: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
              },
            ],
            createdAt: '2026-04-01T00:00:00Z',
          },
        ],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1');
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    const decoded = result.messages[0]!.message;
    const parts = (decoded.content as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts[0]).toMatchObject({
      type: 'image',
      image: 'data:image/png;base64,AAAA',
    });
  });

  it('an empty contentBlocks array still produces a single empty text part', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'conv-1', title: null },
        turns: [
          { turnId: 't0', turnIndex: 0, role: 'assistant', contentBlocks: [], createdAt: '2026-04-01T00:00:00Z' },
        ],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1');
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    const parts = (result.messages[0]!.message.content as { parts: unknown[] }).parts;
    expect(parts).toHaveLength(1);
  });
});

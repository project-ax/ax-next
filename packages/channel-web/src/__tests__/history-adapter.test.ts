import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageFormatAdapter, MessageFormatItem, MessageStorageEntry } from '@assistant-ui/react';
import { contentBlocksToAuiParts, createAxHistoryAdapter, decodeAttachmentPath } from '../lib/history-adapter';

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

  it('tool_use + tool_result across turns merges into a single output-available tool part', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'conv-1', title: null },
        turns: [
          {
            turnId: 't0',
            turnIndex: 0,
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'run echo' }],
            createdAt: '2026-04-01T00:00:00Z',
          },
          {
            turnId: 't1',
            turnIndex: 1,
            role: 'assistant',
            contentBlocks: [
              { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'echo hi' } },
            ],
            createdAt: '2026-04-01T00:00:01Z',
          },
          {
            turnId: 't2',
            turnIndex: 2,
            role: 'tool',
            contentBlocks: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: 'hi' },
            ],
            createdAt: '2026-04-01T00:00:02Z',
          },
          {
            turnId: 't3',
            turnIndex: 3,
            role: 'assistant',
            contentBlocks: [{ type: 'text', text: 'done' }],
            createdAt: '2026-04-01T00:00:03Z',
          },
        ],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1');
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    // The tool-role turn (t2) is dropped — its contents are merged.
    expect(result.messages).toHaveLength(3);
    const toolTurn = result.messages[1]!.message;
    const parts = (toolTurn.content as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'Bash',
      toolCallId: 'tu_1',
      state: 'output-available',
      input: { cmd: 'echo hi' },
      output: 'hi',
    });
  });

  it('a tool_use without a matching tool_result is emitted as input-available', async () => {
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
              { type: 'tool_use', id: 'tu_orphan', name: 'Bash', input: {} },
            ],
            createdAt: '2026-04-01T00:00:00Z',
          },
        ],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1');
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    const parts = (result.messages[0]!.message.content as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'Bash',
      toolCallId: 'tu_orphan',
      state: 'input-available',
    });
    expect(parts[0]?.['output']).toBeUndefined();
  });

  it('a tool_result with is_error: true becomes an output-error part', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'conv-1', title: null },
        turns: [
          {
            turnId: 't0',
            turnIndex: 0,
            role: 'assistant',
            contentBlocks: [{ type: 'tool_use', id: 'tu_x', name: 'Bash', input: {} }],
            createdAt: '2026-04-01T00:00:00Z',
          },
          {
            turnId: 't1',
            turnIndex: 1,
            role: 'tool',
            contentBlocks: [
              { type: 'tool_result', tool_use_id: 'tu_x', content: 'oops', is_error: true },
            ],
            createdAt: '2026-04-01T00:00:01Z',
          },
        ],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'conv-1');
    const result = await adapter.withFormat!(makeFormatAdapter()).load();
    expect(result.messages).toHaveLength(1);
    const parts = (result.messages[0]!.message.content as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'Bash',
      toolCallId: 'tu_x',
      state: 'output-error',
      errorText: 'oops',
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

describe('contentBlocksToAuiParts — attachment blocks', () => {
  it('translates an image attachment block to a file part with image type', () => {
    const blocks = [{
      type: 'attachment' as const,
      path: '.ax/uploads/c1/t1/abcd1234__cat.png',
      displayName: 'cat.png',
      mediaType: 'image/png',
      sizeBytes: 1234,
    }];
    const parts = contentBlocksToAuiParts(blocks, { conversationId: 'c1' });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      filename: 'cat.png',
    });
    const data = (parts[0] as { data: string }).data;
    expect(data.startsWith('ax://attachment-path/')).toBe(true);
  });

  it('translates a PDF attachment block to a file part with pdf type', () => {
    const blocks = [{
      type: 'attachment' as const,
      path: '.ax/uploads/c1/t1/abcd1234__report.pdf',
      displayName: 'Q4 Report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 482113,
    }];
    const parts = contentBlocksToAuiParts(blocks, { conversationId: 'c1' });
    expect(parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'application/pdf',
      filename: 'Q4 Report.pdf',
    });
  });

  it('preserves text + attachment ordering', () => {
    const blocks = [
      { type: 'text' as const, text: 'see attached' },
      {
        type: 'attachment' as const,
        path: '.ax/uploads/c1/t1/x.pdf',
        displayName: 'x.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 10,
      },
    ];
    const parts = contentBlocksToAuiParts(blocks, { conversationId: 'c1' });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect(parts[1]).toMatchObject({ type: 'file' });
  });
});

describe('decodeAttachmentPath', () => {
  it('decodes a base64url-encoded path', () => {
    const path = '.ax/uploads/c1/t1/foo.pdf';
    const encoded = btoa(path).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `ax://attachment-path/${encoded}`;
    expect(decodeAttachmentPath(url)).toBe(path);
  });

  it('returns null for non-ax URLs', () => {
    expect(decodeAttachmentPath('https://example.com')).toBe(null);
  });

  it('round-trips a Unicode filename through the attachment-path URL', async () => {
    // Drive the encode side via the public attachment-translation path so
    // the encoder and decoder stay locked together — `btoa(path)` directly
    // would throw on code points > 0xFF, which is the bug we're guarding
    // against.
    const path = '.ax/uploads/c1/t1/カタログ.pdf';
    const blocks = [{
      type: 'attachment' as const,
      path,
      displayName: 'カタログ.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 1234,
    }];
    const parts = contentBlocksToAuiParts(blocks);
    const url = (parts[0] as { data: string }).data;
    expect(decodeAttachmentPath(url)).toBe(path);
  });
});

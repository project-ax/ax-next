/**
 * TASK-353 — `workspaceApi.sendMessage` threads server-minted attachment ids
 * into the POST body as `attachment_ref` content blocks.
 *
 * Drives the REAL `workspaceApi.sendMessage` (no mocking of `workspace-api`
 * itself) against a stubbed global `fetch`, and asserts on the parsed request
 * BODY's `contentBlocks` array — not merely that a POST happened. That is the
 * only way to catch a block silently dropped, mis-ordered, or mis-spelled.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspaceApi } from '../lib/workspace-api';
import { HttpError } from '../lib/http';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

function mockJson(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('workspaceApi.sendMessage — attachment threading', () => {
  it('with two attachmentIds, posts one attachment_ref block per id, in order, after the text block', async () => {
    mockJson(200, { reqId: 'req-1', conversationId: 'cnv-1' });
    await workspaceApi.sendMessage({
      agentId: 'agt_a',
      conversationId: null,
      text: 'here you go',
      attachmentIds: ['att-1', 'att-2'],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chat/messages');
    const body = JSON.parse(init.body as string) as { contentBlocks: unknown[] };
    expect(body.contentBlocks).toEqual([
      { type: 'text', text: 'here you go' },
      { type: 'attachment_ref', attachmentId: 'att-1' },
      { type: 'attachment_ref', attachmentId: 'att-2' },
    ]);
  });

  it('with no attachmentIds, posts a text-only contentBlocks array, byte-identical to before', async () => {
    mockJson(200, { reqId: 'req-2', conversationId: 'cnv-2' });
    await workspaceApi.sendMessage({
      agentId: 'agt_a',
      conversationId: null,
      text: 'hi',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { contentBlocks: unknown[] };
    expect(body.contentBlocks).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('POSTs to /api/chat/messages with method POST and the x-requested-with header', async () => {
    mockJson(200, { reqId: 'req-3', conversationId: 'cnv-3' });
    await workspaceApi.sendMessage({
      agentId: 'agt_a',
      conversationId: null,
      text: 'hi',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chat/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe(
      'ax-admin',
    );
  });

  it('throws HttpError when the response is not ok', async () => {
    mockJson(500, { error: 'boom' });
    await expect(
      workspaceApi.sendMessage({
        agentId: 'agt_a',
        conversationId: null,
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

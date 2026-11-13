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
import { StorageFullError } from '../lib/storage-full';
import { STORAGE_FULL_SEND } from '../lib/storage-copy';
import {
  CONVERSATION_READ_ONLY,
  ConversationReadOnlyError,
} from '../lib/conversation-read-only';
import { HTTP_NOT_FOUND } from '../lib/http';

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

/*
  TASK-690 — the send route can now answer 413 `{ error: 'storage-full',
  message }` when committing an attachment would put the person over their
  storage limit. `sendMessage` used to flatten every refusal to a bare
  `HttpError` (status only), so this arrived as "we could not reach the server".
  It must arrive as an error that carries the kind sentence, and ONLY this one
  refusal may: the other 413 stays what it was.
*/
describe('workspaceApi.sendMessage — storage-full refusal', () => {
  const send = () =>
    workspaceApi.sendMessage({
      agentId: 'agt_a',
      conversationId: null,
      text: 'have a look',
      attachmentIds: ['att-1'],
    });

  it("rejects with a StorageFullError wearing the server's sentence", async () => {
    mockJson(413, {
      error: 'storage-full',
      message: 'Your storage is full, so that file could not be saved.',
    });
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as StorageFullError).sentence).toBe(
      'Your storage is full, so that file could not be saved.',
    );
    // Still an HttpError: the 401 latch and `toReadOutcome` see what they saw.
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });

  it('uses our own sentence when the server sent none', async () => {
    mockJson(413, { error: 'storage-full' });
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as StorageFullError).sentence).toBe(STORAGE_FULL_SEND);
  });

  it('leaves the other 413 (too many bytes in one message) a plain HttpError', async () => {
    mockJson(413, { error: 'attachment-total-too-large' });
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(StorageFullError);
  });

  it('is not fooled by a 413 whose body it cannot read', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 413,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(StorageFullError);
  });
});

/*
  TASK-1093 — a conversation whose turns come from somewhere else (a Slack DM
  thread, a routine's runs) answers a send with `409 conversation-read-only`.
  As a bare status that read as "We could not reach the server just now", and
  its 404 predecessor as "We could not find that. It may have been deleted."
  Neither is true: the conversation is right there. The refusal carries our
  own sentence instead.
*/
describe('workspaceApi.sendMessage — conversation-read-only refusal', () => {
  const send = () =>
    workspaceApi.sendMessage({
      agentId: 'agt_a',
      conversationId: 'cnv-slack',
      text: 'answering from the browser',
    });

  it('rejects with a ConversationReadOnlyError wearing our sentence, never "deleted"', async () => {
    mockJson(409, { error: 'conversation-read-only' });
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConversationReadOnlyError);
    expect((err as ConversationReadOnlyError).sentence).toBe(CONVERSATION_READ_ONLY);
    expect((err as Error).message).toBe(CONVERSATION_READ_ONLY);
    expect((err as Error).message).not.toBe(HTTP_NOT_FOUND);
    expect(CONVERSATION_READ_ONLY).not.toMatch(/deleted|AX/);
    // Still an HttpError: the 401 latch and `toReadOutcome` see what they saw.
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
  });

  it('leaves any other 409, and a 409 it cannot read, a plain HttpError', async () => {
    mockJson(409, { error: 'something-else' });
    const other = await send().catch((e: unknown) => e);
    expect(other).toBeInstanceOf(HttpError);
    expect(other).not.toBeInstanceOf(ConversationReadOnlyError);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);
    const unreadable = await send().catch((e: unknown) => e);
    expect(unreadable).toBeInstanceOf(HttpError);
    expect(unreadable).not.toBeInstanceOf(ConversationReadOnlyError);
  });

  it('is not fooled by the code on another status', async () => {
    mockJson(404, { error: 'conversation-read-only' });
    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(ConversationReadOnlyError);
  });
});

/**
 * `workspaceApi.saveRules` and the one refusal a person can act on (TASK-719).
 *
 * The route answers 413 `{ error: 'storage-full', message }` when the storage
 * limit turns a Save away. `req()` used to flatten every non-ok status into a
 * `WorkspaceApiError(path, status)` without reading the body, so a full disk
 * arrived as a bare status and the editor said "The server ran into a problem.
 * Please try again." Trying again cannot work until an admin makes room.
 *
 * Drives the REAL `saveRules` against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspaceApi, WorkspaceApiError } from '../workspace-api';
import { HttpError } from '../http';
import { StorageFullError } from '../storage-full';
import { STORAGE_FULL_RULES } from '../storage-copy';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

function reply(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

const save = () => workspaceApi.saveRules('a1', '- Always cc Priya');

describe('workspaceApi.saveRules', () => {
  it('resolves with what the server stored on a 200', async () => {
    reply(200, { saved: true, body: '- Always cc Priya\n' });
    await expect(save()).resolves.toEqual({ saved: true, body: '- Always cc Priya\n' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/agents/a1/memory/rules');
    expect(init.method).toBe('PUT');
  });

  it("rejects with a StorageFullError wearing the server's sentence on a 413 storage-full", async () => {
    reply(413, {
      error: 'storage-full',
      message: "We couldn't save your rules because your storage is full. Ask an admin.",
    });
    const err = await save().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as StorageFullError).sentence).toBe(
      "We couldn't save your rules because your storage is full. Ask an admin.",
    );
    // Still an HttpError: the 401 latch and every `instanceof HttpError` branch hold.
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });

  it('says the RULES sentence, not the message one, when the server sent none', async () => {
    reply(413, { error: 'storage-full' });
    const err = await save().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as StorageFullError).sentence).toBe(STORAGE_FULL_RULES);
  });

  it('leaves every other refusal the WorkspaceApiError it always was', async () => {
    for (const [status, body] of [
      [500, { error: 'internal' }],
      [503, { error: 'memory-unavailable' }],
      [400, { error: 'invalid-body' }],
      // The other 413 (and one we cannot read) is not this refusal.
      [413, { error: 'body-too-large' }],
      [413, '<html>too large</html>'],
    ] as const) {
      reply(status, body);
      const err = await save().catch((e: unknown) => e);
      expect(err, `${status} ${JSON.stringify(body)}`).toBeInstanceOf(WorkspaceApiError);
      expect(err).not.toBeInstanceOf(StorageFullError);
      expect((err as WorkspaceApiError).status).toBe(status);
    }
  });
});

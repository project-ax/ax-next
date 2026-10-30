/**
 * `workspaceApi.saveRules` and the refusals a person can act on (TASK-989).
 *
 * The Instructions are an `@ax/agents` row, scanned before they are saved. The
 * route answers 422 `content-refused` when the scan turns a Save away, and 400
 * `invalid-body` (with the store's own sentence as `detail`) when the text is
 * over the cap. `req()` flattens every non-ok status into a
 * `WorkspaceApiError(path, status)`, whose copy for a 422 would be "We could
 * not reach the server just now" — wrong for text that was reached and
 * refused. So `saveRules` words those two itself.
 *
 * Drives the REAL `saveRules` against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspaceApi, WorkspaceApiError, INSTRUCTIONS_REFUSED } from '../workspace-api';
import { HttpError } from '../http';

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

  it('a 422 rejects with the fixed refusal sentence', async () => {
    reply(422, { error: 'content-refused' });
    const err = await save().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toBe(INSTRUCTIONS_REFUSED);
  });

  it('the refusal sentence is the agreed copy', () => {
    expect(INSTRUCTIONS_REFUSED).toBe(
      'Part of this looks like something we block — like telling the agent to ignore its rules, sending passwords or keys somewhere, or hidden characters. Reword that part and try again.',
    );
  });

  it('a too-long 400 rejects with the store’s own sentence', async () => {
    reply(400, {
      error: 'invalid-body',
      detail: 'Instructions must be 16,384 characters or fewer.',
    });
    const err = await save().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe('Instructions must be 16,384 characters or fewer.');
  });

  it('leaves every other refusal the WorkspaceApiError it always was', async () => {
    for (const [status, body] of [
      [500, { error: 'internal' }],
      [503, { error: 'instructions-unavailable' }],
      [409, { error: 'conflict' }],
      // A 400 with no sentence to show is not this refusal.
      [400, { error: 'invalid-body' }],
      [400, { error: 'invalid-json' }],
      // A body we cannot read.
      [400, '<html>nope</html>'],
    ] as const) {
      reply(status, body);
      const err = await save().catch((e: unknown) => e);
      expect(err, `${status} ${JSON.stringify(body)}`).toBeInstanceOf(WorkspaceApiError);
      expect((err as WorkspaceApiError).status).toBe(status);
    }
  });
});

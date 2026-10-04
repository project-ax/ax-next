/**
 * TASK-791 — the rename and delete a create flow uses once its agent exists.
 *
 * Both must hit the ordinary agent routes (so the server's ownership check and
 * the `agents:deleted` cleanup run), with the CSRF header, for exactly the id
 * they were given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discardCreatedAgent, renameCreatedAgent } from '../auto-create-agent';
import { HttpError } from '../http';

function stubFetch(status: number) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('renameCreatedAgent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('PATCHes only the display name of the given agent', async () => {
    const fn = stubFetch(200);
    await renameCreatedAgent('a/1', 'Quill');
    expect(fn).toHaveBeenCalledTimes(1);
    const [path, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/admin/agents/a%2F1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ displayName: 'Quill' });
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
  });

  it('throws on a non-ok answer', async () => {
    stubFetch(403);
    await expect(renameCreatedAgent('a1', 'Quill')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('discardCreatedAgent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('DELETEs the given agent through the ordinary agent route', async () => {
    const fn = stubFetch(204);
    await discardCreatedAgent('a1');
    const [path, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/admin/agents/a1');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
  });

  it('treats 404 as done — the agent is already gone', async () => {
    stubFetch(404);
    await expect(discardCreatedAgent('a1')).resolves.toBeUndefined();
  });

  it('throws on any other failure, so Cancel does not pretend it worked', async () => {
    stubFetch(500);
    await expect(discardCreatedAgent('a1')).rejects.toBeInstanceOf(HttpError);
  });
});

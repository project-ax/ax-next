/**
 * TASK-688 — `workspaceApi.interruptTurn`, the SPA half of "Stop cancels the
 * in-flight turn".
 *
 * Drives the REAL function against a stubbed global `fetch` (the same seam
 * `workspace-send-attachments.test.ts` uses) and asserts on the request that
 * actually leaves the browser: the URL, the verb, and the CSRF header the
 * host's guard demands. Against the code before this change every test here
 * fails the same way — `interruptTurn` is not a function.
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

describe('workspaceApi.interruptTurn', () => {
  it('POSTs to the conversation interrupt route with the x-requested-with header and no body', async () => {
    mockJson(200, { interrupted: true });
    await workspaceApi.interruptTurn('cnv-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chat/conversations/cnv-1/interrupt');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe(
      'ax-admin',
    );
    // The route takes no body — the conversation in the path is the whole ask.
    expect(init.body).toBeUndefined();
  });

  it('encodes the conversation id into the path', async () => {
    mockJson(200, { interrupted: false });
    await workspaceApi.interruptTurn('a/b c?d');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/chat/conversations/a%2Fb%20c%3Fd/interrupt');
  });

  it('resolves { interrupted: true } when something was running', async () => {
    mockJson(200, { interrupted: true });
    await expect(workspaceApi.interruptTurn('cnv-1')).resolves.toEqual({
      interrupted: true,
    });
  });

  it('resolves { interrupted: false } when nothing was running', async () => {
    mockJson(200, { interrupted: false });
    await expect(workspaceApi.interruptTurn('cnv-1')).resolves.toEqual({
      interrupted: false,
    });
  });

  it('throws an HttpError carrying the status on a 404 (unknown or foreign conversation)', async () => {
    mockJson(404, { error: 'conversation-not-found' });
    const err = await workspaceApi.interruptTurn('cnv-x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });

  it('throws an HttpError on a 401', async () => {
    mockJson(401, { error: 'unauthenticated' });
    const err = await workspaceApi.interruptTurn('cnv-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });

  it('refuses a 200 whose body is not { interrupted: boolean } rather than guessing "stopped"', async () => {
    // A wrong-shaped 200 (a proxy's HTML, an older host) must not be read as
    // "the turn was stopped": the SPA would then tell the person it stopped
    // something that is still running.
    mockJson(200, { ok: true });
    await expect(workspaceApi.interruptTurn('cnv-1')).rejects.toBeInstanceOf(
      Error,
    );
  });
});

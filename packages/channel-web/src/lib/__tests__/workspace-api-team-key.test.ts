/**
 * TASK-813 — `workspaceApi.setTeamKey`: a team admin's key for a team agent.
 *
 * PUTs `{ slot, payloadB64 }` to the agent's team-key route and nowhere else,
 * names the two refusals a person can understand, and never lets the key
 * ride along on an error.
 *
 * Drives the REAL client against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  workspaceApi,
  TEAM_KEY_FORBIDDEN,
  TEAM_KEY_UNAVAILABLE,
} from '../workspace-api';
import { HttpError } from '../http';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

const SECRET = 'lin_api_SECRET123';

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('workspaceApi.setTeamKey', () => {
  it('PUTs the slot and the base64 key to the agent’s team-key route', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ saved: true }), { status: 200 }));
    await workspaceApi.setTeamKey('a/1', 'linear', 'api_key', SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/agents/a%2F1/connectors/linear/team-key');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse(init.body as string)).toEqual({ slot: 'api_key', payloadB64: btoa(SECRET) });
  });

  it('names a 403 and a 409 in words a person can act on', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    const forbidden = await failure(workspaceApi.setTeamKey('a1', 'linear', 'api_key', SECRET));
    expect(forbidden).toBeInstanceOf(HttpError);
    expect((forbidden as HttpError).status).toBe(403);
    expect((forbidden as Error).message).toBe(TEAM_KEY_FORBIDDEN);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'team-key-unavailable' }), { status: 409 }),
    );
    const unavailable = await failure(workspaceApi.setTeamKey('a1', 'linear', 'api_key', SECRET));
    expect((unavailable as Error).message).toBe(TEAM_KEY_UNAVAILABLE);
  });

  it('a transport failure never carries the key, and nothing logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError(`failed to send ${SECRET} ${btoa(SECRET)}`));
    const e = await failure(workspaceApi.setTeamKey('a1', 'linear', 'api_key', SECRET));
    expect(e).toBeInstanceOf(HttpError);
    const seen = JSON.stringify({
      message: (e as Error).message,
      detail: (e as HttpError).detail,
      cause: (e as { cause?: unknown }).cause ?? null,
      stack: (e as Error).stack ?? '',
    });
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain(btoa(SECRET));

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 502 }));
    await failure(workspaceApi.setTeamKey('a1', 'linear', 'api_key', SECRET));
    for (const spy of [warn, log, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(btoa(SECRET));
    }
  });
});

describe('workspaceApi.getTeamKeys (TASK-854)', () => {
  it('GETs the team-key route and answers slot + saved only', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          slots: [
            { slot: 'ACME_KEY', saved: true, value: 'leak', ref: 'r' },
            { slot: 'ACME_SECRET', saved: false },
          ],
        }),
        { status: 200 },
      ),
    );
    const slots = await workspaceApi.getTeamKeys('a/1', 'acme');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/workspace/agents/a%2F1/connectors/acme/team-key');
    expect(init?.method ?? 'GET').toBe('GET');
    // Only the two fields we asked for, even if the body carried more.
    expect(slots).toEqual([
      { slot: 'ACME_KEY', saved: true },
      { slot: 'ACME_SECRET', saved: false },
    ]);
  });

  it('a refusal is an HttpError with the team-key sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    const e = await failure(workspaceApi.getTeamKeys('a1', 'acme'));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as Error).message).toBe(TEAM_KEY_FORBIDDEN);
  });

  it('a malformed body is a failure, not an empty list', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    await expect(workspaceApi.getTeamKeys('a1', 'acme')).rejects.toBeInstanceOf(Error);
  });
});

describe('workspaceApi.removeTeamKey (TASK-854)', () => {
  it('DELETEs exactly { slot } on the team-key route', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ removed: true }), { status: 200 }));
    await workspaceApi.removeTeamKey('a/1', 'acme', 'ACME_KEY');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/agents/a%2F1/connectors/acme/team-key');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse(init.body as string)).toEqual({ slot: 'ACME_KEY' });
  });

  it('names a 403 and a 409; a 502 keeps its status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    const forbidden = await failure(workspaceApi.removeTeamKey('a1', 'acme', 'ACME_KEY'));
    expect((forbidden as Error).message).toBe(TEAM_KEY_FORBIDDEN);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'team-key-unavailable' }), { status: 409 }),
    );
    const unavailable = await failure(workspaceApi.removeTeamKey('a1', 'acme', 'ACME_KEY'));
    expect((unavailable as Error).message).toBe(TEAM_KEY_UNAVAILABLE);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'team-key-not-removed' }), { status: 502 }),
    );
    const e = await failure(workspaceApi.removeTeamKey('a1', 'acme', 'ACME_KEY'));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(502);
  });

  it('a transport failure becomes a bare HttpError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('boom'));
    const e = await failure(workspaceApi.removeTeamKey('a1', 'acme', 'ACME_KEY'));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(0);
  });
});

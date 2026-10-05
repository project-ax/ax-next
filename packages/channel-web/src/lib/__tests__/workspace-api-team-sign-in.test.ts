/**
 * TASK-858 — `workspaceApi.removeTeamSignIn`: a team admin removes the
 * sign-in saved ON a team agent (the one everyone using it acts as).
 *
 * DELETEs the agent's team-sign-in route with no body, and names the
 * refusals a person can act on. Drives the REAL client against a stubbed
 * global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  workspaceApi,
  TEAM_SIGN_IN_FORBIDDEN,
  TEAM_SIGN_IN_UNAVAILABLE,
  TEAM_SIGN_IN_NOT_REMOVED,
  TEAM_SIGN_IN_OFFLINE,
} from '../workspace-api';
import { HttpError } from '../http';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function answer(status: number, error?: string): Response {
  return new Response(JSON.stringify(error === undefined ? { removed: true } : { error }), {
    status,
  });
}

describe('workspaceApi.removeTeamSignIn (TASK-858)', () => {
  it('DELETEs the agent’s team-sign-in route, with no body', async () => {
    fetchMock.mockResolvedValueOnce(answer(200));
    await workspaceApi.removeTeamSignIn('a/1', 'lin ear');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/agents/a%2F1/connectors/lin%20ear/team-sign-in');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(init.body).toBeUndefined();
  });

  it.each([
    [403, 'forbidden', TEAM_SIGN_IN_FORBIDDEN],
    [409, 'not-a-team-agent', TEAM_SIGN_IN_UNAVAILABLE],
    [409, 'team-sign-in-unavailable', TEAM_SIGN_IN_UNAVAILABLE],
    [502, 'team-sign-in-not-removed', TEAM_SIGN_IN_NOT_REMOVED],
    [503, 'connectors-unavailable', TEAM_SIGN_IN_OFFLINE],
    [503, 'team-key-check-failed', TEAM_SIGN_IN_OFFLINE],
  ])('a %i (%s) is an HttpError with a sentence a person can act on', async (status, code, text) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(answer(status, code));
    const e = await failure(workspaceApi.removeTeamSignIn('a1', 'linear'));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    expect((e as Error).message).toBe(text);
  });

  it('a 404 keeps the generic copy and never renders the body', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(answer(404, '<b>connector-not-found</b>'));
    const e = await failure(workspaceApi.removeTeamSignIn('a1', 'linear'));
    expect((e as HttpError).status).toBe(404);
    expect((e as Error).message).not.toContain('connector-not-found');
  });

  it('a transport failure becomes a bare HttpError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('boom'));
    const e = await failure(workspaceApi.removeTeamSignIn('a1', 'linear'));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(0);
  });
});

/**
 * TASK-813 / slice 3 — `workspaceApi.setAgentKey`: the rail's Add key, an
 * agent's own key (a team agent's team admin, or a personal agent's owner).
 *
 * PUTs `{ slot, payloadB64 }` to the agent's key route and nowhere else,
 * names the refusals a person can understand, and never lets the key ride
 * along on an error.
 *
 * Drives the REAL client against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  workspaceApi,
  AGENT_KEY_FORBIDDEN,
  AGENT_KEY_UNAVAILABLE,
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

describe('workspaceApi.setAgentKey', () => {
  it('PUTs the slot and the base64 key to the agent’s key route', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ saved: true }), { status: 200 }));
    await workspaceApi.setAgentKey('a/1', 'linear', 'api_key', SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/agents/a%2F1/connectors/linear/key');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse(init.body as string)).toEqual({ slot: 'api_key', payloadB64: btoa(SECRET) });
  });

  it('names a 403 and a 409 in words a person can act on', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    const forbidden = await failure(workspaceApi.setAgentKey('a1', 'linear', 'api_key', SECRET));
    expect(forbidden).toBeInstanceOf(HttpError);
    expect((forbidden as HttpError).status).toBe(403);
    expect((forbidden as Error).message).toBe(AGENT_KEY_FORBIDDEN);
    // Personal agent = its owner; team agent = a team admin. Both "manage" it.
    expect(AGENT_KEY_FORBIDDEN).toBe('Only someone who manages this agent can add its key.');

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'agent-key-unavailable' }), { status: 409 }),
    );
    const unavailable = await failure(workspaceApi.setAgentKey('a1', 'linear', 'api_key', SECRET));
    expect((unavailable as Error).message).toBe(AGENT_KEY_UNAVAILABLE);
    // The server answers one 409 for the cases a person can't tell apart (it
    // spends the workspace's key, or it left the agent), so the sentence
    // covers both, honestly. Every connector is shared now (slice 7): no
    // "Shared" toggle to point at.
    expect(AGENT_KEY_UNAVAILABLE).toBe(
      'This agent can’t have its own key for this connector. It may use your workspace’s key, or it may no longer be on this agent. Ask a workspace admin.',
    );
  });

  it('a transport failure never carries the key, and nothing logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError(`failed to send ${SECRET} ${btoa(SECRET)}`));
    const e = await failure(workspaceApi.setAgentKey('a1', 'linear', 'api_key', SECRET));
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
    await failure(workspaceApi.setAgentKey('a1', 'linear', 'api_key', SECRET));
    for (const spy of [warn, log, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(btoa(SECRET));
    }
  });
});

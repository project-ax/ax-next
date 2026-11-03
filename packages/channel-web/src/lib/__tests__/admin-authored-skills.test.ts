/**
 * TASK-1028 — the authored-skills admin calls (list, promote, delete) on a
 * failed response.
 *
 * Promote used to show a bare "internal" when the host faulted: it rendered
 * the server's `{ error }` whatever the status. A 5xx now reads as a sentence
 * a person can act on (the shared `httpErrorMessage` copy). A 4xx still
 * carries the server's own message: that's the caller's to fix (a manifest
 * refusal, a bad grant), and the dialog shows it as is.
 *
 * Drives the REAL functions against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { deleteAuthoredSkill, listAuthoredSkills, promoteAuthoredSkill } from '../admin';
import { HTTP_SERVER_ERROR, HTTP_UNAVAILABLE, HttpError } from '../http';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

function reply(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

const calls: Array<[string, () => Promise<unknown>]> = [
  ['listAuthoredSkills', () => listAuthoredSkills('agt-1')],
  [
    'promoteAuthoredSkill',
    () =>
      promoteAuthoredSkill('agt-1', {
        skillId: 'foo',
        targetScope: 'global',
        grants: { allowedHosts: [], credentials: [], mcpServers: [] },
      }),
  ],
  ['deleteAuthoredSkill', () => deleteAuthoredSkill('agt-1', 'foo')],
];

describe.each(calls)('%s on a failed response (TASK-1028)', (_name, call) => {
  it.each([500, 502, 504])('a %i shows the server-error sentence, never the raw body', async (status) => {
    reply(status, { error: 'internal' });
    const err = await call().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toBe(HTTP_SERVER_ERROR);
    expect((err as HttpError).status).toBe(status);
  });

  it('a 500 with a non-JSON body still shows the sentence', async () => {
    reply(500, '<html>upstream exploded</html>');
    await expect(call()).rejects.toThrow(HTTP_SERVER_ERROR);
  });

  it('a 503 says the feature is unavailable', async () => {
    reply(503, { error: 'skills-plugin-not-loaded' });
    await expect(call()).rejects.toThrow(HTTP_UNAVAILABLE);
  });

  it('a 400 keeps the server message, which is the caller’s to fix', async () => {
    reply(400, { error: 'grants.allowedHosts[0] is not a valid hostname' });
    await expect(call()).rejects.toThrow('grants.allowedHosts[0] is not a valid hostname');
  });
});

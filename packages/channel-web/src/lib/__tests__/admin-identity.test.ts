/**
 * `getAgentIdentity` / `putAgentIdentity` — the admin form's two identity
 * fields, which are `@ax/agents` rows now (TASK-989).
 *
 * The route answers `{ identity, soul }` and accepts exactly that. A scan
 * refusal comes back as 400 `{ error: <a sentence for the person> }`, and the
 * thrown message carries it.
 *
 * Drives the REAL functions against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAgentIdentity, putAgentIdentity } from '../admin';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

function reply(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

const put = () => putAgentIdentity('agt-1', { identity: 'I am Ada.', soul: 'Kind.' });

describe('getAgentIdentity', () => {
  it('returns identity and soul', async () => {
    reply(200, { identity: 'I am Ada.', soul: 'Kind.' });
    await expect(getAgentIdentity('agt-1')).resolves.toEqual({
      identity: 'I am Ada.',
      soul: 'Kind.',
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/admin/agents/agt-1/identity');
  });

  it('rejects on a 503 rather than returning two blank fields', async () => {
    reply(503, { error: 'identity-unavailable' });
    await expect(getAgentIdentity('agt-1')).rejects.toThrow();
  });
});

describe('putAgentIdentity', () => {
  it('resolves on a 200 and sends exactly identity and soul', async () => {
    reply(200, { ok: true });
    await expect(put()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/admin/agents/agt-1/identity');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ identity: 'I am Ada.', soul: 'Kind.' });
  });

  it('rejects with a message containing the server’s sentence on a 400 refusal', async () => {
    reply(400, {
      error:
        'That didn’t pass the safety check, so nothing was saved: it tries to override the rules.',
    });
    const err = await put().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // The sentence is already worded for the person; no status in front of it.
    expect((err as Error).message).toBe(
      'That didn’t pass the safety check, so nothing was saved: it tries to override the rules.',
    );
  });

  it('keeps the status and code when the body has a short reason', async () => {
    reply(503, { error: 'identity-unavailable' });
    const err = await put().catch((e: unknown) => e);
    expect((err as Error).message).toBe('save agent identity: 503: identity-unavailable');
  });

  it('keeps the status alone when the body is not JSON', async () => {
    reply(502, '<html>bad gateway</html>');
    const err = await put().catch((e: unknown) => e);
    expect((err as Error).message).toBe('save agent identity: 502');
  });
});

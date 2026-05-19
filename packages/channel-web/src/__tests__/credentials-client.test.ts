/**
 * Wire-client tests for `lib/credentials.ts` — Task 4.1.
 *
 * Mirrors the shape the server contracts in `@ax/credentials-admin-routes`:
 *   - GET    /admin/credentials              → { credentials: [...] }
 *   - POST   /admin/credentials              → { credential }
 *   - GET    /admin/credentials/kinds        → { kinds: [...] }
 *   - POST   /admin/credentials/oauth/start  → { pendingId, authorizeUrl, instructions }
 *   - POST   /admin/credentials/oauth/finish → { credential }
 *   - GET    /settings/credentials           (per-user list)
 *
 * Pinned behaviors (the assertions are a contract):
 *   - All requests carry `credentials: 'include'` so cookies flow.
 *   - Writes carry `x-requested-with: ax-admin` for the http-server's
 *     CSRF guard.
 *   - `payload` is base64-encoded before POSTing — the secret material
 *     never traverses the JSON wire in the clear.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { adminCredentials, myCredentials } from '../lib/credentials';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('credentials wire client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('adminCredentials', () => {
    it('list GETs /admin/credentials with credentials: include', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse({ credentials: [] }));
      await adminCredentials.list();
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/credentials',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('list returns the credentials array (unwraps the envelope)', async () => {
      const sample = [
        {
          scope: 'global',
          ownerId: null,
          ref: 'k',
          kind: 'api-key',
          createdAt: '2026-05-07T00:00:00Z',
        },
      ];
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ credentials: sample }),
      );
      const out = await adminCredentials.list();
      expect(out).toEqual(sample);
    });

    it('create POSTs base64-encoded payload', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse({ credential: {} }, 201));
      await adminCredentials.create({
        scope: 'global',
        ownerId: null,
        ref: 'anthropic',
        kind: 'api-key',
        payload: 'sk-test',
      });
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('/admin/credentials');
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.payload).toBe(Buffer.from('sk-test').toString('base64'));
      // Secret bytes never traverse the wire in the clear:
      expect(JSON.stringify(body)).not.toContain('sk-test');
      expect(body).toMatchObject({
        scope: 'global',
        ownerId: null,
        ref: 'anthropic',
        kind: 'api-key',
      });
    });

    it('listKinds GETs /admin/credentials/kinds', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({
          kinds: [{ kind: 'api-key', flow: 'paste' }],
        }),
      );
      const kinds = await adminCredentials.listKinds();
      expect(fetchMock.mock.calls[0]![0]).toBe('/admin/credentials/kinds');
      expect(kinds).toEqual([{ kind: 'api-key', flow: 'paste' }]);
    });

    it('oauthStart POSTs /admin/credentials/oauth/start', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({
          pendingId: 'p1',
          authorizeUrl: 'https://provider/authorize',
          instructions: 'paste',
        }),
      );
      const out = await adminCredentials.oauthStart({
        scope: 'global',
        ownerId: null,
        ref: 'anthropic',
        kind: 'anthropic-oauth',
      });
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('/admin/credentials/oauth/start');
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-requested-with']).toBe(
        'ax-admin',
      );
      expect(out.pendingId).toBe('p1');
    });

    it('oauthFinish POSTs /admin/credentials/oauth/finish', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse({ credential: { ref: 'k' } }, 201));
      await adminCredentials.oauthFinish({ pendingId: 'p1', code: 'abc' });
      expect(fetchMock.mock.calls[0]![0]).toBe(
        '/admin/credentials/oauth/finish',
      );
    });

    it('throws on non-ok responses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 500 }),
      );
      await expect(adminCredentials.list()).rejects.toThrow(/list/);
    });
  });

  describe('myCredentials', () => {
    it('list GETs /settings/credentials', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse({ credentials: [] }));
      await myCredentials.list();
      expect(fetchMock).toHaveBeenCalledWith(
        '/settings/credentials',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('listKinds shares the /admin/credentials/kinds route', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse({ kinds: [] }));
      await myCredentials.listKinds();
      expect(fetchMock.mock.calls[0]![0]).toBe('/admin/credentials/kinds');
    });
  });
});

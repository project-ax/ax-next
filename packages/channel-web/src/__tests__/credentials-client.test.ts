/**
 * Wire-client tests for `lib/credentials.ts`.
 *
 * Mirrors the shape the server contracts in `@ax/credentials-admin-routes`:
 *   - GET    /admin/credentials              → { credentials: [...] }
 *   - POST   /admin/credentials              → { credential }
 *   - GET    /admin/credentials/kinds        → { kinds: [...] }
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
import { adminCredentials, myCredentials, setDestinationCredential } from '../lib/credentials';
import { HttpError, HTTP_FAILED, HTTP_NO_ACCESS } from '../lib/http';

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

  describe('setDestinationCredential', () => {
    const input = {
      destination: { kind: 'provider', provider: 'openrouter' },
      slot: { kind: 'api-key' },
      scope: { scope: 'global', ownerId: null },
      payload: 'sk-test',
    } as const;
    const rejected = 'OpenRouter rejected that key. Double-check you copied the whole thing from openrouter.ai/keys.';

    it('shows the rejected-key reason on 422, rather than a connection error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: rejected }, 422));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(setDestinationCredential(input)).rejects.toMatchObject({
        name: 'HttpError', status: 422, message: rejected,
      });
    });

    it.each([
      'We could not reach OpenRouter to confirm the key. Check network access and try again.',
      'OpenRouter did not answer within 10 seconds, so we could not confirm the key. Worth trying again in a moment.',
    ])('keeps the specific validation failure: %s', async (message) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: message }, 422));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(setDestinationCredential(input)).rejects.toThrow(message);
    });

    it('gives retry guidance for an unexpected OpenRouter status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
        error: 'OpenRouter answered 429, so we could not confirm the key. Worth trying again in a moment.',
      }, 422));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(setDestinationCredential(input)).rejects.toThrow(
        'OpenRouter could not confirm this key right now. Try again in a moment.',
      );
    });

    it.each([
      ['key-rejected', 'Anthropic rejected that key. Check that you copied the whole API key.'],
      ['validation-timeout', 'Anthropic did not answer in time to confirm the key. Try again in a moment.'],
      ['validation-failed', 'We could not confirm this key with Anthropic. Try again in a moment.'],
    ])('translates the Anthropic validation code %s', async (code, message) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: code }, 422));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(setDestinationCredential({
        ...input, destination: { kind: 'provider', provider: 'anthropic' },
      })).rejects.toThrow(message);
    });

    it.each([
      { error: '<script>sk-test</script>' },
      { error: null },
      { error: { message: 'sk-test' } },
      null,
    ])('never renders or logs unknown response content: %j', async (body) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, 422));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(setDestinationCredential(input)).rejects.toThrow(
        'We could not confirm this key. Check it and try again.',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-test');
    });

    it('uses validation guidance even when the 422 body is not JSON', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('sk-test', { status: 422 }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(setDestinationCredential(input)).rejects.toThrow(
        'We could not confirm this key. Check it and try again.',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-test');
    });

    it('keeps authorization errors separate and never logs response bodies', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'sk-test' }, 403));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(setDestinationCredential(input)).rejects.toMatchObject({
        status: 403, message: HTTP_NO_ACCESS,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-test');
    });

    it('trims pasted whitespace from provider keys before validation and storage', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
      await setDestinationCredential({ ...input, payload: ' \n sk-test\t ' });
      const init = fetchMock.mock.calls[0]![1]!;
      expect(JSON.parse(init.body as string).payloadB64).toBe(btoa('sk-test'));
      expect(init).toMatchObject({ credentials: 'include', headers: { 'x-requested-with': 'ax-admin' } });
    });

    it('preserves whitespace in other kinds of secret', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
      await setDestinationCredential({ ...input, destination: { kind: 'account', service: 'gdrive' }, payload: ' secret ' });
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).payloadB64).toBe(btoa(' secret '));
    });

    it('turns transport exceptions into safe connection copy', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('request failed with sk-test'));
      await expect(setDestinationCredential(input)).rejects.toBeInstanceOf(HttpError);
      await expect(setDestinationCredential(input)).rejects.toThrow(HTTP_FAILED);
    });
  });
});

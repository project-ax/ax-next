/**
 * Wire-client tests for `lib/providers.ts` — Task 3.
 *
 * Mirrors the shape the server contracts in `@ax/credentials-admin-routes`:
 *   - GET    /admin/credentials/providers                → { providers: [...] }
 *   - POST   /admin/credentials/providers/:id/validate   → { provider }
 *
 * Pinned behaviors (the assertions are a contract):
 *   - All requests carry `credentials: 'include'` so cookies flow.
 *   - Writes carry `x-requested-with: ax-admin` for the http-server's
 *     CSRF guard.
 *   - `key` is base64-encoded before POSTing — the secret material
 *     never traverses the JSON wire in the clear.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listProviders, validateProviderKey } from '../lib/providers';

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('providers wire client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  describe('listProviders', () => {
    it('calls GET /admin/credentials/providers with credentials: include', async () => {
      fetchMock.mockResolvedValue(jsonOk({ providers: [] }));
      await listProviders();
      expect(fetchMock).toHaveBeenCalledWith(
        '/admin/credentials/providers',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('returns the providers array (unwraps the envelope)', async () => {
      const sample = [
        {
          id: 'anthropic',
          name: 'Anthropic',
          ref: 'anthropic',
          models: ['claude-opus', 'claude-sonnet'],
          configured: true,
        },
        {
          id: 'openai',
          name: 'OpenAI',
          ref: 'openai',
          models: ['gpt-4', 'gpt-3.5-turbo'],
          configured: false,
        },
      ];
      fetchMock.mockResolvedValue(jsonOk({ providers: sample }));
      const result = await listProviders();
      expect(result).toEqual(sample);
    });

    it('throws on non-ok responses', async () => {
      fetchMock.mockResolvedValue(
        new Response(null, { status: 500 }),
      );
      await expect(listProviders()).rejects.toThrow(/list providers/);
    });
  });

  describe('validateProviderKey', () => {
    it('calls POST /admin/credentials/providers/:id/validate with correct headers and base64-encoded body', async () => {
      fetchMock.mockResolvedValue(jsonOk({ provider: {} }));
      await validateProviderKey('anthropic', 'sk-test-key');

      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('/admin/credentials/providers/anthropic/validate');

      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      const headers = init.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-requested-with']).toBe('ax-admin');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.key).toBe(Buffer.from('sk-test-key').toString('base64'));
      // Secret bytes never traverse the wire in the clear:
      expect(JSON.stringify(body)).not.toContain('sk-test-key');
    });

    it('URL-encodes the provider id', async () => {
      fetchMock.mockResolvedValue(jsonOk({ provider: {} }));
      await validateProviderKey('provider-with-special/chars', 'key');

      expect(fetchMock.mock.calls[0]![0]).toBe(
        '/admin/credentials/providers/provider-with-special%2Fchars/validate',
      );
    });

    it('returns the result on 200', async () => {
      const result = {
        provider: {
          id: 'anthropic',
          name: 'Anthropic',
          ref: 'anthropic',
          configured: true as const,
        },
      };
      fetchMock.mockResolvedValue(jsonOk(result, 200));
      const out = await validateProviderKey('anthropic', 'sk-test');
      expect(out).toEqual(result);
    });

    it('throws with the server error message on 422', async () => {
      fetchMock.mockResolvedValue(
        jsonOk({ error: 'Invalid API key for provider' }, 422),
      );
      await expect(
        validateProviderKey('anthropic', 'bad-key'),
      ).rejects.toThrow('Invalid API key for provider');
    });

    it('throws on non-200/non-422 status codes', async () => {
      fetchMock.mockResolvedValue(
        new Response(null, { status: 500 }),
      );
      await expect(validateProviderKey('anthropic', 'key')).rejects.toThrow(
        /validate provider key: 500/,
      );
    });
  });
});

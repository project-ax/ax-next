import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchBranding,
  putBranding,
  logoUrl,
  BrandingHttpError,
} from '../branding';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('logoUrl', () => {
  it('builds a version-busted logo URL', () => {
    expect(logoUrl('light', '2026-06-25T00:00:00.000Z')).toBe(
      '/api/branding/logo/light?v=2026-06-25T00%3A00%3A00.000Z',
    );
  });
});

describe('fetchBranding', () => {
  it('returns the parsed wire body', async () => {
    const wire = {
      name: 'X',
      logoType: 'full' as const,
      light: false,
      dark: false,
      version: '',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(wire), { status: 200 })),
    );
    await expect(fetchBranding()).resolves.toEqual(wire);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    await expect(fetchBranding()).rejects.toThrow();
  });
});

describe('putBranding', () => {
  it('PUTs JSON with the CSRF header + credentials, dropping omitted fields', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, init: init ?? {} };
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await putBranding({ name: 'Canopy', light: null });

    expect(captured).not.toBeNull();
    const call = captured as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe('/admin/branding');
    expect(call.init.method).toBe('PUT');
    expect(call.init.credentials).toBe('include');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse(call.init.body as string)).toEqual({
      name: 'Canopy',
      light: null,
    });
  });

  it('throws BrandingHttpError carrying the server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'bytes do not match' }), {
            status: 422,
          }),
      ),
    );
    await expect(putBranding({ name: 'x' })).rejects.toBeInstanceOf(
      BrandingHttpError,
    );
    await expect(putBranding({ name: 'x' })).rejects.toThrow('bytes do not match');
  });
});

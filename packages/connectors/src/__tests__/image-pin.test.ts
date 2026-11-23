import { describe, it, expect } from 'vitest';
import { resolveImageDigest } from '../image-pin.js';
import { createPinnedFetch, isBlockedIp } from '../safe-registry-fetch.js';

const D = 'sha256:' + 'a'.repeat(64);

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A fake registry: HEAD manifest needs a bearer token; the realm hands one out. */
function fakeRegistry(opts: { requireAuth?: boolean; realm?: string; manifestStatus?: number } = {}) {
  const seen: Seen[] = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, method: init?.method ?? 'GET', headers });
    if (url.startsWith('https://auth.docker.io/token')) {
      return new Response(JSON.stringify({ token: 'tok123' }), { status: 200 });
    }
    if (url.includes('/manifests/')) {
      if (opts.requireAuth !== false && headers.authorization !== 'Bearer tok123') {
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': `Bearer realm="${opts.realm ?? 'https://auth.docker.io/token'}",service="registry.docker.io",scope="repository:library/mongo:pull"`,
          },
        });
      }
      return new Response(null, {
        status: opts.manifestStatus ?? 200,
        headers: { 'docker-content-digest': D },
      });
    }
    return new Response('nope', { status: 500 });
  }) as typeof fetch;
  return { f, seen };
}

describe('resolveImageDigest', () => {
  it('pins mongo:4.4 via a fake registry', async () => {
    const { f, seen } = fakeRegistry();
    const out = await resolveImageDigest('mongo:4.4', { fetch: f });
    expect(out).toEqual({ pinned: `mongo@${D}` });
    const head = seen.find((s) => s.url.includes('/manifests/'));
    expect(head?.url).toBe('https://registry-1.docker.io/v2/library/mongo/manifests/4.4');
    expect(head?.method).toBe('HEAD');
    expect(head?.headers.accept).toContain('application/vnd.oci.image.index.v1+json');
    expect(head?.headers.accept).toContain('application/vnd.docker.distribution.manifest.list.v2+json');
    // token scope is pull-only on this repo; no credential of ours is sent
    expect(seen.some((s) => s.url.includes('scope=repository%3Alibrary%2Fmongo%3Apull'))).toBe(true);
    expect(seen.every((s) => s.headers.cookie === undefined)).toBe(true);
  });

  it('pins a namespaced and a third-party registry ref', async () => {
    const { f, seen } = fakeRegistry({ requireAuth: false });
    expect(await resolveImageDigest('bitnami/redis', { fetch: f })).toEqual({
      pinned: `bitnami/redis@${D}`,
    });
    expect(await resolveImageDigest('ghcr.io/org/app:1.2', { fetch: f })).toEqual({
      pinned: `ghcr.io/org/app@${D}`,
    });
    expect(seen[1]?.url).toBe('https://ghcr.io/v2/org/app/manifests/1.2');
  });

  it('an already-pinned ref is returned unchanged, with no network call', async () => {
    const { f, seen } = fakeRegistry();
    const ref = `mongo@${D}`;
    expect(await resolveImageDigest(ref, { fetch: f })).toEqual({ pinned: ref });
    expect(seen).toEqual([]);
  });

  it.each([
    'https://10.0.0.1/app:1',
    '10.0.0.1/app:1',
    '127.0.0.1:443/app:1',
    '[::1]/app:1',
    '[::1]:443/app:1',
    'localhost/app:1',
    'localhost:5000/app:1',
    'intranet:443/app:1',
    'reg.local/app:1',
    'reg.internal/app:1',
    '2130706433.com.local/app:1',
    '0x7f.1/app:1',
    '169.254.169.254/app:1',
    'reg.example.com:8080/app:1',
  ])('refuses an unsafe registry: %s', async (ref) => {
    const { f, seen } = fakeRegistry();
    const out = await resolveImageDigest(ref, { fetch: f });
    expect(out).toHaveProperty('error');
    expect(seen).toEqual([]);
  });

  it('refuses an IP-literal registry', async () => {
    const { f, seen } = fakeRegistry();
    expect(await resolveImageDigest('192.168.1.5/app:1', { fetch: f })).toHaveProperty('error');
    expect(seen).toEqual([]);
  });

  it.each(['a b:1', 'mongo:4 .4', '../etc:1', 'mongo/../x:1', 'UPPER:1', 'mongo:', '', 'a//b:1', 'mongo:-x'])(
    'rejects a malformed reference before any network call: %j',
    async (ref) => {
      const { f, seen } = fakeRegistry();
      expect(await resolveImageDigest(ref, { fetch: f })).toHaveProperty('error');
      expect(seen).toEqual([]);
    },
  );

  it.each([
    'http://auth.example.com/token',
    'https://10.0.0.1/token',
    'https://localhost/token',
    'https://metadata.internal/token',
    'https://user:pw@auth.example.com/token',
  ])('refuses an unsafe token realm: %s', async (realm) => {
    const { f, seen } = fakeRegistry({ realm });
    const out = await resolveImageDigest('mongo:4.4', { fetch: f });
    expect(out).toHaveProperty('error');
    expect(seen.filter((s) => !s.url.includes('/manifests/'))).toEqual([]);
  });

  it('does not follow a manifest redirect to another host', async () => {
    const seen: string[] = [];
    const f = (async (input: unknown) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/x' } });
    }) as typeof fetch;
    expect(await resolveImageDigest('mongo:4.4', { fetch: f })).toHaveProperty('error');
    expect(seen).toHaveLength(1);
  });

  it('follows a same-host https manifest redirect', async () => {
    let n = 0;
    const f = (async (input: unknown) => {
      n++;
      if (n === 1) {
        return new Response(null, { status: 307, headers: { location: '/v2/library/mongo/manifests/moved' } });
      }
      expect(String(input)).toBe('https://registry-1.docker.io/v2/library/mongo/manifests/moved');
      return new Response(null, { status: 200, headers: { 'docker-content-digest': D } });
    }) as typeof fetch;
    expect(await resolveImageDigest('mongo:4.4', { fetch: f })).toEqual({
      pinned: `mongo@${D}`,
    });
  });

  it('refuses an oversized token response', async () => {
    const f = (async (input: unknown) => {
      if (String(input).startsWith('https://auth.docker.io')) {
        return new Response('x'.repeat(70 * 1024), { status: 200 });
      }
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="s"' },
      });
    }) as typeof fetch;
    expect(await resolveImageDigest('mongo:4.4', { fetch: f })).toEqual({
      error: 'registry token response too large',
    });
  });

  it('gives a plain error for a private image and for a missing tag', async () => {
    const denied = (async (input: unknown) => {
      if (String(input).startsWith('https://auth.docker.io')) return new Response('{}', { status: 401 });
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="s"' },
      });
    }) as typeof fetch;
    expect(await resolveImageDigest('mongo:4.4', { fetch: denied })).toHaveProperty('error');
    const { f } = fakeRegistry({ requireAuth: false, manifestStatus: 404 });
    expect(await resolveImageDigest('mongo:nope', { fetch: f })).toEqual({ error: 'image or tag not found' });
  });

  it('turns a network failure or a bad digest header into an error', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED 10.1.2.3');
    }) as typeof fetch;
    expect(await resolveImageDigest('mongo:4.4', { fetch: boom })).toEqual({
      error: 'could not reach the registry',
    });
    const bad = (async () =>
      new Response(null, { status: 200, headers: { 'docker-content-digest': 'sha256:xyz' } })) as typeof fetch;
    expect(await resolveImageDigest('mongo:4.4', { fetch: bad })).toHaveProperty('error');
  });

  it('keeps the input spelling: only the tag becomes the digest', async () => {
    const { f } = fakeRegistry({ requireAuth: false });
    expect(await resolveImageDigest('bitnamilegacy/kafka:latest', { fetch: f })).toEqual({
      pinned: `bitnamilegacy/kafka@${D}`,
    });
    expect(await resolveImageDigest('gcr.io/x/y:t', { fetch: f })).toEqual({ pinned: `gcr.io/x/y@${D}` });
    expect(await resolveImageDigest('docker.io/library/mongo:4', { fetch: f })).toEqual({
      pinned: `docker.io/library/mongo@${D}`,
    });
  });
});

describe('connect-time address vetting', () => {
  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1'])(
    'blocks %s',
    (ip) => expect(isBlockedIp(ip)).toBe(true),
  );
  it('allows a public address', () => expect(isBlockedIp('93.184.216.34')).toBe(false));

  it('a public-looking name that resolves to 10.x is refused before any connection', async () => {
    const resolver = async () => [{ address: '10.0.0.1', family: 4 }];
    const f = createPinnedFetch({ timeoutMs: 2000, resolver });
    expect(await resolveImageDigest('registry.example.com/app:1', { fetch: f })).toEqual({
      error: 'registry address is not public',
    });
  });

  it('a mixed public/private answer is refused too', async () => {
    const resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    const f = createPinnedFetch({ timeoutMs: 2000, resolver });
    expect(await resolveImageDigest('registry.example.com/app:1', { fetch: f })).toEqual({
      error: 'registry address is not public',
    });
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverOAuthHosts, metadataUrl, requestMetadata } from '../host-discovery.js';

const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: network.request }));

const resourceUrl = 'https://mcp.example.com/mcp';
const meta = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://login.example.com/authorize',
  token_endpoint: 'https://tokens.example.com/token',
  registration_endpoint: 'https://registration.example.com/client',
  response_types_supported: ['code'],
};
const resolver = async () => '93.184.216.34';
const json = (body: unknown) => new Response(JSON.stringify(body));

function fixture(metadata = meta) {
  return vi.fn<typeof requestMetadata>(async (url) => {
    if (url.href === resourceUrl) return new Response(null, { status: 401, headers: {
      'www-authenticate': 'Bearer resource_metadata="https://metadata.example.com/resource"',
    } });
    if (url.href === 'https://metadata.example.com/resource') return json({ resource: resourceUrl, authorization_servers: [metadata.issuer] });
    if (url.href === 'https://auth.example.com/.well-known/oauth-authorization-server') return json(metadata);
    throw new Error('unexpected network request');
  });
}

describe('OAuth host discovery preview', () => {
  it('discovers separate metadata, issuer, consent, token and registration hosts without calling the credential endpoints', async () => {
    const get = fixture();
    expect(await discoverOAuthHosts({ resourceUrl, resolver, request: get })).toEqual({ hosts: [
      'auth.example.com', 'login.example.com', 'mcp.example.com', 'metadata.example.com', 'registration.example.com', 'tokens.example.com',
    ], auth: 'oauth', clientRegistration: { cimd: false, dcr: true } });
    expect(get.mock.calls.map(([url]) => url.href)).toEqual([
      resourceUrl, 'https://metadata.example.com/resource', 'https://auth.example.com/.well-known/oauth-authorization-server',
    ]);
    expect(get.mock.calls[0]![1]).toMatchObject({ headersOnly: true, address: '93.184.216.34' });
    expect(get.mock.calls[1]![1]).toMatchObject({ headersOnly: false, address: '93.184.216.34' });
  });

  it('discovers Gmail path metadata and Google OIDC, includes the token host but excludes unused JWKS hosts', async () => {
    const gmail = 'https://gmailmcp.googleapis.com/mcp/v1';
    const get = vi.fn<typeof requestMetadata>(async (url) => {
      if (url.href === gmail) return new Response(null, { status: 405 });
      if (url.href === 'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1') {
        return json({ resource: gmail, authorization_servers: ['https://accounts.google.com/'] });
      }
      if (url.href === 'https://accounts.google.com/.well-known/oauth-authorization-server') return new Response(null, { status: 404 });
      return json({
        issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      });
    });
    expect(await discoverOAuthHosts({ resourceUrl: gmail, resolver, request: get })).toEqual({ hosts: [
      'accounts.google.com', 'gmailmcp.googleapis.com', 'oauth2.googleapis.com',
    ], auth: 'oauth', clientRegistration: { cimd: false, dcr: false } });
    expect(get.mock.calls.map(([url]) => url.hostname)).not.toContain('oauth2.googleapis.com');
  });

  it('reports published client identity support from the authorization server', async () => {
    const get = fixture({ ...meta, client_id_metadata_document_supported: true } as typeof meta);
    expect(await discoverOAuthHosts({ resourceUrl, resolver, request: get })).toMatchObject({
      auth: 'oauth', clientRegistration: { cimd: true, dcr: true },
    });
  });

  it.each([[405, 'none'], [200, 'none'], [401, 'other'], [403, 'other']] as const)(
    'classifies a server that answers %s with no OAuth metadata as %s',
    async (status, auth) => {
      const get = vi.fn<typeof requestMetadata>(async (url) =>
        url.href === resourceUrl ? new Response(null, { status }) : new Response(null, { status: 404 }));
      expect(await discoverOAuthHosts({ resourceUrl, resolver, request: get })).toEqual({ hosts: ['mcp.example.com'], auth });
    },
  );

  it('still fails when OAuth metadata exists but discovery breaks part-way', async () => {
    const get = vi.fn<typeof requestMetadata>(async (url) => {
      if (url.href === resourceUrl) return new Response(null, { status: 405 });
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json({ resource: resourceUrl, authorization_servers: [meta.issuer] });
      }
      return new Response(null, { status: 500 });
    });
    await expect(discoverOAuthHosts({ resourceUrl, resolver, request: get })).rejects.toThrow();
  });

  it('fails rather than reporting no sign-in when the server cannot be reached', async () => {
    const get = vi.fn<typeof requestMetadata>(async () => { throw new Error('ECONNREFUSED'); });
    await expect(discoverOAuthHosts({ resourceUrl, resolver, request: get })).rejects.toThrow();
  });

  it.each([
    'http://mcp.example.com', 'https://user:secret@mcp.example.com', 'https://mcp.example.com/#fragment',
    'https://mcp.example.com:8443/mcp', 'https://127.0.0.1/mcp', 'https://169.254.169.254/mcp', 'https://[::ffff:127.0.0.1]/mcp',
    'https://198.18.0.1/mcp', 'https://203.0.113.1/mcp', 'https://192.0.0.1/mcp',
  ])('refuses unsafe draft URL %s before any request', async (url) => {
    const get = fixture();
    await expect(discoverOAuthHosts({ resourceUrl: url, resolver, request: get })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['http://internal.example.com/token', 'https://127.0.0.1/token', 'https://user:secret@tokens.example.com/token'])('refuses an unsafe advertised endpoint %s', async (token_endpoint) => {
    const get = fixture({ ...meta, token_endpoint });
    await expect(discoverOAuthHosts({ resourceUrl, resolver, request: get })).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('rejects private DNS on a challenge host without fetching it', async () => {
    const get = fixture();
    await expect(discoverOAuthHosts({ resourceUrl, request: get,
      resolver: async (host) => host === 'metadata.example.com' ? '10.0.0.1' : '93.184.216.34',
    })).rejects.toThrow('private address');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('includes a public redirect host, while rechecking private redirect targets before connecting', async () => {
    const get = fixture();
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (url, opts) => {
      if (url.href === 'https://metadata.example.com/resource') return new Response(null, { status: 302, headers: { location: 'https://redirect.example.com/resource' } });
      if (url.href === 'https://redirect.example.com/resource') return json({ resource: resourceUrl, authorization_servers: [meta.issuer] });
      return original(url, opts);
    });
    expect((await discoverOAuthHosts({ resourceUrl, resolver, request: get })).hosts).toContain('redirect.example.com');
    get.mockClear();
    await expect(discoverOAuthHosts({ resourceUrl, request: get,
      resolver: async (host) => host === 'redirect.example.com' ? '192.168.1.1' : '93.184.216.34',
    })).rejects.toThrow('private address');
    expect(get.mock.calls.map(([url]) => url.hostname)).not.toContain('redirect.example.com');
  });

  it('rejects mismatched resource and issuer metadata', async () => {
    const get = fixture();
    get.mockImplementationOnce(async () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://metadata.example.com/resource"' } }));
    get.mockImplementationOnce(async () => json({ resource: 'https://other.example.com', authorization_servers: [meta.issuer] }));
    await expect(discoverOAuthHosts({ resourceUrl, resolver, request: get })).rejects.toThrow('does not match');
    const issuerGet = fixture();
    const original = issuerGet.getMockImplementation()!;
    issuerGet.mockImplementation(async (url, opts) => url.hostname === 'auth.example.com'
      ? json({ ...meta, issuer: 'https://other.example.com' }) : original(url, opts));
    await expect(discoverOAuthHosts({ resourceUrl, resolver, request: issuerGet })).rejects.toThrow('issuer does not match');
  });

  it('bounds redirects and aborts a hanging DNS lookup', async () => {
    const get = vi.fn<typeof requestMetadata>(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(discoverOAuthHosts({ resourceUrl, resolver, request: get })).rejects.toThrow('too many OAuth metadata redirects');
    expect(get).toHaveBeenCalledTimes(6);
    const controller = new AbortController();
    const hanging = discoverOAuthHosts({ resourceUrl, request: get, resolver: () => new Promise(() => {}), signal: controller.signal });
    controller.abort();
    await expect(hanging).rejects.toThrow('timed out');
  });

  it('refuses OIDC metadata without the endpoints needed to authorize', async () => {
    const get = fixture();
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (url, opts) => {
      if (url.hostname !== 'auth.example.com') return original(url, opts);
      if (url.pathname.includes('oauth-authorization-server')) return new Response(null, { status: 404 });
      return json({ issuer: meta.issuer, token_endpoint: meta.token_endpoint, jwks_uri: 'https://keys.example.com',
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      });
    });
    await expect(discoverOAuthHosts({ resourceUrl, resolver, request: get })).rejects.toThrow('authorization_endpoint');
  });
});

describe('IP-pinned metadata transport', () => {
  beforeEach(() => { network.request.mockReset(); });

  function setup(statusCode = 200) {
    const incoming = Object.assign(new PassThrough(), { statusCode, rawHeaders: ['Content-Type', 'application/json'] });
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    req.destroy.mockImplementation((error: Error) => { incoming.destroy(); req.emit('error', error); });
    network.request.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') queueMicrotask(() => callback(incoming));
      else throw new Error(`unexpected HTTPS request signature: ${args.map((arg) => typeof arg).join(', ')}`);
      return req;
    });
    return { incoming, req };
  }

  it('keeps the TLS hostname, pins both lookup forms, requires TLS verification and sends no credentials', async () => {
    const { incoming } = setup();
    const promise = requestMetadata(metadataUrl(resourceUrl), { address: '93.184.216.34', signal: new AbortController().signal, headersOnly: false });
    await Promise.resolve();
    incoming.end('{"ok":true}');
    expect(await (await promise).json()).toEqual({ ok: true });
    const [url, options] = network.request.mock.calls[0]!;
    expect(url.hostname).toBe('mcp.example.com');
    expect(options).toMatchObject({ method: 'GET', agent: false, rejectUnauthorized: true, headers: { Accept: 'application/json, text/event-stream' } });
    expect(Object.keys(options.headers)).toEqual(['Accept']);
    const cb = vi.fn();
    options.lookup('mcp.example.com', { all: false }, cb);
    expect(cb).toHaveBeenLastCalledWith(null, '93.184.216.34', 4);
    options.lookup('mcp.example.com', { all: true }, cb);
    expect(cb).toHaveBeenLastCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('closes a resource/SSE probe as soon as headers arrive', async () => {
    const { incoming } = setup(401);
    const response = await requestMetadata(metadataUrl(resourceUrl), { address: '93.184.216.34', signal: new AbortController().signal, headersOnly: true });
    expect(response.status).toBe(401);
    expect(response.body).toBeNull();
    expect(incoming.destroyed).toBe(true);
  });

  it('rejects oversized metadata rather than buffering an unbounded response', async () => {
    const { incoming, req } = setup();
    const promise = requestMetadata(metadataUrl(resourceUrl), { address: '93.184.216.34', signal: new AbortController().signal, headersOnly: false });
    await Promise.resolve();
    incoming.write(Buffer.alloc(64 * 1024 + 1));
    await expect(promise).rejects.toThrow('too large');
    expect(req.destroy).toHaveBeenCalled();
  });

  it('handles no-content and invalid statuses without throwing out of a response event', async () => {
    setup(205);
    const response = await requestMetadata(metadataUrl(resourceUrl), { address: '93.184.216.34', signal: new AbortController().signal, headersOnly: false });
    expect(response.status).toBe(205);
    expect(response.body).toBeNull();
    setup(601);
    await expect(requestMetadata(metadataUrl(resourceUrl), { address: '93.184.216.34', signal: new AbortController().signal, headersOnly: false })).rejects.toThrow('Invalid OAuth metadata HTTP status');
  });
});

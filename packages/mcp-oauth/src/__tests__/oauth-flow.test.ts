import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockedUrlError } from '../ssrf.js';
import { buildAuthorization, discover, ensureClient, redeemCode, refresh } from '../oauth-flow.js';

// A minimal valid RFC 8414 AS-metadata object (matches the SDK's OAuthMetadata
// shape: issuer + authorization_endpoint + token_endpoint + response_types_supported
// are required; code_challenge_methods_supported drives PKCE method selection).
const meta: AuthorizationServerMetadata = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};
const allow = new Set(['auth.example.com']);
// Resolver stub keeps the suite offline: allowlisted host → a public IP.
const resolver = async () => '93.184.216.34';

describe('buildAuthorization', () => {
  it('requests offline access and fresh consent for a pinned Google OAuth client', async () => {
    const { authorizationUrl } = await buildAuthorization({
      metadata: { ...meta, issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth' },
      client: { clientId: 'google-client', clientSecret: 'secret' },
      redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
      resource: 'https://gmailmcp.googleapis.com/mcp/v1',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      state: 'google-state', allowedHosts: new Set(['accounts.google.com']), resolver,
    });
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('google-state');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('produces an authorize URL with state, PKCE challenge, and resource', async () => {
    const { authorizationUrl, codeVerifier } = await buildAuthorization({
      metadata: meta,
      client: { clientKey: 'c|a', clientId: 'cid', clientSecret: undefined, dynamic: true },
      redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
      resource: 'https://mcp.example.com',
      scope: 'read',
      state: 'st123',
      allowedHosts: allow,
      resolver,
    });
    const u = new URL(authorizationUrl);
    expect(u.searchParams.get('state')).toBe('st123');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('resource')).toBe('https://mcp.example.com/');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('scope')).toBe('read');
    expect(u.searchParams.has('access_type')).toBe(false);
    expect(u.searchParams.has('prompt')).toBe(false);
    expect(codeVerifier.length).toBeGreaterThan(20);
  });

  it('rejects when the authorization endpoint host is not allowlisted', async () => {
    await expect(
      buildAuthorization({
        metadata: { ...meta, authorization_endpoint: 'https://evil.example.net/authorize' },
        client: { clientKey: 'c|a', clientId: 'cid', clientSecret: undefined, dynamic: true },
        redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
        resource: 'https://mcp.example.com',
        state: 'st123',
        allowedHosts: allow,
        resolver,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});

describe('refresh', () => {
  it('rejects when the token endpoint host is not allowlisted', async () => {
    await expect(
      refresh({
        metadata: { ...meta, token_endpoint: 'https://evil.example.net/token' },
        client: { clientKey: 'c|a', clientId: 'cid', clientSecret: undefined, dynamic: true },
        refreshToken: 'rt',
        resource: 'https://mcp.example.com',
        allowedHosts: allow,
        resolver,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});

describe('ensureClient', () => {
  it.each(['auto', 'cimd'] as const)('uses published identity for %s without dynamic registration', async registration => {
    const reg = await ensureClient({ metadata: { ...meta, client_id_metadata_document_supported: true }, clientKey: 'c|a', redirectUri: 'https://app.example.com/api/connectors/oauth/callback', registration, clientMetadataUrl: 'https://app.example.com/api/connectors/oauth/client-metadata', allowedHosts: allow, resolver });
    expect(reg).toMatchObject({ clientId: 'https://app.example.com/api/connectors/oauth/client-metadata', dynamic: false });
    expect(reg.clientSecret).toBeUndefined();
  });
  it('fails explicitly when published identity is unsupported, or the custom client ID is missing', async () => {
    const common = { metadata: meta, clientKey: 'c|a', redirectUri: 'https://app.example.com/callback', allowedHosts: allow, resolver };
    await expect(ensureClient({ ...common, registration: 'cimd', clientMetadataUrl: 'https://app.example.com/client.json' })).rejects.toThrow(/published client/);
    await expect(ensureClient({ ...common, registration: 'custom' })).rejects.toThrow(/client ID/);
    await expect(ensureClient({ ...common, metadata: { ...meta, client_id_metadata_document_supported: true }, registration: 'cimd', clientMetadataUrl: 'http://app.example.com/client.json' })).rejects.toThrow(/HTTPS/);
  });
  it('sends the client name with dynamic registration', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ client_id: 'dcr-client', redirect_uris: ['https://app.example.com/callback'] }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }));
    try {
      const reg = await ensureClient({
        metadata: meta, clientKey: 'c|a', redirectUri: 'https://app.example.com/callback',
        registration: 'dcr', clientName: 'Canopy AI', allowedHosts: allow, resolver,
      });
      expect(reg).toMatchObject({ clientId: 'dcr-client', dynamic: true });
      expect(bodies).toEqual([expect.objectContaining({ client_name: 'Canopy AI', redirect_uris: ['https://app.example.com/callback'] })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('returns a pinned registration without any network call', async () => {
    const reg = await ensureClient({
      metadata: meta,
      clientKey: 'c|a',
      redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
      pinned: { clientId: 'pinned-id', clientSecret: 'pinned-secret' },
      allowedHosts: allow,
      resolver,
    });
    expect(reg).toEqual({
      clientKey: 'c|a',
      clientId: 'pinned-id',
      clientSecret: 'pinned-secret',
      dynamic: false,
    });
  });

  it('rejects dynamic registration when the registration endpoint host is not allowlisted', async () => {
    await expect(
      ensureClient({
        metadata: { ...meta, registration_endpoint: 'https://evil.example.net/register' },
        clientKey: 'c|a',
        redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
        allowedHosts: allow,
        resolver,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});

describe('discover', () => {
  afterEach(() => vi.unstubAllGlobals());

  const resourceUrl = 'https://mcp.example.com/mcp';
  const metadataUrl = 'https://mcp.example.com/oauth/resource';
  const discoveryHosts = new Set(['mcp.example.com', 'auth.example.com']);

  it('discovers Gmail path metadata and Google OIDC, then redeems and refreshes as the pinned client', async () => {
    const gmail = 'https://gmailmcp.googleapis.com/mcp/v1';
    const google = {
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    };
    const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
    const grants: URLSearchParams[] = [];
    const mocked = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === gmail) return new Response(null, { status: 405 });
      let body: unknown;
      if (url === 'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1') {
        body = { resource: gmail, authorization_servers: ['https://accounts.google.com/'], scopes_supported: scopes };
      } else if (url === 'https://accounts.google.com/.well-known/openid-configuration') {
        body = google;
      } else if (url === google.token_endpoint) {
        const grant = new URLSearchParams(String(init?.body));
        grants.push(grant);
        body = { access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3600 };
      } else {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', mocked);
    const allowedHosts = new Set(['gmailmcp.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com']);
    const discovered = await discover({ resourceUrl: gmail, allowedHosts, resolver });
    expect(discovered.authServerUrl).toBe(google.issuer);
    const client = await ensureClient({
      metadata: discovered.metadata, clientKey: 'gmail|google',
      redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
      pinned: { clientId: 'pinned-google-client', clientSecret: 'pinned-secret' }, allowedHosts, resolver,
    });
    const authorization = await buildAuthorization({
      metadata: discovered.metadata, client,
      redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
      resource: gmail, scope: scopes.join(' '), state: 'google-state', allowedHosts, resolver,
    });
    expect(new URL(authorization.authorizationUrl).searchParams.get('access_type')).toBe('offline');
    const tokens = await redeemCode({
      metadata: discovered.metadata, client, code: 'authorization-code', codeVerifier: authorization.codeVerifier,
      redirectUri: 'https://app.example.com/api/connectors/oauth/callback', resource: gmail, allowedHosts, resolver,
    });
    await refresh({ metadata: discovered.metadata, client, refreshToken: tokens.refresh_token!, resource: gmail, allowedHosts, resolver });
    expect(grants.map(g => g.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    for (const grant of grants) {
      expect(grant.get('client_id')).toBe('pinned-google-client');
      expect(grant.get('client_secret')).toBe('pinned-secret');
      expect(grant.get('resource')).toBe(gmail);
    }
    expect(grants[0]!.get('code_verifier')).toBe(authorization.codeVerifier);
    expect(grants[1]!.get('refresh_token')).toBe('refresh-token');
  });

  function discoveryFetch(challenge?: string, scopes?: string[]) {
    const mocked = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === resourceUrl) {
        return new Response(null, {
          status: 401,
          ...(challenge ? { headers: { 'www-authenticate': challenge } } : {}),
        });
      }
      if (url === metadataUrl || (!challenge && url.includes('oauth-protected-resource'))) {
        return new Response(JSON.stringify({
          resource: resourceUrl,
          authorization_servers: [meta.issuer],
          ...(scopes ? { scopes_supported: scopes } : {}),
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', mocked);
    return mocked;
  }

  it('uses the metadata URL from the MCP authentication challenge before well-known discovery', async () => {
    const mocked = discoveryFetch(`Bearer resource_metadata="${metadataUrl}", scope="read write"`, ['read']);
    const result = await discover({ resourceUrl, allowedHosts: discoveryHosts, resolver });
    expect(result).toEqual({ authServerUrl: meta.issuer, metadata: meta, scope: 'read write' });
    expect(mocked.mock.calls.map(([url]) => url)).toEqual([
      resourceUrl, metadataUrl, 'https://auth.example.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('falls back to well-known discovery and metadata scopes when no challenge is advertised', async () => {
    const mocked = discoveryFetch(undefined, ['read', 'write']);
    const result = await discover({ resourceUrl, allowedHosts: discoveryHosts, resolver });
    expect(result.scope).toBe('read write');
    expect(mocked.mock.calls.map(([url]) => url)).toContain(
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('supports an insufficient-scope challenge returned with 403', async () => {
    const mocked = discoveryFetch(`Bearer resource_metadata="${metadataUrl}"`, ['read']);
    mocked.mockImplementationOnce(async () => new Response(null, {
      status: 403,
      headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}", scope="write"` },
    }));
    const result = await discover({ resourceUrl, allowedHosts: discoveryHosts, resolver });
    expect(result.scope).toBe('write');
  });

  it('cancels a resource event stream before falling back to well-known discovery', async () => {
    const cancel = vi.fn();
    const mocked = discoveryFetch();
    mocked.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const result = await discover({ resourceUrl, allowedHosts: discoveryHosts, resolver });
    expect(result.authServerUrl).toBe(meta.issuer);
    expect(result).not.toHaveProperty('scope');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects challenge metadata describing a different resource', async () => {
    const mocked = discoveryFetch(`Bearer resource_metadata="${metadataUrl}"`);
    mocked.mockImplementationOnce(async () => new Response(null, {
      status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` },
    })).mockImplementationOnce(async () => new Response(JSON.stringify({
      resource: 'https://mcp.example.com/different', authorization_servers: [meta.issuer],
    }), { headers: { 'content-type': 'application/json' } }));
    await expect(discover({ resourceUrl, allowedHosts: discoveryHosts, resolver }))
      .rejects.toThrow(/does not match requested resource/);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it.each([
    'https://evil.example.net/metadata',
    'http://mcp.example.com/metadata',
    'https://127.0.0.1/metadata',
  ])('blocks a challenge metadata URL outside the connector capability: %s', async (url) => {
    const mocked = discoveryFetch(`Bearer resource_metadata="${url}"`);
    await expect(discover({
      resourceUrl, allowedHosts: new Set([...discoveryHosts, '127.0.0.1']), resolver,
    })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('blocks redirects from challenge metadata to a non-allowlisted host', async () => {
    const mocked = discoveryFetch(`Bearer resource_metadata="${metadataUrl}"`);
    mocked.mockImplementation(async (input) => input.toString() === resourceUrl
      ? new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` } })
      : new Response(null, { status: 302, headers: { location: 'https://evil.example.net/metadata' } }));
    await expect(discover({ resourceUrl, allowedHosts: discoveryHosts, resolver })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('does not probe the resource when the authorization server is pinned', async () => {
    const mocked = discoveryFetch();
    const result = await discover({
      resourceUrl, pinnedAuthServerUrl: meta.issuer, allowedHosts: discoveryHosts, resolver,
    });
    expect(result.authServerUrl).toBe(meta.issuer);
    expect(mocked.mock.calls.map(([url]) => url)).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('rejects metadata whose issuer differs from the discovered authorization server', async () => {
    const mocked = discoveryFetch();
    mocked.mockImplementationOnce(async () => new Response(JSON.stringify({
      ...meta, issuer: 'https://other.example.com',
    }), { headers: { 'content-type': 'application/json' } }));
    await expect(discover({
      resourceUrl, pinnedAuthServerUrl: meta.issuer, allowedHosts: discoveryHosts, resolver,
    })).rejects.toThrow(/issuer.*does not match/);
  });

  it('accepts Google resource metadata with a root slash and binds the canonical Google issuer', async () => {
    const mocked = discoveryFetch();
    mocked.mockImplementationOnce(async () => new Response(JSON.stringify({
      ...meta, issuer: 'https://accounts.google.com',
    }), { headers: { 'content-type': 'application/json' } }));
    const result = await discover({
      resourceUrl, pinnedAuthServerUrl: 'https://accounts.google.com/',
      allowedHosts: new Set(['accounts.google.com']), resolver,
    });
    expect(result.authServerUrl).toBe('https://accounts.google.com');
  });

  it('rejects before any probe when the resource host is not allowlisted', async () => {
    // The resource URL itself is untrusted input; the SSRF gate must fire on it
    // BEFORE the SDK runs its `/.well-known/oauth-protected-resource` probe.
    await expect(
      discover({
        resourceUrl: 'https://evil.example.net/mcp',
        allowedHosts: allow,
        resolver,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects before any probe when a pinned auth-server host is not allowlisted', async () => {
    await expect(
      discover({
        resourceUrl: 'https://auth.example.com/mcp',
        pinnedAuthServerUrl: 'https://evil.example.net',
        allowedHosts: allow,
        resolver,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  // NOTE: the "PRM advertises an internal authorization server" case (an
  // allowlisted-public resource whose metadata names an internal AS) needs a fake
  // PRM server to exercise; that lives in the T12 end-to-end. The pre-assert on the
  // advertised authServerUrl in discover() is the guard that covers it.

  // RFC 9728 §3.3: the `resource` value the PRM advertises MUST identify the same
  // resource we asked about. A compromised (but allowlisted) resource server must
  // not be able to advertise an authorization server for a resource it doesn't own.
  // We exercise the `sameResource` rejection branch by stubbing the global fetch the
  // guarded fetch ultimately calls so the SDK's PRM discovery returns a document
  // whose `resource` points at a DIFFERENT origin than the one we requested.
  describe('RFC 9728 §3.3 resource mismatch', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects when the PRM advertises a non-matching resource', async () => {
      const resourceUrl = 'https://mcp.example.com/mcp';
      // The PRM document the (stubbed) resource server returns — note the
      // `resource` is a DIFFERENT URL than `resourceUrl`, the §3.3 violation.
      const prm = {
        resource: 'https://attacker.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      };
      // safeFetch defaults doFetch to the global `fetch`; stub it. The resolver
      // stub keeps DNS offline and the host (mcp.example.com) is allowlisted, so
      // the SSRF pre-gate passes and the SDK's PRM probe reaches this stub.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify(prm), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      await expect(
        discover({
          resourceUrl,
          allowedHosts: new Set(['mcp.example.com', 'attacker.example.com', 'auth.example.com']),
          resolver,
        }),
      ).rejects.toThrow(/does not match requested resource/);
    });
  });
});

describe('redeemCode', () => {
  it('rejects when the token endpoint host is not allowlisted', async () => {
    await expect(
      redeemCode({
        metadata: { ...meta, token_endpoint: 'https://evil.example.net/token' },
        client: { clientKey: 'c|a', clientId: 'cid', clientSecret: undefined, dynamic: true },
        code: 'authcode',
        codeVerifier: 'verifier',
        redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
        resource: 'https://mcp.example.com',
        allowedHosts: allow,
        resolver,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});

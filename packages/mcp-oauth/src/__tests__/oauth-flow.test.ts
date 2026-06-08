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

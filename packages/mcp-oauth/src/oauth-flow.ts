import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformation,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { assertSafeUrl, type HostResolver, safeFetch } from './ssrf.js';
import type { ClientRegistration } from './types.js';

/**
 * The MCP SDK's OAuth helpers drive the full authorization-code + PKCE dance, but
 * every URL they touch — the resource server, its advertised authorization server,
 * the token/registration endpoints — is named by *untrusted third-party metadata*.
 * A malicious (or compromised) MCP server can point any of those at an internal
 * address and turn our OAuth client into an SSRF cannon.
 *
 * So we guard outbound requests in two layers (defense in depth):
 *   1. A `assertSafeUrl` pre-check on the exact endpoint URL we're about to hit
 *      (host must be allowlisted + resolve to a non-private IP, https-only).
 *   2. A guarded `fetchFn` handed to every SDK helper that accepts one, so URLs
 *      the SDK derives internally (e.g. `.well-known/...` discovery probes) get
 *      the same check at fetch time — including every redirect hop (see safeFetch).
 *
 * `allowedHosts` + `resolver` are injected by the caller (and by tests) so this
 * module makes no real network or DNS calls of its own.
 */

/**
 * Build a `fetch`-shaped function for the SDK that delegates to `safeFetch`, so it
 * inherits the shared per-hop SSRF gate AND the bounded, re-validating redirect
 * follow. The SDK's POSTs (token exchange, dynamic registration) are protected too
 * — a `302` off a token endpoint can't bounce the request to an internal host.
 */
export function guardedFetch(allowedHosts: Set<string>, resolver?: HostResolver): FetchLike {
  return (url, init) =>
    safeFetch(typeof url === 'string' ? url : url.toString(), allowedHosts, init, resolver);
}

/**
 * RFC 9728 protected-resource-metadata discovery → RFC 8414 / OIDC authorization-
 * server-metadata discovery.
 *
 * If `pinnedAuthServerUrl` is supplied (admin pre-configured the AS), PRM discovery
 * is skipped and we go straight to AS-metadata discovery on the pinned URL. Otherwise
 * we ask the resource server which authorization server it trusts.
 */
export async function discover(opts: {
  resourceUrl: string;
  pinnedAuthServerUrl?: string;
  allowedHosts: Set<string>;
  resolver?: HostResolver;
}): Promise<{ authServerUrl: string; metadata: AuthorizationServerMetadata }> {
  const { resourceUrl, pinnedAuthServerUrl, allowedHosts, resolver } = opts;
  const fetchFn = guardedFetch(allowedHosts, resolver);

  let authServerUrl: string;
  if (pinnedAuthServerUrl) {
    authServerUrl = pinnedAuthServerUrl;
  } else {
    // Pre-gate the resource server's base. The SDK derives the
    // `/.well-known/oauth-protected-resource` path from this same origin and we
    // hand it the guarded fetchFn, so the derived probe is also checked.
    await assertSafeUrl(resourceUrl, allowedHosts, resolver);
    const prm = await discoverOAuthProtectedResourceMetadata(resourceUrl, undefined, fetchFn);
    // RFC 9728 §3.3: the `resource` value in the metadata MUST identify the same
    // resource we asked about. A compromised resource server shouldn't be able to
    // advertise an authorization server for a resource it doesn't own, so we refuse
    // a PRM whose `resource` doesn't match the URL we requested (origin + path,
    // trailing-slash-insensitive — query/hash are not part of a resource identifier).
    if (!sameResource(prm.resource, resourceUrl)) {
      throw new Error(
        `protected-resource metadata resource '${prm.resource}' does not match requested resource '${resourceUrl}'`,
      );
    }
    const advertised = prm.authorization_servers?.[0];
    if (!advertised) {
      throw new Error(
        `resource ${resourceUrl} advertises no authorization server in its protected-resource metadata`,
      );
    }
    authServerUrl = advertised;
  }

  // Pre-gate the authorization server's base. The SDK derives the
  // `.well-known/oauth-authorization-server` / `openid-configuration` probes from
  // this origin; the guarded fetchFn re-checks each derived URL at fetch time.
  await assertSafeUrl(authServerUrl, allowedHosts, resolver);
  const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn });
  if (!metadata) {
    throw new Error(`authorization server ${authServerUrl} returned no usable metadata`);
  }
  return { authServerUrl, metadata };
}

/**
 * Either return the admin-pinned client credentials as-is, or perform RFC 7591
 * Dynamic Client Registration against the authorization server.
 */
export async function ensureClient(opts: {
  metadata: AuthorizationServerMetadata;
  clientKey: string;
  redirectUri: string;
  scope?: string;
  pinned?: { clientId: string; clientSecret?: string };
  allowedHosts: Set<string>;
  resolver?: HostResolver;
}): Promise<ClientRegistration> {
  const { metadata, clientKey, redirectUri, scope, pinned, allowedHosts, resolver } = opts;

  if (pinned) {
    return {
      clientKey,
      clientId: pinned.clientId,
      clientSecret: pinned.clientSecret,
      dynamic: false,
    };
  }

  // The SDK hits `metadata.registration_endpoint` (it throws if absent). Pre-gate
  // that exact URL, then also hand it the guarded fetchFn as a second layer.
  if (!metadata.registration_endpoint) {
    throw new Error('authorization server does not advertise a dynamic client registration endpoint');
  }
  await assertSafeUrl(metadata.registration_endpoint, allowedHosts, resolver);

  const info = await registerClient(metadata.issuer, {
    metadata,
    clientMetadata: {
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public app: no static secret unless the AS forces one back at us.
      token_endpoint_auth_method: 'none',
      ...(scope !== undefined ? { scope } : {}),
    },
    // `scope` here overrides clientMetadata.scope (SEP-835); only pass it when set.
    ...(scope !== undefined ? { scope } : {}),
    fetchFn: guardedFetch(allowedHosts, resolver),
  });

  return {
    clientKey,
    clientId: info.client_id,
    clientSecret: info.client_secret,
    dynamic: true,
  };
}

/**
 * Begin the authorization-code flow: generate a PKCE challenge and build the
 * authorize URL the user agent will be redirected to.
 *
 * `startAuthorization` is a *local* operation — it builds a URL and a PKCE pair
 * and makes no outbound HTTP request, so it takes no fetchFn. We still pre-gate the
 * `authorization_endpoint` host: it's where the user's browser is about to be sent,
 * and a metadata-supplied internal address has no business there.
 */
export async function buildAuthorization(opts: {
  metadata: AuthorizationServerMetadata;
  client: ClientRegistration;
  redirectUri: string;
  resource: string;
  scope?: string;
  state: string;
  allowedHosts: Set<string>;
  resolver?: HostResolver;
}): Promise<{ authorizationUrl: string; codeVerifier: string }> {
  const { metadata, client, redirectUri, resource, scope, state, allowedHosts, resolver } = opts;

  const authorizationEndpoint = metadata.authorization_endpoint;
  await assertSafeUrl(authorizationEndpoint, allowedHosts, resolver);

  const { authorizationUrl, codeVerifier } = await startAuthorization(metadata.issuer, {
    metadata,
    clientInformation: toClientInformation(client),
    redirectUrl: redirectUri,
    ...(scope !== undefined ? { scope } : {}),
    state,
    // RFC 8707 resource indicator — the SDK expects a URL instance.
    resource: new URL(resource),
  });

  return { authorizationUrl: authorizationUrl.toString(), codeVerifier };
}

/** Exchange an authorization code for tokens (SSRF-guarded token-endpoint hit). */
export async function redeemCode(opts: {
  metadata: AuthorizationServerMetadata;
  client: ClientRegistration;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
  allowedHosts: Set<string>;
  resolver?: HostResolver;
}): Promise<OAuthTokens> {
  const { metadata, client, code, codeVerifier, redirectUri, resource, allowedHosts, resolver } =
    opts;

  await assertSafeUrl(tokenEndpoint(metadata), allowedHosts, resolver);

  return exchangeAuthorization(metadata.issuer, {
    metadata,
    clientInformation: toClientInformation(client),
    authorizationCode: code,
    codeVerifier,
    redirectUri,
    resource: new URL(resource),
    fetchFn: guardedFetch(allowedHosts, resolver),
  });
}

/** Exchange a refresh token for fresh tokens (SSRF-guarded token-endpoint hit). */
export async function refresh(opts: {
  metadata: AuthorizationServerMetadata;
  client: ClientRegistration;
  refreshToken: string;
  resource: string;
  allowedHosts: Set<string>;
  resolver?: HostResolver;
}): Promise<OAuthTokens> {
  const { metadata, client, refreshToken, resource, allowedHosts, resolver } = opts;

  await assertSafeUrl(tokenEndpoint(metadata), allowedHosts, resolver);

  return refreshAuthorization(metadata.issuer, {
    metadata,
    clientInformation: toClientInformation(client),
    refreshToken,
    resource: new URL(resource),
    fetchFn: guardedFetch(allowedHosts, resolver),
  });
}

/**
 * The token endpoint the SDK will actually hit. The SDK's own derivation is
 * `metadata?.token_endpoint ? new URL(token_endpoint) : new URL('/token', authServerUrl)`,
 * i.e. it falls back to `/token` on the auth-server base only when `token_endpoint`
 * is falsy. We always pass `metadata`, and `token_endpoint` is schema-required (a
 * non-empty URL in `OAuthMetadataSchema`), so the SDK never reaches that fallback —
 * this value and the SDK's are guaranteed to agree.
 */
function tokenEndpoint(metadata: AuthorizationServerMetadata): string {
  return metadata.token_endpoint;
}

/** Normalize a URL to origin + path (drop trailing slash, query, hash) for resource-identity comparison. */
function normalizeResource(u: string): string {
  const url = new URL(u);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** RFC 9728 resource-identity equality, trailing-slash-insensitive. Returns false on any unparseable input. */
function sameResource(a: string, b: string): boolean {
  try {
    return normalizeResource(a) === normalizeResource(b);
  } catch {
    return false;
  }
}

/** Adapt our stored registration into the SDK's `OAuthClientInformation` shape. */
function toClientInformation(client: ClientRegistration): OAuthClientInformation {
  return {
    client_id: client.clientId,
    ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}),
  };
}

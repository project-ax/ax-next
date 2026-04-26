import { Issuer, generators, type Client } from 'openid-client';

// ---------------------------------------------------------------------------
// Google OIDC handshake (and any other provider with the same shape).
//
// The plan locks the issuer URL at config time (Invariant I11 — IdP
// discovery is pinned). We do call `Issuer.discover()` ONCE at init to
// fetch the metadata document, but the input issuer URL itself comes from
// plugin config and is never overridable at request time.
//
// State / PKCE / nonce are all minted per-request via openid-client's
// `generators` helpers. State + the PKCE verifier are stashed in a single
// signed cookie (`ax_oidc_state`, 5-minute lifetime) so callback validation
// is one cookie read. The cookie is signed by @ax/http-server with the
// server's HMAC key — tamper returns null, which the callback handler
// translates to a generic 400.
//
// Plain-cookie shape for ax_oidc_state:
//   `${state}.${nonce}.${codeVerifier}`
// Each segment is base64url-safe (generators.* outputs are already URL
// safe), so a single dot delimiter is unambiguous.
//
// On callback failure we log only the error code (`invalid_request`,
// `interaction_required`, etc.). Raw IdP error fields can include
// user-controlled `state` in the OPError instance; those NEVER hit a log
// call. Returns generic 400 to the caller.
// ---------------------------------------------------------------------------

const STATE_COOKIE_NAME = 'ax_oidc_state';
const STATE_COOKIE_MAX_AGE_SECS = 5 * 60;
const STATE_COOKIE_DELIMITER = '.';

export interface OidcProviderConfig {
  /** OAuth client_id. */
  clientId: string;
  /** OAuth client_secret. Read from env at config-build time, not request. */
  clientSecret: string;
  /**
   * Pinned issuer URL (e.g. 'https://accounts.google.com'). Discovery
   * runs once at init, fetching the metadata doc from
   * `<issuer>/.well-known/openid-configuration`.
   */
  issuer: string;
  /**
   * Exact-match redirect_uri. The IdP and our config MUST agree byte-for-
   * byte; the OIDC client validates this against the discovered metadata
   * and the callback parameters.
   */
  redirectUri: string;
}

export interface OidcHandshake {
  /** Provider key (currently always 'google' for MVP). */
  readonly providerKey: string;
  /** Auth-provider id stored in the user row (currently 'google-oidc'). */
  readonly authProvider: string;
  /**
   * Build a 302 target for sign-in. Returns the auth URL plus the cookie
   * value to store; the route handler is responsible for setting the
   * cookie via res.setSignedCookie before redirecting.
   */
  begin(): { authUrl: string; cookieValue: string };
  /**
   * Exchange the IdP's `code` for tokens, then fetch userinfo. Returns
   * the userinfo claims on success. Throws on any IdP-side error; the
   * caller MUST translate to a generic 400.
   */
  finish(args: {
    callbackParams: Record<string, string>;
    cookieValue: string | null;
  }): Promise<{ subjectId: string; email: string | null; displayName: string | null }>;
}

/**
 * Construct an OidcHandshake. Calls `Issuer.discover()` once and caches
 * the resulting Client; subsequent calls reuse the discovered metadata.
 */
export async function createOidcHandshake(args: {
  providerKey: 'google';
  config: OidcProviderConfig;
}): Promise<OidcHandshake> {
  const issuer = await Issuer.discover(args.config.issuer);
  const client: Client = new issuer.Client({
    client_id: args.config.clientId,
    client_secret: args.config.clientSecret,
    redirect_uris: [args.config.redirectUri],
    response_types: ['code'],
  });
  // openid-client allows the metadata's `issuer` to be overridden via
  // additional_authorized_parties, but for Google + every well-known IdP
  // we want strict comparison. The default callback() check enforces this.
  return {
    providerKey: args.providerKey,
    authProvider: 'google-oidc',
    begin() {
      const state = generators.state();
      const nonce = generators.nonce();
      const codeVerifier = generators.codeVerifier();
      const codeChallenge = generators.codeChallenge(codeVerifier);
      const authUrl = client.authorizationUrl({
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      const cookieValue = encodeStateCookie({ state, nonce, codeVerifier });
      return { authUrl, cookieValue };
    },
    async finish({ callbackParams, cookieValue }) {
      if (cookieValue === null) {
        throw new OidcCallbackError('state-cookie-missing');
      }
      const decoded = decodeStateCookie(cookieValue);
      if (decoded === null) {
        throw new OidcCallbackError('state-cookie-malformed');
      }
      const tokenSet = await client.callback(
        args.config.redirectUri,
        callbackParams,
        {
          state: decoded.state,
          nonce: decoded.nonce,
          code_verifier: decoded.codeVerifier,
        },
      );
      // Prefer id_token claims over userinfo when both are available; the
      // id_token is signed and bound to our nonce, while userinfo is a
      // separate HTTP fetch the IdP could substitute in flight (still
      // bearer-protected, but we already have the bound document).
      const claims = tokenSet.claims();
      const sub = typeof claims.sub === 'string' ? claims.sub : null;
      if (sub === null || sub.length === 0) {
        throw new OidcCallbackError('missing-sub');
      }
      const email = typeof claims.email === 'string' ? claims.email : null;
      const name =
        typeof claims.name === 'string'
          ? claims.name
          : typeof claims.given_name === 'string'
            ? claims.given_name
            : null;
      return {
        subjectId: sub,
        email,
        displayName: name,
      };
    },
  };
}

/**
 * Marker error for callback failures. Carries an `error.code` we DO log;
 * the original IdP error (with potentially user-controlled state) is
 * stashed on `cause` and never hits a log call.
 */
export class OidcCallbackError extends Error {
  readonly code: string;
  constructor(code: string, options?: { cause?: unknown }) {
    super(code, options !== undefined && options.cause !== undefined ? options : undefined);
    this.name = 'OidcCallbackError';
    this.code = code;
  }
}

export function encodeStateCookie(parts: {
  state: string;
  nonce: string;
  codeVerifier: string;
}): string {
  // Each generator output is base64url ([A-Za-z0-9_-]+) so '.' as a
  // delimiter is unambiguous; we still validate on decode.
  return [parts.state, parts.nonce, parts.codeVerifier].join(
    STATE_COOKIE_DELIMITER,
  );
}

export function decodeStateCookie(
  cookieValue: string,
): { state: string; nonce: string; codeVerifier: string } | null {
  const parts = cookieValue.split(STATE_COOKIE_DELIMITER);
  if (parts.length !== 3) return null;
  const [state, nonce, codeVerifier] = parts;
  if (
    state === undefined ||
    nonce === undefined ||
    codeVerifier === undefined ||
    state.length === 0 ||
    nonce.length === 0 ||
    codeVerifier.length === 0
  ) {
    return null;
  }
  if (!isB64Url(state) || !isB64Url(nonce) || !isB64Url(codeVerifier)) {
    return null;
  }
  return { state, nonce, codeVerifier };
}

function isB64Url(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

export const OIDC_STATE_COOKIE = STATE_COOKIE_NAME;
export const OIDC_STATE_COOKIE_MAX_AGE_SECS = STATE_COOKIE_MAX_AGE_SECS;

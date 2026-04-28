// Anthropic Claude Max OAuth — public-client constants.
//
// Sourced from v1 (~/dev/ai/ax/src/host/oauth.ts:14-19) — the same client
// Anthropic already authorizes for ax v1. PKCE means no client secret; the
// client_id is safe to ship in source.
//
// `REDIRECT_URI` is what Anthropic has whitelisted. Don't change the host or
// port — the OAuth flow rejects mismatches. The CLI binds 127.0.0.1:1455
// for the duration of `ax-next credentials login anthropic`.

export const ANTHROPIC_AUTHORIZE_ENDPOINT = 'https://claude.ai/oauth/authorize';
export const ANTHROPIC_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const ANTHROPIC_OAUTH_REDIRECT_URI = 'http://localhost:1455/callback';
export const ANTHROPIC_OAUTH_REDIRECT_PORT = 1455;
export const ANTHROPIC_OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';

// I8 — refresh window. Anthropic access tokens are 1 hour. 5 minutes of
// buffer comfortably exceeds any realistic in-flight request duration.
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

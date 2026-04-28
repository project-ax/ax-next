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
// PUBLIC PKCE client_id (RFC 7636, no client secret). This is the Claude
// Max OAuth client Anthropic has authorized for ax — same value as v1
// (~/dev/ai/ax/src/host/oauth.ts:16). It is NOT a secret; it identifies
// the application to Anthropic's authorization server. The PKCE code
// verifier (per-flow, in-memory only) is what binds it to a specific
// session. Public OAuth clients are designed to ship their client_id in
// source — that's the entire point of PKCE.
//
// Allowlisted in .gitleaks.toml — gitleaks-action's inline `:allow`
// directive isn't honored by the version we run.
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Pinned to 127.0.0.1 (IPv4 literal), NOT 'localhost'. On macOS and some
// linux configs, `localhost` resolves to ::1 first; if the listener binds
// only on IPv4, the browser's IPv6 callback never lands and the login
// flow hangs. Anthropic accepts loopback redirects per RFC 8252, so
// `127.0.0.1` is fine to register. Listener bind site
// (packages/cli/src/commands/credentials.ts) MUST match this exactly.
export const ANTHROPIC_OAUTH_REDIRECT_URI = 'http://127.0.0.1:1455/callback';
export const ANTHROPIC_OAUTH_REDIRECT_PORT = 1455;
export const ANTHROPIC_OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';

// I8 — refresh window. Anthropic access tokens are 1 hour. 5 minutes of
// buffer comfortably exceeds any realistic in-flight request duration.
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

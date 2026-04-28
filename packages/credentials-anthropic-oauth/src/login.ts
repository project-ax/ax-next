// Anthropic OAuth login + exchange — `credentials:login:anthropic-oauth` and
// `credentials:exchange:anthropic-oauth` live here.
//
// Login: build the authorize URL with PKCE challenge + state. Hand the
// codeVerifier and state back to the caller (the CLI command) — it owns the
// callback listener and matches state on redirect (CSRF).
//
// Exchange: POST grant_type=authorization_code with the code + verifier.
// Anthropic's endpoint requires `state` in the exchange body too (per v1 —
// non-standard but the working flow).

import { PluginError } from '@ax/core';
import {
  ANTHROPIC_AUTHORIZE_ENDPOINT,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_REDIRECT_URI,
  ANTHROPIC_OAUTH_SCOPES,
  ANTHROPIC_TOKEN_ENDPOINT,
} from './constants.js';
import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce.js';
import { encodeOauthBlob, makeBlobFromTokens } from './refresh.js';

const PLUGIN_NAME = '@ax/credentials-anthropic-oauth';

export interface LoginInput {
  /**
   * Optional override. Defaults to ANTHROPIC_OAUTH_REDIRECT_URI which is the
   * value Anthropic has whitelisted; use the override at your own risk.
   */
  redirectUri?: string;
}

export interface LoginOutput {
  authorizeUrl: string;
  /**
   * The PKCE verifier. The caller MUST hand this back into :exchange after
   * the redirect lands. Never log it; never persist it.
   */
  codeVerifier: string;
  /**
   * CSRF-bind: the caller MUST verify the redirect's `state` matches this
   * value before calling :exchange.
   */
  state: string;
}

export async function loginAnthropicOauth(input: LoginInput): Promise<LoginOutput> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const redirectUri = input.redirectUri ?? ANTHROPIC_OAUTH_REDIRECT_URI;

  const url = new URL(ANTHROPIC_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ANTHROPIC_OAUTH_SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return { authorizeUrl: url.toString(), codeVerifier, state };
}

export interface ExchangeInput {
  code: string;
  codeVerifier: string;
  state: string;
  redirectUri?: string;
}

export interface ExchangeOutput {
  /** OAuth blob, ready for credentials:set with kind='anthropic-oauth'. */
  payload: Uint8Array;
  /** Unix ms — same as the blob's expiresAt. Caller passes to credentials:set. */
  expiresAt: number;
  /** Always 'anthropic-oauth'. Caller passes to credentials:set. */
  kind: 'anthropic-oauth';
}

export async function exchangeAnthropicOauth(input: ExchangeInput): Promise<ExchangeOutput> {
  const redirectUri = input.redirectUri ?? ANTHROPIC_OAUTH_REDIRECT_URI;
  const res = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: input.code,
      // v1 ports `state` into the exchange body — non-standard but that's
      // what Anthropic's endpoint accepts. Don't drop it; it works.
      state: input.state,
      redirect_uri: redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new PluginError({
      code: 'oauth-exchange-failed',
      plugin: PLUGIN_NAME,
      message: `Anthropic token endpoint returned ${res.status} on exchange`,
    });
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    typeof data.expires_in !== 'number'
  ) {
    throw new PluginError({
      code: 'oauth-exchange-failed',
      plugin: PLUGIN_NAME,
      message: 'Anthropic token endpoint returned an unexpected response shape',
    });
  }
  const blob = makeBlobFromTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  });
  return {
    payload: encodeOauthBlob(blob),
    expiresAt: blob.expiresAt,
    kind: 'anthropic-oauth',
  };
}

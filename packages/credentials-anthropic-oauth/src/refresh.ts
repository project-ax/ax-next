// Anthropic OAuth refresh — `credentials:resolve:anthropic-oauth` lives here.
//
// Blob shape: JSON { accessToken, refreshToken, expiresAt }. expiresAt is unix
// milliseconds — we keep ms (not seconds) for consistency with the rest of the
// envelope contract on the credentials facade.
//
// Refresh policy (I8 + I9):
// - If `expiresAt - now > REFRESH_BUFFER_MS` (5min), return cached access token.
// - Else POST to Anthropic's token endpoint with grant_type=refresh_token. On
//   success, return value + a refreshed blob the facade re-stores. On failure,
//   throw PluginError(oauth-refresh-failed) — proxy will surface as 401, user
//   re-runs `ax-next credentials login anthropic`. NO silent retry.
//
// Endpoint shape comes from v1 (~/dev/ai/ax/src/host/oauth.ts:135-160). v1
// uses JSON body (not application/x-www-form-urlencoded) — preserve that.

import { PluginError } from '@ax/core';
import {
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_TOKEN_ENDPOINT,
  REFRESH_BUFFER_MS,
} from './constants.js';

const PLUGIN_NAME = '@ax/credentials-anthropic-oauth';

// Bound the OAuth token endpoint round-trip. 15s comfortably exceeds
// healthy latency (low-hundreds-of-ms) but stops the CLI from hanging
// indefinitely when Anthropic stalls. AbortController fires the abort;
// fetch rejects; we normalize to a structured PluginError.
const OAUTH_FETCH_TIMEOUT_MS = 15_000;

/**
 * POST a JSON body to the Anthropic token endpoint with a bounded timeout.
 * Normalizes ALL failure modes (transport, abort, parse) into a structured
 * PluginError with the supplied error code. Caller decides between
 * 'oauth-refresh-failed' and 'oauth-exchange-failed'.
 */
export async function postTokenEndpoint(
  body: Record<string, string>,
  errorCode: 'oauth-refresh-failed' | 'oauth-exchange-failed',
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Transport / abort failures merge into the same error code. We do NOT
    // include the underlying error's message — fetch errors occasionally
    // echo URL fragments, and we don't want a refresh_token tail (or the
    // body's client_id) leaking into logs through cause chains.
    throw new PluginError({
      code: errorCode,
      plugin: PLUGIN_NAME,
      message: `Anthropic token endpoint was unreachable (timeout=${OAUTH_FETCH_TIMEOUT_MS}ms)`,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new PluginError({
      code: errorCode,
      plugin: PLUGIN_NAME,
      message: `Anthropic token endpoint returned ${res.status}`,
    });
  }
  try {
    return (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
  } catch {
    throw new PluginError({
      code: errorCode,
      plugin: PLUGIN_NAME,
      message: 'Anthropic token endpoint returned invalid JSON',
    });
  }
}

export interface OauthBlob {
  accessToken: string;
  refreshToken: string;
  /** Unix milliseconds. Same units as `Date.now()`. */
  expiresAt: number;
}

export interface ResolveOutput {
  value: string;
  refreshed?: {
    payload: Uint8Array;
    expiresAt: number;
  };
}

/** Decode an envelope payload that should contain an OauthBlob. */
function decodeBlob(payload: Uint8Array): OauthBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new PluginError({
      code: 'invalid-oauth-blob',
      plugin: PLUGIN_NAME,
      message: 'OAuth blob payload is not valid JSON',
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { accessToken: unknown }).accessToken !== 'string' ||
    typeof (parsed as { refreshToken: unknown }).refreshToken !== 'string' ||
    typeof (parsed as { expiresAt: unknown }).expiresAt !== 'number'
  ) {
    throw new PluginError({
      code: 'invalid-oauth-blob',
      plugin: PLUGIN_NAME,
      message: 'OAuth blob missing accessToken / refreshToken / expiresAt',
    });
  }
  return parsed as OauthBlob;
}

function encodeBlob(blob: OauthBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(blob));
}

export async function resolveAnthropicOauth(input: {
  payload: Uint8Array;
}): Promise<ResolveOutput> {
  const blob = decodeBlob(input.payload);
  if (blob.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    // Token still good — return cached value, no refresh.
    return { value: blob.accessToken };
  }
  const refreshed = await refreshAnthropicTokens(blob.refreshToken);
  const newBlob: OauthBlob = {
    accessToken: refreshed.access_token,
    // Some OAuth servers don't rotate the refresh_token. Fall back to the
    // existing one when the response omits it.
    refreshToken: refreshed.refresh_token ?? blob.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  return {
    value: newBlob.accessToken,
    refreshed: {
      payload: encodeBlob(newBlob),
      expiresAt: newBlob.expiresAt,
    },
  };
}

/**
 * POST grant_type=refresh_token. All failures (transport, timeout, non-2xx,
 * malformed JSON, unexpected shape) surface as PluginError('oauth-refresh-failed').
 */
export async function refreshAnthropicTokens(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const data = await postTokenEndpoint(
    {
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    },
    'oauth-refresh-failed',
  );
  if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
    throw new PluginError({
      code: 'oauth-refresh-failed',
      plugin: PLUGIN_NAME,
      message: 'Anthropic token endpoint returned an unexpected response shape',
    });
  }
  const out: { access_token: string; refresh_token?: string; expires_in: number } = {
    access_token: data.access_token,
    expires_in: data.expires_in,
  };
  if (data.refresh_token !== undefined) out.refresh_token = data.refresh_token;
  return out;
}

/** Build an OauthBlob from a fresh authorization-code exchange response. */
export function makeBlobFromTokens(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}): OauthBlob {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

export function encodeOauthBlob(blob: OauthBlob): Uint8Array {
  return encodeBlob(blob);
}

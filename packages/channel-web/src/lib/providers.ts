/**
 * Providers wire client — typed wrappers around `/admin/credentials/providers*`.
 *
 * This file provides a client for listing available LLM providers and validating
 * provider-specific API keys.
 *
 * Path convention matches `lib/credentials.ts` and `lib/admin.ts`
 * (`/admin/...`, no `/api` prefix). Server-side routes live in
 * `@ax/credentials-admin-routes`.
 *
 * SECURITY NOTE — every endpoint these helpers hit is auth-gated server
 * side. UI hiding is convenience; the gate is on the server.
 *
 * Wire posture:
 *
 *   - `credentials: 'include'` on every call so the auth-oidc cookie
 *     flows. Same as `lib/auth.ts` and `lib/admin.ts`.
 *   - `x-requested-with: ax-admin` on writes so requests pass the
 *     http-server's CSRF guard regardless of how `allowedOrigins` is
 *     configured. Same posture as `lib/admin.ts` and credentials.ts.
 *   - `key` is base64-encoded before POSTing — JSON-clear-text would be
 *     a logs risk. Decode happens server-side in the credentials-admin-routes
 *     handler.
 */

export interface ProviderEntry {
  id: string;
  name: string;
  ref: string;
  models: string[];
  configured: boolean;
}

export interface ProvidersListResult {
  providers: ProviderEntry[];
}

export interface ProviderValidateResult {
  provider: {
    id: string;
    name: string;
    ref: string;
    configured: true;
  };
}

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/**
 * Base64-encode a UTF-8 string. The browser path uses `btoa` over the
 * raw byte sequence; Node test runs (jsdom) provide the same global.
 *
 * Why not pass the raw secret as-is? The server expects base64 — JSON
 * strings can't carry arbitrary bytes (binary in JSON has no canonical
 * encoding), and we want a single shape that handles both api-keys
 * (text) and OAuth blobs (bytes).
 */
function b64(s: string): string {
  const enc = new TextEncoder().encode(s);
  let bin = '';
  for (const b of enc) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * List all available LLM providers and their configuration status.
 * GETs /admin/credentials/providers with credentials: 'include'.
 * Returns the providers array from the response envelope.
 */
export async function listProviders(): Promise<ProviderEntry[]> {
  const res = await fetch('/admin/credentials/providers', {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`list providers: ${res.status}`);
  const body = (await res.json()) as ProvidersListResult;
  return body.providers;
}

/**
 * Validate a provider API key.
 * POSTs to /admin/credentials/providers/:id/validate with base64-encoded key.
 * Returns the full response body on 200.
 * Throws with server's error message on 422.
 * Throws on other non-200 status codes.
 */
export async function validateProviderKey(
  id: string,
  key: string,
): Promise<ProviderValidateResult> {
  const res = await fetch(
    `/admin/credentials/providers/${encodeURIComponent(id)}/validate`,
    {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ key: b64(key) }),
    },
  );

  if (res.ok) {
    return (await res.json()) as ProviderValidateResult;
  }

  if (res.status === 422) {
    const body = (await res.json()) as { error: string };
    throw new Error(body.error);
  }

  throw new Error(`validate provider key: ${res.status}`);
}

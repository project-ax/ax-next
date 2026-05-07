/**
 * Credentials wire client — typed wrappers around `/admin/credentials*`
 * and `/settings/credentials*`.
 *
 * Two namespaces share the file because both panels speak the same
 * envelope shape and CSRF posture, just on different routes:
 *
 *   - `adminCredentials` → `/admin/credentials*` (admin-only; full scope
 *     axis: global / user / agent).
 *   - `myCredentials`    → `/settings/credentials*` (any authed user;
 *     server forces scope='user' + ownerId=actor.id).
 *
 * Path convention matches `lib/admin.ts` (`/admin/...`, no `/api`
 * prefix). Server-side routes live in `@ax/credentials-admin-routes`.
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
 *     configured. Same posture as `lib/admin.ts` and `SessionRow.tsx`.
 *   - `payload` (the actual secret bytes) is base64-encoded before
 *     POSTing — JSON-clear-text would be a logs risk and a wire-shape
 *     ambiguity (binary in JSON has no canonical form). Decode happens
 *     server-side in the credentials-admin-routes handler.
 *
 * `listKinds` is a single endpoint shared between admin and settings
 * panels: the kinds catalog isn't admin-sensitive (just "what flows
 * does this deployment support") and lives at `/admin/credentials/kinds`
 * gated only by `auth:require-user`.
 */

export interface CredentialMeta {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CredentialKind {
  kind: string;
  flow: 'paste' | 'oauth';
}

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

const csrfHeader = { 'x-requested-with': 'ax-admin' } as const;

/**
 * Base64-encode a UTF-8 string. The browser path uses `btoa` over the
 * raw byte sequence; Node test runs (jsdom) provide the same global.
 *
 * Why not pass the raw secret as-is? The server expects base64 — JSON
 * strings can't carry arbitrary bytes (binary in JSON has no canonical
 * encoding), and we want a single shape that handles both api-keys
 * (text) and OAuth blobs (bytes) once we add other kinds.
 */
function b64(s: string): string {
  const enc = new TextEncoder().encode(s);
  let bin = '';
  for (const b of enc) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function listAt(prefix: string): Promise<CredentialMeta[]> {
  const res = await fetch(prefix, { credentials: 'include' });
  if (!res.ok) throw new Error(`list credentials: ${res.status}`);
  const body = (await res.json()) as { credentials: CredentialMeta[] };
  return body.credentials;
}

async function listKinds(): Promise<CredentialKind[]> {
  const res = await fetch('/admin/credentials/kinds', {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`list-kinds: ${res.status}`);
  const body = (await res.json()) as { kinds: CredentialKind[] };
  return body.kinds;
}

// adminCredentials -------------------------------------------------------

export interface AdminCredentialCreateInput {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  payload: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface AdminOauthStartInput {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
}

export interface OauthStartResult {
  pendingId: string;
  authorizeUrl: string;
  instructions: string;
}

export const adminCredentials = {
  list: () => listAt('/admin/credentials'),
  listKinds,

  async create(input: AdminCredentialCreateInput): Promise<CredentialMeta> {
    const body = { ...input, payload: b64(input.payload) };
    const res = await fetch('/admin/credentials', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create credential: ${res.status}`);
    const out = (await res.json()) as { credential: CredentialMeta };
    return out.credential;
  },

  async delete(input: {
    scope: 'global' | 'user' | 'agent';
    ownerId: string | null;
    ref: string;
  }): Promise<void> {
    // The URL placeholder for "no owner" (scope='global') is `_` — JSON
    // null doesn't path-encode. Server-side `_` is translated back to
    // null before the bus call.
    const owner = input.ownerId ?? '_';
    const path = `/admin/credentials/${encodeURIComponent(input.scope)}/${encodeURIComponent(owner)}/${encodeURIComponent(input.ref)}`;
    const res = await fetch(path, {
      method: 'DELETE',
      headers: csrfHeader,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`delete credential: ${res.status}`);
  },

  async oauthStart(input: AdminOauthStartInput): Promise<OauthStartResult> {
    const res = await fetch('/admin/credentials/oauth/start', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`oauth-start: ${res.status}`);
    return (await res.json()) as OauthStartResult;
  },

  async oauthFinish(input: {
    pendingId: string;
    code: string;
  }): Promise<CredentialMeta> {
    const res = await fetch('/admin/credentials/oauth/finish', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`oauth-finish: ${res.status}`);
    const out = (await res.json()) as { credential: CredentialMeta };
    return out.credential;
  },
};

// myCredentials ----------------------------------------------------------

export interface MyCredentialCreateInput {
  ref: string;
  kind: string;
  payload: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface MyOauthStartInput {
  ref: string;
  kind: string;
}

export const myCredentials = {
  list: () => listAt('/settings/credentials'),
  listKinds,

  async create(input: MyCredentialCreateInput): Promise<CredentialMeta> {
    const body = { ...input, payload: b64(input.payload) };
    const res = await fetch('/settings/credentials', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create credential: ${res.status}`);
    const out = (await res.json()) as { credential: CredentialMeta };
    return out.credential;
  },

  async delete(ref: string): Promise<void> {
    const res = await fetch(
      `/settings/credentials/${encodeURIComponent(ref)}`,
      {
        method: 'DELETE',
        headers: csrfHeader,
        credentials: 'include',
      },
    );
    if (!res.ok) throw new Error(`delete credential: ${res.status}`);
  },

  async oauthStart(input: MyOauthStartInput): Promise<OauthStartResult> {
    const res = await fetch('/settings/credentials/oauth/start', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`oauth-start: ${res.status}`);
    return (await res.json()) as OauthStartResult;
  },

  async oauthFinish(input: {
    pendingId: string;
    code: string;
  }): Promise<CredentialMeta> {
    const res = await fetch('/settings/credentials/oauth/finish', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`oauth-finish: ${res.status}`);
    const out = (await res.json()) as { credential: CredentialMeta };
    return out.credential;
  },
};

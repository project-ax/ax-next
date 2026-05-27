import type { Destination } from '@ax/credentials';

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
 *   - `credentials: 'include'` on every call so the auth-better cookie
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
};

// myCredentials ----------------------------------------------------------

export const myCredentials = {
  list: () => listAt('/settings/credentials'),
  listKinds,
};

// Destination credential helpers -----------------------------------------

/**
 * Compute the canonical ref string for a Destination.
 *
 * Mirrors `refForDestination` from `@ax/credentials` without a runtime
 * cross-plugin import (CLAUDE.md invariant 2 — plugins communicate via
 * the hook bus; runtime cross-plugin imports are forbidden). This is a
 * pure string computation with no side effects.
 */
export function refForDestination(dest: Destination): string {
  switch (dest.kind) {
    case 'provider':
      return `provider:${dest.provider}`;
    case 'skill-slot':
      return `skill:${dest.skillId}:${dest.slot}`;
    case 'mcp-env':
      return `mcp:${dest.serverId}:env:${dest.envName}`;
    case 'mcp-header':
      return `mcp:${dest.serverId}:header:${dest.headerName}`;
    case 'routine-hmac':
      return `routine:${dest.agentId}:${dest.routinePath}:hmac`;
    case 'account':
      return `account:${dest.service}`;
  }
}

export async function setDestinationCredential(args: {
  destination: Destination;
  slot: { kind: 'api-key' };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
  payload: string;
}): Promise<void> {
  const base = args.scope.scope === 'user' ? '/settings' : '/admin';
  const url = `${base}/destinations/${args.destination.kind}/credential`;
  const body = {
    destination: args.destination,
    scope: args.scope.scope,
    ownerId: args.scope.ownerId,
    kind: args.slot.kind,
    payloadB64: b64(args.payload),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Reactive-wall host grant (TASK-37). POSTs the blocked host + its opaque
 * sessionId to the user-scoped, CSRF-gated `/api/chat/allow-host` route, which
 * calls the host-internal `proxy:add-host` service hook to widen the LIVE
 * session allowlist — no re-spawn. The route builds the caller identity from
 * the auth cookie and re-validates session ownership, so the browser-supplied
 * sessionId is echoed for routing, never trusted for authorization. Carries no
 * secret. Mirrors `setDestinationCredential`'s CSRF posture
 * (`x-requested-with: ax-admin`, `credentials: 'include'`).
 */
export async function grantHost(input: {
  sessionId: string;
  host: string;
  /** "Always for this agent" → durably persist a per-(user, agent) grant (TASK-44). */
  persist?: boolean;
}): Promise<void> {
  const res = await fetch('/api/chat/allow-host', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`allow-host failed: ${res.status}`);
}

export async function clearDestinationCredential(args: {
  destination: Destination;
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
}): Promise<void> {
  const base = args.scope.scope === 'user' ? '/settings' : '/admin';
  const url = `${base}/destinations/${args.destination.kind}/credential`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({
      destination: args.destination,
      scope: args.scope.scope,
      ownerId: args.scope.ownerId,
    }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

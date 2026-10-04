import { HttpError, httpFetch } from './http';
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
 *     configured. Same posture as `lib/admin.ts`.
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
    case 'mcp-header':
      return `mcp:${dest.serverId}:header:${dest.headerName}`;
    case 'routine-hmac':
      return `routine:${dest.agentId}:${dest.routinePath}:hmac`;
    case 'account':
      // TASK-124 — adaptive per-slot ref (mirrors @ax/credentials/refs.ts). A
      // multi-slot connector supplies `slot` so each slot addresses a distinct
      // vault row; a single-slot / bare account key omits it and keeps the
      // collapsed `account:<service>` ref (back-compat by construction).
      return dest.slot !== undefined
        ? `account:${dest.service}:${dest.slot}`
        : `account:${dest.service}`;
  }
}

const KEY_VALIDATION_FAILED = 'We could not confirm this key. Check it and try again.';
const openRouterValidationMessages = new Set([
  'OpenRouter rejected that key. Double-check you copied the whole thing from openrouter.ai/keys.',
  'We could not reach OpenRouter to confirm the key. Check network access and try again.',
  'OpenRouter did not answer within 10 seconds, so we could not confirm the key. Worth trying again in a moment.',
]);
const anthropicValidationMessages = new Map([
  ['key-rejected', 'Anthropic rejected that key. Check that you copied the whole API key.'],
  ['validation-timeout', 'Anthropic did not answer in time to confirm the key. Try again in a moment.'],
  ['validation-failed', 'We could not confirm this key with Anthropic. Try again in a moment.'],
]);

async function keyValidationMessage(res: Response, destination: Destination): Promise<string> {
  // Validators are plugin-owned. Accept only known reasons; an arbitrary
  // response could echo a secret or contain markup, so neither render nor log it.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return KEY_VALIDATION_FAILED;
  }
  if (destination.kind !== 'provider' || body === null || typeof body !== 'object') {
    return KEY_VALIDATION_FAILED;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'string') return KEY_VALIDATION_FAILED;
  if (destination.provider === 'openrouter') {
    if (openRouterValidationMessages.has(error)) return error;
    if (/^OpenRouter answered [1-5]\d{2}, so we could not confirm the key\. Worth trying again in a moment\.$/.test(error)) {
      return 'OpenRouter could not confirm this key right now. Try again in a moment.';
    }
  }
  if (destination.provider === 'anthropic') {
    return anthropicValidationMessages.get(error) ?? KEY_VALIDATION_FAILED;
  }
  return KEY_VALIDATION_FAILED;
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
    // Provider keys are tokens carried in HTTP headers. Pasted surrounding
    // whitespace (especially a newline) would make even a valid key fail.
    // Other destinations may legitimately use whitespace in a secret.
    payloadB64: b64(args.destination.kind === 'provider' ? args.payload.trim() : args.payload),
  };
  let res: Response;
  try {
    res = await httpFetch(url, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify(body),
    });
  } catch {
    // A transport exception may carry request details, including the secret.
    throw new HttpError(url, 0);
  }
  if (!res.ok) {
    console.warn(`[credentials] ${url} → ${res.status}`);
    throw new HttpError(url, res.status, res.status === 422
      ? await keyValidationMessage(res, args.destination)
      : undefined);
  }
}

/**
 * Delete one destination's stored secret at the given scope. Mirrors
 * `setDestinationCredential`'s routing: `user` scope goes to the settings route
 * (the server pins the owner to the signed-in person), anything else to the
 * admin-only route. A secret was never in this request, and the failure copy
 * never carries one either.
 */
export async function deleteDestinationCredential(args: {
  destination: Destination;
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
}): Promise<void> {
  const base = args.scope.scope === 'user' ? '/settings' : '/admin';
  const url = `${base}/destinations/${args.destination.kind}/credential`;
  let res: Response;
  try {
    res = await httpFetch(url, {
      method: 'DELETE',
      headers: writeHeaders,
      body: JSON.stringify({
        destination: args.destination,
        scope: args.scope.scope,
        ownerId: args.scope.ownerId,
      }),
    });
  } catch {
    throw new HttpError(url, 0);
  }
  if (!res.ok) {
    console.warn(`[credentials] ${url} → ${res.status}`);
    throw new HttpError(url, res.status);
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
  const res = await httpFetch('/api/chat/allow-host', {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new HttpError('/api/chat/allow-host', res.status);
}

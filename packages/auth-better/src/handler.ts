import { betterAuth } from 'better-auth';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from './migrations.js';

/**
 * Provider-row shape consumed by the handler factory. Mirrors the row
 * stored in `auth_providers` after decryption — `clientSecret` is the
 * decrypted plaintext, never the envelope. Callers (Task 1.5) are
 * responsible for unwrapping ciphertext before reaching this layer.
 *
 * `oidc` here is the generic-OAuth shape (any standards-compliant OIDC
 * provider with a discovery URL). Built-in better-auth providers like
 * `google` and `github` get first-class entries; `oidc` is wired through
 * a generic plugin in Task 1.4 — for this task it's just a passthrough
 * field on the social-providers map.
 */
export interface ProviderRow {
  kind: 'google' | 'github' | 'oidc';
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
}

export interface HandlerInput {
  database: Kysely<AuthBetterDatabase>;
  providers: ProviderRow[];
  /**
   * Origins better-auth treats as trusted for sign-in / OAuth callback /
   * CSRF protection. When undefined, falls back to `['*']` for
   * test/dev-friendliness — production callers SHOULD pass a concrete
   * allow-list. Plumbed from `AuthBetterConfig.trustedOrigins`.
   */
  trustedOrigins?: string[];
}

/**
 * The wrapper exposes a stable handle that the plugin holds for the
 * lifetime of the kernel; only the underlying handler instance swaps.
 * This is what gives us the runtime-swappable provider seam (I10) —
 * a provider CRUD edit calls `rebuild()` instead of bouncing the
 * process.
 */
export interface HandlerHandle {
  current(): (req: Request) => Promise<Response>;
  rebuild(input: HandlerInput): void;
}

export function createBetterAuthHandler(input: HandlerInput): HandlerHandle {
  let instance = build(input);
  return {
    current: () => instance,
    rebuild: (next: HandlerInput) => {
      // Build the new one BEFORE replacing — if construction throws,
      // the old instance keeps serving. This covers I10's "no kernel
      // bounce on provider edit" guarantee even when an admin saves a
      // typo'd config: requests in flight don't suddenly hit a broken
      // handler.
      try {
        const built = build(next);
        instance = built;
      } catch (err) {
        // Log and keep the old instance live. Phase 1.5 will surface
        // this back to the admin UI via the CRUD response so the user
        // sees the error inline; for now `console.error` is enough
        // because no one is calling rebuild() until that task lands.
        console.error(
          '[auth-better] handler rebuild failed; keeping previous instance',
          err,
        );
      }
    },
  };
}

function build(input: HandlerInput): (req: Request) => Promise<Response> {
  // better-auth's `socialProviders` is a typed map keyed by built-in
  // provider names (google, github, …). We populate the keys we know;
  // `oidc` is not a built-in and gets wired through a generic plugin
  // in Task 1.4. For this task we erase to `Record<string, any>` so
  // the plan's three-kind switch compiles cleanly today and adapts
  // when generic-OAuth lands.
  const socialProviders: Record<string, unknown> = {};
  for (const p of input.providers) {
    if (p.kind === 'google') {
      socialProviders.google = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
      };
    } else if (p.kind === 'github') {
      socialProviders.github = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
      };
    } else if (p.kind === 'oidc') {
      // Placeholder — in Task 1.4 this becomes a `genericOAuth({...})`
      // plugin entry, not a socialProviders key. Leaving the field in
      // the map is harmless because better-auth ignores unknown keys.
      socialProviders.oidc = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        discoveryUrl: p.discoveryUrl,
      };
    }
  }

  const auth = betterAuth({
    // better-auth wants a `{ db, type }` wrapper when handed a Kysely
    // instance directly — passing the bare Kysely is the dialect path,
    // which we don't have here.
    database: { db: input.database, type: 'postgres' },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    // We mount @ax/http-server routes at `/auth/*` (sibling of `/admin/*`,
    // matching the v1 auth-oidc layout). Better-auth's default basePath is
    // `/api/auth`; override so its internal router agrees with where we
    // forward requests.
    basePath: '/auth',
    // The OS-assigned port at boot can move between rebuilds; rather
    // than thread a host into every rebuild, let better-auth resolve
    // baseURL from the request's `Host` header (its `resolveBaseURL`
    // does this when `baseURL` is undefined). `trustedOrigins` defaults
    // to `['*']` so any test-time host:port combo is accepted —
    // production hosts that mount this plugin SHOULD pass a concrete
    // allow-list via `AuthBetterConfig.trustedOrigins` (e.g.,
    // ['https://ax.example.com']). The `@ax/preset-k8s` wires this from
    // AX_PUBLIC_BASE_URL when set.
    trustedOrigins: input.trustedOrigins ?? ['*'],
    socialProviders: socialProviders as Parameters<typeof betterAuth>[0]['socialProviders'],
    session: { expiresIn: 7 * 24 * 60 * 60 },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user' },
      },
    },
  });

  // better-auth eagerly resolves its database adapter inside the
  // returned `$context` promise. If construction is otherwise valid
  // but the adapter init fails (e.g., the DB is unreachable at the
  // moment of rebuild), the promise rejects with no listener attached,
  // which surfaces as an unhandled rejection. Attach a no-op catch so
  // the wrapper holds the contract: "rebuild() never crashes the
  // process". The actual failure surfaces lazily at the first request,
  // where `handler()` awaits `$context` and the rejection re-throws —
  // exactly where we want it (per-request 500 instead of process exit).
  auth.$context.catch((err) => {
    console.error('[auth-better] adapter init deferred failure', err);
  });

  return auth.handler;
}

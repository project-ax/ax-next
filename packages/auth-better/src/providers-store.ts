import type { Kysely } from 'kysely';
import { PluginError } from '@ax/core';
import type { AuthBetterDatabase } from './migrations.js';

const PLUGIN_NAME = '@ax/auth-better';

/**
 * The shape returned by `list()`. `clientSecret` is the DECRYPTED plaintext
 * — the store unwraps the envelope on the way out so consumers (the
 * handler-rebuild path, primarily) don't have to know about envelopes.
 *
 * NEVER returned over the HTTP wire — the admin route is responsible for
 * stripping `clientSecret` before responding to a `GET /admin/auth/providers`
 * request.
 */
export interface StoredProvider {
  kind: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string | null;
  allowedDomains: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Crypto seam: the store knows how to wrap/unwrap an envelope, but doesn't
 * know HOW the envelope is built. Plugin.ts constructs this from the
 * `credentials:envelope-encrypt` / `-decrypt` service hooks; an alternate
 * impl could plug in HSM-backed encryption with the same shape.
 *
 * Boundary: the type uses `plaintext: string` / `ciphertext: Uint8Array`.
 * No backend vocabulary leaks (no aes/iv/kms_arn).
 */
export interface CredentialsEnvelope {
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<string>;
}

/**
 * Bounded validation for untrusted CRUD input. Provider config arrives from
 * the admin UI — the user is authenticated (admin), but field-level validation
 * still applies (Invariant I5).
 */
const ALLOWED_KINDS: ReadonlySet<string> = new Set(['google', 'github', 'oidc']);
const MAX_CLIENT_ID_LEN = 512;
const MAX_CLIENT_SECRET_LEN = 1024;
const MAX_DISCOVERY_URL_LEN = 2048;
const MAX_ALLOWED_DOMAINS_LEN = 4096;

export interface UpsertProviderInput {
  kind: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  allowedDomains?: string;
}

export interface ProvidersStore {
  /** All rows (including disabled). Secrets DECRYPTED. */
  list(): Promise<StoredProvider[]>;
  /**
   * Insert or update a provider. On insert, `enabled` defaults to true. On
   * update, `enabled` is left UNCHANGED (admin may have intentionally
   * disabled the provider, then is updating credentials — don't surprise
   * them by re-enabling).
   */
  upsert(input: UpsertProviderInput): Promise<void>;
  /** Toggle the `enabled` flag without touching credentials. */
  setEnabled(kind: string, enabled: boolean): Promise<void>;
  /** Remove a provider entirely. Idempotent — deleting a missing kind is fine. */
  delete(kind: string): Promise<void>;
}

export function createProvidersStore(
  db: Kysely<AuthBetterDatabase>,
  envelope: CredentialsEnvelope,
): ProvidersStore {
  return {
    async list(): Promise<StoredProvider[]> {
      const rows = await db
        .selectFrom('auth_providers')
        .selectAll()
        .execute();
      const out: StoredProvider[] = [];
      for (const r of rows) {
        const clientSecret = await envelope.decrypt(r.client_secret_encrypted);
        out.push({
          kind: r.kind,
          clientId: r.client_id,
          clientSecret,
          discoveryUrl: r.discovery_url,
          allowedDomains: r.allowed_domains,
          enabled: r.enabled,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        });
      }
      return out;
    },

    async upsert(input: UpsertProviderInput): Promise<void> {
      validateKind(input.kind);
      validateClientId(input.clientId);
      validateClientSecret(input.clientSecret);
      validateDiscoveryUrl(input.discoveryUrl);
      validateAllowedDomains(input.allowedDomains);

      const ciphertext = await envelope.encrypt(input.clientSecret);
      const now = new Date();
      // Upsert via ON CONFLICT (kind). On conflict we update credentials
      // and timestamps but DO NOT touch `enabled` — the admin's
      // explicit-disable state is preserved through credential rotations.
      await db
        .insertInto('auth_providers')
        .values({
          kind: input.kind,
          client_id: input.clientId,
          client_secret_encrypted: ciphertext,
          discovery_url: input.discoveryUrl ?? null,
          allowed_domains: input.allowedDomains ?? null,
          enabled: true,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column('kind').doUpdateSet({
            client_id: input.clientId,
            client_secret_encrypted: ciphertext,
            discovery_url: input.discoveryUrl ?? null,
            allowed_domains: input.allowedDomains ?? null,
            updated_at: now,
          }),
        )
        .execute();
    },

    async setEnabled(kind: string, enabled: boolean): Promise<void> {
      validateKind(kind);
      if (typeof enabled !== 'boolean') {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          message: 'enabled must be a boolean',
        });
      }
      await db
        .updateTable('auth_providers')
        .set({ enabled, updated_at: new Date() })
        .where('kind', '=', kind)
        .execute();
    },

    async delete(kind: string): Promise<void> {
      validateKind(kind);
      await db.deleteFrom('auth_providers').where('kind', '=', kind).execute();
    },
  };
}

// ---------------------------------------------------------------------------
// Validators — bounded length + character-class checks. Errors are
// PluginError(invalid-payload) so the admin route translates them to 400.
// No raw-secret echoes in error messages (security: a typo'd secret should
// never round-trip through a 4xx response body or a stderr log).
// ---------------------------------------------------------------------------

function validateKind(kind: unknown): void {
  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `kind must be one of ${[...ALLOWED_KINDS].join(', ')}`,
    });
  }
}

function validateClientId(v: unknown): void {
  if (typeof v !== 'string' || v.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'clientId must be a non-empty string',
    });
  }
  if (v.length > MAX_CLIENT_ID_LEN) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `clientId exceeds ${MAX_CLIENT_ID_LEN} characters`,
    });
  }
}

function validateClientSecret(v: unknown): void {
  // Match validateClientId shape, but DELIBERATELY no echo of the value
  // in the error message — even validation failures must not write a raw
  // secret to logs.
  if (typeof v !== 'string' || v.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'clientSecret must be a non-empty string',
    });
  }
  if (v.length > MAX_CLIENT_SECRET_LEN) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `clientSecret exceeds ${MAX_CLIENT_SECRET_LEN} characters`,
    });
  }
}

function validateDiscoveryUrl(v: unknown): void {
  if (v === undefined) return;
  if (typeof v !== 'string' || v.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'discoveryUrl must be a non-empty string when provided',
    });
  }
  if (v.length > MAX_DISCOVERY_URL_LEN) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `discoveryUrl exceeds ${MAX_DISCOVERY_URL_LEN} characters`,
    });
  }
  // Cheap shape check — must parse as a URL with http(s) scheme.
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('non-http scheme');
    }
  } catch {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'discoveryUrl must be an http(s) URL',
    });
  }
}

function validateAllowedDomains(v: unknown): void {
  if (v === undefined) return;
  if (typeof v !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'allowedDomains must be a string when provided',
    });
  }
  if (v.length > MAX_ALLOWED_DOMAINS_LEN) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `allowedDomains exceeds ${MAX_ALLOWED_DOMAINS_LEN} characters`,
    });
  }
}

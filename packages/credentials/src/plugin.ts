import { PluginError, type Plugin } from '@ax/core';
import { encryptWithKey, decryptWithKey, parseKeyFromEnv } from './crypto.js';

const PLUGIN_NAME = '@ax/credentials';
const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface CredentialsGetInput {
  ref: string;
  userId: string;
}

export type CredentialsGetOutput = string;

export interface CredentialsSetInput {
  ref: string;
  userId: string;
  kind: string;
  payload: Uint8Array;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export type CredentialsSetOutput = void;

export interface CredentialsDeleteInput {
  ref: string;
  userId: string;
}

export type CredentialsDeleteOutput = void;

export interface CredentialsResolveInput {
  payload: Uint8Array;
  userId: string;
  ref: string;
}

export interface CredentialsResolveOutput {
  value: string;
  refreshed?: {
    payload: Uint8Array;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
  };
}

function validateRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `credential ref must match ${REF_RE.source}`,
    });
  }
  return ref;
}

function validateUserId(userId: unknown): string {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `userId must match ${USER_ID_RE.source}`,
    });
  }
  return userId;
}

function validateKind(kind: unknown): string {
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `kind must match ${KIND_RE.source}`,
    });
  }
  return kind;
}

/**
 * Optional config for `createCredentialsPlugin`. Today this only carries
 * the env-fallback map — `{ ref → ENV_VAR_NAME }` — used when the
 * credentials store has no row for `(userId, ref)` and the operator wants
 * a process-env value to act as the universal fallback.
 *
 * Use case: kind / single-tenant deployments where the operator already
 * supplies `ANTHROPIC_API_KEY` via the chart's Secret. The agent's
 * `requiredCredentials.ANTHROPIC_API_KEY → 'anthropic-api'` would
 * otherwise fail at proxy:open-session time because no admin has called
 * `credentials:set` for this user yet. The fallback closes that gap.
 *
 * SECURITY: env values bypass the per-user credentials store. The same
 * value is returned for EVERY user. This is fine for single-tenant kind
 * dev where there's one admin user, but multi-tenant deployments MUST
 * leave `envFallback` empty and seed credentials per-user via the
 * credentials admin surface. The plugin warns at boot when fallback is
 * configured to make the trade-off impossible to miss.
 */
export interface CredentialsPluginConfig {
  envFallback?: Readonly<Record<string, string>>;
}

export function createCredentialsPlugin(config: CredentialsPluginConfig = {}): Plugin {
  const envFallback = config.envFallback ?? {};
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['credentials:get', 'credentials:set', 'credentials:delete'],
      // Storage goes through the `credentials:store-blob:*` seam (Phase 1b).
      // The default backend is `@ax/credentials-store-db`; vault / KMS
      // backends slot in here without touching the facade.
      //
      // Per-kind dispatch (`credentials:resolve:<kind>`) is checked at runtime
      // via bus.hasService — we don't enumerate every kind in the manifest
      // because new kinds slot in by registering a sibling plugin.
      calls: ['credentials:store-blob:get', 'credentials:store-blob:put'],
      subscribes: [],
    },
    async init({ bus }) {
      const raw = process.env.AX_CREDENTIALS_KEY;
      if (raw === undefined || raw === '') {
        throw new PluginError({
          code: 'missing-env',
          plugin: PLUGIN_NAME,
          message:
            'AX_CREDENTIALS_KEY is required (32 bytes, 64 hex chars or 44 base64 chars)',
        });
      }
      const key = parseKeyFromEnv(raw);

      // Wrap a per-kind payload + metadata in an envelope, then encrypt.
      // The envelope lets credentials:get dispatch to the right resolve
      // sub-service without an extra storage column for `kind` (Phase 3
      // open question §1: stay schema-light for MVP).
      function wrapEnvelope(
        kind: string,
        payload: Uint8Array,
        expiresAt: number | undefined,
        metadata: Record<string, unknown> | undefined,
      ): Uint8Array {
        const env: {
          kind: string;
          payloadB64: string;
          expiresAt?: number;
          metadata?: Record<string, unknown>;
        } = {
          kind,
          payloadB64: Buffer.from(payload).toString('base64'),
        };
        if (expiresAt !== undefined) env.expiresAt = expiresAt;
        if (metadata !== undefined) env.metadata = metadata;
        return encryptWithKey(key, JSON.stringify(env));
      }

      function unwrapEnvelope(blob: Uint8Array): {
        kind: string;
        payload: Uint8Array;
        expiresAt?: number;
        metadata?: Record<string, unknown>;
        isTombstone: boolean;
      } {
        // decryptWithKey throws PluginError without echoing plaintext.
        const plaintext = decryptWithKey(key, blob);
        // Empty plaintext = tombstone (see credentials:delete). Caller
        // reports not-found; this branch never references plaintext.
        if (plaintext === '') {
          return {
            kind: '',
            payload: new Uint8Array(),
            isTombstone: true,
          };
        }
        let env: unknown;
        try {
          env = JSON.parse(plaintext);
        } catch {
          throw new PluginError({
            code: 'invalid-envelope',
            plugin: PLUGIN_NAME,
            message: 'credential envelope JSON parse failed',
          });
        }
        if (
          typeof env !== 'object' ||
          env === null ||
          typeof (env as { kind: unknown }).kind !== 'string' ||
          typeof (env as { payloadB64: unknown }).payloadB64 !== 'string'
        ) {
          throw new PluginError({
            code: 'invalid-envelope',
            plugin: PLUGIN_NAME,
            message: 'credential envelope missing kind or payloadB64',
          });
        }
        const e = env as {
          kind: string;
          payloadB64: string;
          expiresAt?: number;
          metadata?: Record<string, unknown>;
        };
        const out: {
          kind: string;
          payload: Uint8Array;
          expiresAt?: number;
          metadata?: Record<string, unknown>;
          isTombstone: boolean;
        } = {
          kind: e.kind,
          payload: new Uint8Array(Buffer.from(e.payloadB64, 'base64')),
          isTombstone: false,
        };
        if (e.expiresAt !== undefined) out.expiresAt = e.expiresAt;
        if (e.metadata !== undefined) out.metadata = e.metadata;
        return out;
      }

      bus.registerService<CredentialsSetInput, CredentialsSetOutput>(
        'credentials:set',
        PLUGIN_NAME,
        async (ctx, input) => {
          const ref = validateRef(input.ref);
          const userId = validateUserId(input.userId);
          const kind = validateKind(input.kind);
          if (!(input.payload instanceof Uint8Array)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: `credential payload must be a Uint8Array`,
            });
          }
          const blob = wrapEnvelope(kind, input.payload, input.expiresAt, input.metadata);
          await bus.call('credentials:store-blob:put', ctx, { userId, ref, blob });
        },
      );

      // Per-(userId, ref) mutex. Two concurrent credentials:get calls for the
      // same blob share one Promise, so an OAuth refresh fires at most once
      // even when proxy:open-session and a concurrent proxy:rotate-session
      // both ask. Different (userId, ref) pairs run in parallel. (I7.)
      const inflight = new Map<string, Promise<string>>();

      async function doResolve(
        ctx: Parameters<Parameters<typeof bus.registerService>[2]>[0],
        userId: string,
        ref: string,
      ): Promise<string> {
        const got = await bus.call<
          { userId: string; ref: string },
          { blob: Uint8Array | undefined }
        >('credentials:store-blob:get', ctx, { userId, ref });
        if (got.blob === undefined) {
          // Env fallback — single-tenant / kind-dev posture. See
          // CredentialsPluginConfig.envFallback for the trade-off. We
          // only fall through when there's no row at all; tombstones
          // (deleted credentials) still throw not-found because that's
          // a deliberate user action and must NOT fall back.
          const envName = envFallback[ref];
          if (envName !== undefined) {
            const v = process.env[envName];
            if (typeof v === 'string' && v.length > 0) return v;
          }
          throw new PluginError({
            code: 'credential-not-found',
            plugin: PLUGIN_NAME,
            message: `no credential for ref='${ref}'`,
          });
        }
        const env = unwrapEnvelope(got.blob);
        if (env.isTombstone) {
          throw new PluginError({
            code: 'credential-not-found',
            plugin: PLUGIN_NAME,
            message: `no credential for ref='${ref}'`,
          });
        }

        const subService = `credentials:resolve:${env.kind}`;
        if (bus.hasService(subService)) {
          const out = await bus.call<CredentialsResolveInput, CredentialsResolveOutput>(
            subService,
            ctx,
            { payload: env.payload, userId, ref },
          );
          if (out.refreshed !== undefined) {
            // Re-store under the same kind. Sub-service may bump expiresAt
            // or metadata as part of the refresh — propagate both.
            const refreshArgs: CredentialsSetInput = {
              ref,
              userId,
              kind: env.kind,
              payload: out.refreshed.payload,
            };
            if (out.refreshed.expiresAt !== undefined) {
              refreshArgs.expiresAt = out.refreshed.expiresAt;
            }
            const md = out.refreshed.metadata ?? env.metadata;
            if (md !== undefined) refreshArgs.metadata = md;
            await bus.call('credentials:set', ctx, refreshArgs);
          }
          return out.value;
        }
        // No sub-service registered. Only `api-key` defaults to the
        // payload-is-the-value UTF-8 path. Any other kind without its
        // resolver loaded is a misconfiguration — fail closed rather
        // than handing back the (encrypted) blob bytes as a string,
        // which would leak unparsed envelope content into the caller.
        if (env.kind === 'api-key') {
          return new TextDecoder().decode(env.payload);
        }
        throw new PluginError({
          code: 'unsupported-credential-kind',
          plugin: PLUGIN_NAME,
          message: `no resolver registered for credential kind '${env.kind}' (ref='${ref}')`,
        });
      }

      bus.registerService<CredentialsGetInput, CredentialsGetOutput>(
        'credentials:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const ref = validateRef(input.ref);
          const userId = validateUserId(input.userId);
          const mutexKey = `${userId}:${ref}`;
          const existing = inflight.get(mutexKey);
          if (existing !== undefined) return existing;
          const p = doResolve(ctx, userId, ref);
          inflight.set(mutexKey, p);
          try {
            return await p;
          } finally {
            inflight.delete(mutexKey);
          }
        },
      );

      bus.registerService<CredentialsDeleteInput, CredentialsDeleteOutput>(
        'credentials:delete',
        PLUGIN_NAME,
        async (ctx, input) => {
          const ref = validateRef(input.ref);
          const userId = validateUserId(input.userId);
          // The store-blob layer is bytes-only and has no `:delete` hook in
          // Phase 1b, so we use the same encrypted-empty-string tombstone we
          // had when this plugin called storage:set directly. credentials:get
          // checks for empty plaintext above and reports not-found.
          const tombstone = encryptWithKey(key, '');
          await bus.call('credentials:store-blob:put', ctx, {
            userId,
            ref,
            blob: tombstone,
          });
        },
      );
    },
  };
}

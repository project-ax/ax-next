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

export function createCredentialsPlugin(): Plugin {
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

      bus.registerService<CredentialsGetInput, CredentialsGetOutput>(
        'credentials:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const ref = validateRef(input.ref);
          const userId = validateUserId(input.userId);
          const got = await bus.call<
            { userId: string; ref: string },
            { blob: Uint8Array | undefined }
          >('credentials:store-blob:get', ctx, { userId, ref });
          if (got.blob === undefined) {
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
          // No sub-service registered — payload is the value (UTF-8 bytes).
          // This is the api-key path: payload bytes ARE the secret string.
          return new TextDecoder().decode(env.payload);
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

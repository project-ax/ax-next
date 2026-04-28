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
          // Task 3 will wrap an envelope here. For now: stash payload as-is
          // (still encrypted) so behavior matches Phase 1b until the dispatcher
          // lands. This is the intentional mid-cut state called out by I12.
          const plaintext = Buffer.from(input.payload).toString('utf8');
          const blob = encryptWithKey(key, plaintext);
          await bus.call('credentials:store-blob:put', ctx, { userId, ref, blob });
          void kind;
          void input.expiresAt;
          void input.metadata;
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
          // decryptWithKey throws PluginError without echoing plaintext.
          const value = decryptWithKey(key, got.blob);
          // Empty plaintext = tombstone (see credentials:delete). Treat as
          // not-found. The facade still owns this convention because the
          // store-blob layer is bytes-only — a future store-blob:delete
          // will let us drop this check.
          if (value === '') {
            throw new PluginError({
              code: 'credential-not-found',
              plugin: PLUGIN_NAME,
              message: `no credential for ref='${ref}'`,
            });
          }
          return value;
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

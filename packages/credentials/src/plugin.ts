import { PluginError, type Plugin } from '@ax/core';
import { encryptWithKey, decryptWithKey, parseKeyFromEnv } from './crypto.js';

const PLUGIN_NAME = '@ax/credentials';
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

function validateId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `credential id must match ${ID_RE.source}`,
    });
  }
  return id;
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

      bus.registerService<{ id: string; value: string }, void>(
        'credentials:set',
        PLUGIN_NAME,
        async (ctx, input) => {
          const id = validateId(input.id);
          if (typeof input.value !== 'string') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: `credential value must be a string`,
            });
          }
          const blob = encryptWithKey(key, input.value);
          await bus.call('credentials:store-blob:put', ctx, { id, blob });
        },
      );

      bus.registerService<{ id: string }, { value: string }>(
        'credentials:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const id = validateId(input.id);
          const got = await bus.call<{ id: string }, { blob: Uint8Array | undefined }>(
            'credentials:store-blob:get',
            ctx,
            { id },
          );
          if (got.blob === undefined) {
            throw new PluginError({
              code: 'credential-not-found',
              plugin: PLUGIN_NAME,
              message: `no credential with id '${id}'`,
            });
          }
          // decryptWithKey throws PluginError without echoing plaintext.
          const value = decryptWithKey(key, got.blob);
          // Empty plaintext = tombstone (see credentials:delete). Treat as
          // not-found. The facade still owns this convention because the
          // store-blob layer is bytes-only — a future store-blob:delete
          // (Phase 3) will let us drop this check.
          if (value === '') {
            throw new PluginError({
              code: 'credential-not-found',
              plugin: PLUGIN_NAME,
              message: `no credential with id '${id}'`,
            });
          }
          return { value };
        },
      );

      bus.registerService<{ id: string }, void>(
        'credentials:delete',
        PLUGIN_NAME,
        async (ctx, input) => {
          const id = validateId(input.id);
          // The store-blob layer is bytes-only and has no `:delete` hook in
          // Phase 1b, so we use the same encrypted-empty-string tombstone we
          // had when this plugin called storage:set directly. credentials:get
          // checks for empty plaintext above and reports not-found.
          const tombstone = encryptWithKey(key, '');
          await bus.call('credentials:store-blob:put', ctx, { id, blob: tombstone });
        },
      );
    },
  };
}

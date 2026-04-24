import { PluginError, type Plugin } from '@ax/core';
import { encryptWithKey, decryptWithKey, parseKeyFromEnv } from './crypto.js';

const PLUGIN_NAME = '@ax/credentials';
const CREDENTIAL_KEY_PREFIX = 'credential:';
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

function storageKey(id: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${id}`;
}

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
      calls: ['storage:get', 'storage:set'],
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
          await bus.call('storage:set', ctx, { key: storageKey(id), value: blob });
        },
      );

      bus.registerService<{ id: string }, { value: string }>(
        'credentials:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const id = validateId(input.id);
          const got = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
            'storage:get',
            ctx,
            { key: storageKey(id) },
          );
          if (got.value === undefined) {
            throw new PluginError({
              code: 'credential-not-found',
              plugin: PLUGIN_NAME,
              message: `no credential with id '${id}'`,
            });
          }
          // decryptWithKey throws PluginError without echoing plaintext.
          const value = decryptWithKey(key, got.value);
          // Empty plaintext = tombstone (see credentials:delete). Treat as not-found.
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
          // @ax/storage-sqlite has no storage:delete yet; write an encrypted-empty
          // tombstone. credentials:get treats empty plaintext as not-found.
          // Replace with real delete when storage:delete lands.
          const tombstone = encryptWithKey(key, '');
          await bus.call('storage:set', ctx, { key: storageKey(id), value: tombstone });
        },
      );
    },
  };
}

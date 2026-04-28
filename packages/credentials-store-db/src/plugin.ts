import { PluginError, type Plugin } from '@ax/core';

/**
 * @ax/credentials-store-db — default storage backend for @ax/credentials.
 *
 * Registers the `credentials:store-blob:*` sub-service surface that the
 * credentials facade calls instead of `storage:get` / `storage:set`. The
 * seam exists so future vault / KMS backends (`@ax/credentials-store-vault`,
 * `@ax/credentials-store-aws-sm`, ...) can replace the default by
 * registering the same hooks against a different backend — no change at
 * the facade.
 *
 * This default impl persists ciphertext blobs through the existing
 * `storage:get` / `storage:set` KV surface, prefixing every key with
 * `credential:`. The prefix is owned by THIS plugin (not by the facade);
 * a vault-backed sibling wouldn't use storage at all.
 *
 * What this plugin is NOT:
 *   - It does not encrypt. AES-256-GCM is owned by `@ax/credentials`.
 *     Blobs in / blobs out, no plaintext on the seam.
 *   - It does not own deletion. The facade's tombstone-via-put trick
 *     still rides on `:put` until the design's `credentials:store-blob:delete`
 *     contract earns its weight (Phase 3, when OAuth lifecycle wants real
 *     deletion semantics for revoked tokens).
 */

const PLUGIN_NAME = '@ax/credentials-store-db';
const KEY_PREFIX = 'credential:';
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

export interface StoreBlobPutInput {
  id: string;
  blob: Uint8Array;
}

export interface StoreBlobGetInput {
  id: string;
}

export interface StoreBlobGetOutput {
  blob: Uint8Array | undefined;
}

function storageKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
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

export function createCredentialsStoreDbPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['credentials:store-blob:put', 'credentials:store-blob:get'],
      calls: ['storage:get', 'storage:set'],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<StoreBlobPutInput, void>(
        'credentials:store-blob:put',
        PLUGIN_NAME,
        async (ctx, input) => {
          const id = validateId(input.id);
          if (!(input.blob instanceof Uint8Array)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'credential blob must be a Uint8Array',
            });
          }
          await bus.call('storage:set', ctx, {
            key: storageKey(id),
            value: input.blob,
          });
        },
      );

      bus.registerService<StoreBlobGetInput, StoreBlobGetOutput>(
        'credentials:store-blob:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const id = validateId(input.id);
          const got = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
            'storage:get',
            ctx,
            { key: storageKey(id) },
          );
          return { blob: got.value };
        },
      );
    },
  };
}

import { createHash } from 'node:crypto';
import type { ServiceHandler } from '@ax/core';

export const MockServices = {
  basics(): Record<string, ServiceHandler> {
    return {
      'storage:get': async () => undefined,
      'storage:set': async () => undefined,
      'audit:write': async () => undefined,
      'eventbus:emit': async () => undefined,
    };
  },
};

/**
 * Content-addressed in-process blob:put/blob:get for tests that boot a plugin
 * which hard-deps the blob store (e.g. @ax/skills since out-of-git Part D2).
 * Mirrors @ax/blob-store-fs's hook surface — bytes ride the bus as a raw
 * Uint8Array (NOT base64), idempotent put, identical bytes dedup to one sha256.
 * Each call returns a FRESH object map, so spread it into ONE harness's
 * `services` map (pass the same instance across harnesses to simulate a durable
 * store surviving a restart).
 */
export function mockBlobStoreServices(): Record<string, ServiceHandler> {
  const objects = new Map<string, Uint8Array>();
  return {
    'blob:put': async (_ctx, input: unknown) => {
      const bytes = (input as { bytes: Uint8Array }).bytes;
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (!objects.has(sha)) objects.set(sha, bytes);
      return { sha256: sha, size: bytes.byteLength };
    },
    'blob:get': async (_ctx, input: unknown) => {
      const sha = (input as { sha256: string }).sha256;
      const bytes = objects.get(sha);
      return bytes === undefined ? { found: false } : { bytes };
    },
  };
}

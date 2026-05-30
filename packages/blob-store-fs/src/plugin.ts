import type { Plugin } from '@ax/core';
import { z, type ZodType } from 'zod';
import { BlobStore } from './store.js';

const PLUGIN_NAME = '@ax/blob-store-fs';

export interface BlobStoreFsConfig {
  /**
   * Operator-supplied root directory for the content-addressed store. Treated
   * as trusted — the plugin does not normalize or sandbox it (mirrors
   * storage-sqlite's `databasePath`). Caller hook payloads NEVER influence the
   * path beyond the validated sha256 shard, so no caller-controlled path ever
   * reaches the filesystem. On a single-replica (RWO PVC) deployment this is
   * the mounted volume root.
   */
  root: string;
}

// ---------------------------------------------------------------------------
// blob:* hook I/O types. Payloads carry ONLY sha256 / bytes / size — no backend
// vocabulary (no bucket, oid, lfs, pack, ref, commit, path, root). `bytes` is a
// raw Uint8Array on the bus (NOT base64-in-JSON), so the eventual IPC binary
// wire can carry it over the callBinary octet-stream channel without re-encoding
// (design Part A; out-of-git-design.md). I1.
// ---------------------------------------------------------------------------

export interface BlobPutInput {
  bytes: Uint8Array;
}
export interface BlobPutOutput {
  sha256: string;
  size: number;
}

export interface BlobGetInput {
  sha256: string;
}
export type BlobGetOutput = { bytes: Uint8Array } | { found: false };

export interface BlobStatInput {
  sha256: string;
}
export type BlobStatOutput = { size: number } | { found: false };

export interface BlobDeleteInput {
  sha256: string;
}
export type BlobDeleteOutput = Record<string, never>;

// ---------------------------------------------------------------------------
// Runtime `returns` contracts (ARCH-13 drift-guard pattern). Each schema is a
// per-registration in-process shape assertion (NOT an inter-plugin wire
// contract — that's @ax/ipc-protocol). They co-locate with the registering
// plugin. `z.instanceof(Uint8Array)` accepts the Uint8Array the handler exposes
// at the edge — the drift-guard test round-trips a populated value and asserts
// the bytes survive by reference. A future @ax/blob-store-s3 backend carries a
// structurally-identical copy (the two-backend I2 pattern, like storage-sqlite
// / storage-postgres).
// ---------------------------------------------------------------------------

export const BlobPutOutputSchema = z.object({
  sha256: z.string(),
  size: z.number(),
});

// Discriminated on presence of `bytes` (no shared literal field). A union of
// the found / not-found shapes; `.passthrough()` is NOT needed because `bytes`
// is plain Uint8Array DATA (z.instanceof preserves the instance by reference),
// not a live capability handle.
export const BlobGetOutputSchema = z.union([
  z.object({ bytes: z.instanceof(Uint8Array) }),
  z.object({ found: z.literal(false) }),
]) as unknown as ZodType<BlobGetOutput>;

export const BlobStatOutputSchema = z.union([
  z.object({ size: z.number() }),
  z.object({ found: z.literal(false) }),
]) as unknown as ZodType<BlobStatOutput>;

export const BlobDeleteOutputSchema = z.object({}) as unknown as ZodType<BlobDeleteOutput>;

export function createBlobStoreFsPlugin(config: BlobStoreFsConfig): Plugin {
  const store = new BlobStore(config.root);

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['blob:put', 'blob:get', 'blob:stat', 'blob:delete'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      await store.ensureRoot();

      bus.registerService<BlobPutInput, BlobPutOutput>(
        'blob:put',
        PLUGIN_NAME,
        async (_ctx, { bytes }) => store.put(bytes),
        { returns: BlobPutOutputSchema },
      );

      bus.registerService<BlobGetInput, BlobGetOutput>(
        'blob:get',
        PLUGIN_NAME,
        async (_ctx, { sha256 }) => store.get(sha256),
        { returns: BlobGetOutputSchema },
      );

      bus.registerService<BlobStatInput, BlobStatOutput>(
        'blob:stat',
        PLUGIN_NAME,
        async (_ctx, { sha256 }) => store.stat(sha256),
        { returns: BlobStatOutputSchema },
      );

      bus.registerService<BlobDeleteInput, BlobDeleteOutput>(
        'blob:delete',
        PLUGIN_NAME,
        async (_ctx, { sha256 }) => {
          await store.delete(sha256);
          return {};
        },
        { returns: BlobDeleteOutputSchema },
      );
    },
  };
}

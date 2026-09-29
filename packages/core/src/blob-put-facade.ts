import type { ZodType } from 'zod';
import { PluginError } from './errors.js';
import type { HookBus } from './hook-bus.js';

// ---------------------------------------------------------------------------
// `blob:put` policy-hook facade
//
// Problem this closes: `blob:put` used to be a raw backend service hook, and
// the hook bus gives a plugin no way to intercept a service hook. Anything
// that needs to see (or refuse) a blob write — a storage limit, a ledger of
// who wrote what — had no seam, and every caller (attachments, artifacts,
// skill bundles, branding) reaches the store through `bus.call('blob:put')`.
//
// Same fix as `registerWorkspaceApplyFacade`, for the same reason. Every blob
// backend registers its raw implementation as the INTERNAL service hook
// `blob:put-internal` and calls `registerBlobPutFacade(bus, PLUGIN_NAME)`,
// which registers the PUBLIC `blob:put` service. Callers don't change — they
// keep calling `blob:put`, which now always:
//
//   1. fires `blob:pre-put` with `{ size }` (veto-only; a transformed payload
//      is ignored). A veto throws `PluginError{ code: 'rejected' }` and
//      NOTHING is written.
//   2. calls `blob:put-internal` with the input, unchanged. Backend errors
//      propagate unchanged.
//   3. fires `blob:stored` with `{ sha256, size }`. Observe-only: a post-fact
//      rejection is LOGGED, never thrown (the bytes already landed; throwing
//      would lie to the caller).
//
// `ctx` is passed straight through to all three steps. The facade never
// constructs or rewrites it, so a subscriber sees exactly who is writing.
//
// Lives in `@ax/core` (not a blob backend) so the fs and s3 backends share
// one copy of the pre/post-fire logic (Invariant 4).
// ---------------------------------------------------------------------------

/** Input of the public `blob:put` hook and of the backend's `blob:put-internal`. */
interface BlobPutFacadeInput {
  bytes: Uint8Array;
}

/** Output shared by `blob:put` and `blob:put-internal`. */
interface BlobPutFacadeOutput {
  sha256: string;
  size: number;
}

/** Veto-only payload for `blob:pre-put`. `size` is the byte length being written. */
export interface BlobPrePutPayload {
  size: number;
}

/** Observe-only payload for `blob:stored`: what landed, after it landed. */
export interface BlobStoredPayload {
  sha256: string;
  size: number;
}

/**
 * Registers the public `blob:put` service hook as a facade over the backend's
 * `blob:put-internal` hook. Call this from a backend plugin's `init()`
 * alongside `registerService('blob:put-internal', …)`.
 *
 * @param bus    the kernel hook bus
 * @param plugin the registering backend's name (used as the facade's plugin
 *               identity and on the `rejected` PluginError)
 * @param opts   `returns`: the backend's output schema, enforced by the bus
 *               on `blob:put` exactly as it was when the backend registered
 *               `blob:put` itself
 */
export function registerBlobPutFacade(
  bus: HookBus,
  plugin: string,
  opts?: { returns?: ZodType },
): void {
  bus.registerService<BlobPutFacadeInput, BlobPutFacadeOutput>(
    'blob:put',
    plugin,
    async (ctx, input) => {
      // 1. pre-put (veto-only). Nothing is written if a subscriber refuses.
      const pre = await bus.fire<BlobPrePutPayload>('blob:pre-put', ctx, {
        size: input.bytes.byteLength,
      });
      if (pre.rejected) {
        throw new PluginError({
          code: 'rejected',
          plugin,
          hookName: 'blob:put',
          message: pre.reason,
          // Only when the veto named one; `code` stays 'rejected' either way.
          ...(pre.code !== undefined ? { reasonCode: pre.code } : {}),
        });
      }

      // 2. write via the backend's internal hook. Errors propagate UNCHANGED.
      const stored = await bus.call<BlobPutFacadeInput, BlobPutFacadeOutput>(
        'blob:put-internal',
        ctx,
        input,
      );

      // 3. stored (observe-only). A post-fact rejection means a subscriber
      //    tried to veto bytes that already landed — log it, never throw.
      const post = await bus.fire<BlobStoredPayload>('blob:stored', ctx, {
        sha256: stored.sha256,
        size: stored.size,
      });
      if (post.rejected) {
        ctx.logger.warn('blob_stored_rejected_post_fact', {
          hook: 'blob:stored',
          // The write already landed; the rejection is ignored. Logged so an
          // operator can spot a misconfigured observe-only subscriber.
          reason: post.reason,
          source: post.source,
        });
      }

      return stored;
    },
    opts?.returns === undefined
      ? undefined
      : { returns: opts.returns as ZodType<BlobPutFacadeOutput> },
  );
}

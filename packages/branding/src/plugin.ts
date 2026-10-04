import {
  BLOB_COLLECT_REFS_HOOK,
  answerBlobCollectRefs,
  makeAgentContext,
  type BlobRef,
  type Plugin,
} from '@ax/core';
import { z } from 'zod';
import {
  readBrandingRecord,
  readBrandingRecordStrict,
  registerBrandingRoutes,
} from './routes.js';

const PLUGIN_NAME = '@ax/branding';

/** `branding:get` output. `name` is the operator-set product name, or null when
 *  none is set (callers choose their own default). */
export interface BrandingGetOutput {
  name: string | null;
}
const BrandingGetOutputSchema = z.object({ name: z.string().min(1).nullable() });

// ---------------------------------------------------------------------------
// @ax/branding
//
// Owns the single "branding" concept: the product name + logo (light/dark).
// Mounts a PUBLIC read/serve surface (`GET /api/branding`, `GET
// /api/branding/logo/:variant`) and an ADMIN write surface (`PUT
// /admin/branding`). Persists a JSON pointer record via storage:* (key
// `settings:branding`) and the logo bytes via blob:*. Registers
// `branding:get` so other plugins can show the product name (e.g. the OAuth
// client name AX presents on third-party consent screens).
//
// It is also a `blob:collect-refs` holder (TASK-776): the light/dark logo
// pointers in the record are the only blob shas it stores, so it answers "which
// of these do you still reference" from that one record.
// ---------------------------------------------------------------------------

export function createBrandingPlugin(): Plugin {
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['branding:get'],
      // Hard deps. http:register-route ← @ax/http-server; auth:require-user ←
      // the auth plugin; storage:get/set ← a storage plugin; blob:put/get/
      // delete ← a blob store. The topo-sort in bootstrap() wires these before
      // init runs.
      calls: [
        'http:register-route',
        'auth:require-user',
        'storage:get',
        'storage:set',
        'blob:put',
        'blob:get',
        'blob:delete',
      ],
      // `blob:collect-refs`: the logo pointers are blob shas. If we did not
      // answer, a sweep would read the silence as "no one holds these logos".
      subscribes: [BLOB_COLLECT_REFS_HOOK],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      bus.registerService<Record<string, never>, BrandingGetOutput>(
        'branding:get',
        PLUGIN_NAME,
        async (ctx) => {
          const { name } = await readBrandingRecord(bus, ctx);
          return { name: name.trim() || null };
        },
        { returns: BrandingGetOutputSchema },
      );
      try {
        unregisterRoutes.push(...(await registerBrandingRoutes(bus, initCtx)));
      } catch (err) {
        while (unregisterRoutes.length > 0) {
          const fn = unregisterRoutes.pop();
          try {
            fn?.();
          } catch (unwindErr) {
            console.warn(
              `[${PLUGIN_NAME}] failed to unregister route during init-unwind: ${
                unwindErr instanceof Error
                  ? unwindErr.message
                  : String(unwindErr)
              }`,
            );
          }
        }
        throw err;
      }

      // Answer from the record, read STRICTLY. `answerBlobCollectRefs` turns a
      // throw into `ok: false`, so a record we cannot read (or storage being
      // down) stops the sweep instead of reading as "no logos". A logo is held
      // for nobody in particular, so `userIds` is `[]`: the bytes are kept and no
      // ledger charge is released for them.
      bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, PLUGIN_NAME, async (ctx, payload) =>
        answerBlobCollectRefs(payload, PLUGIN_NAME, async (candidates): Promise<BlobRef[]> => {
          const record = await readBrandingRecordStrict(bus, ctx);
          if (record === undefined) return [];
          const refs: BlobRef[] = [];
          for (const pointer of [record.light, record.dark]) {
            if (pointer !== null && candidates.includes(pointer.sha256)) {
              refs.push({ sha256: pointer.sha256, userIds: [] });
            }
          }
          return refs;
        }),
      );
    },

    async shutdown() {
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch (err) {
          console.warn(
            `[${PLUGIN_NAME}] failed to unregister route during shutdown: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
  };
}

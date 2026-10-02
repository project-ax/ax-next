import { type Plugin, makeAgentContext } from '@ax/core';
import { z } from 'zod';
import { readBrandingRecord, registerBrandingRoutes } from './routes.js';

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
      subscribes: [],
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

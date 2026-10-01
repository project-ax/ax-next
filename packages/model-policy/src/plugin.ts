import { createCatalog } from './catalog.js';
import { createHandlers, registerModelPolicyRoutes } from './routes.js';
import { PluginError, makeAgentContext, type Plugin } from '@ax/core';
import { z, type ZodType } from 'zod';
import { pickDefault, validatePolicyInput } from './policy.js';
import { createPolicyStore } from './policy-store.js';
import { PLUGIN_NAME, SERVICE_GET_POLICY } from './shared.js';

export interface ModelPolicyConfig {
  /** The list in force until an admin saves one (composition roots pass `resolveAllowedModels(...)`). */
  builtinAllowed: readonly string[];
  /** Preferred built-in Default; falls back to Claude Sonnet, then the first entry. */
  builtinDefault?: string;
  now?: () => Date;
  ttlMs?: number;
}

export interface GetPolicyOutput {
  allowed: string[];
  default: string;
  source: 'admin' | 'builtin';
  version: number;
}

const GetPolicyOutputSchema = z.object({
  allowed: z.array(z.string()),
  default: z.string(),
  source: z.union([z.literal('admin'), z.literal('builtin')]),
  version: z.number(),
}) as unknown as ZodType<GetPolicyOutput>;

export function createModelPolicyPlugin(config: ModelPolicyConfig): Plugin {
  const allowed = [...config.builtinAllowed];
  const builtin = { allowed, default: pickDefault(allowed, config.builtinDefault) };
  const check = validatePolicyInput(builtin);
  if (!check.ok) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `builtinAllowed is invalid: ${check.message}`,
    });
  }

  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [SERVICE_GET_POLICY],
      calls: ['http:register-route', 'auth:require-user', 'storage:get', 'storage:set'],
      subscribes: [],
    },
    async init({ bus }) {
      const store = createPolicyStore({
        bus,
        builtin,
        ...(config.now !== undefined ? { now: config.now } : {}),
        ...(config.ttlMs !== undefined ? { ttlMs: config.ttlMs } : {}),
      });
      const catalog = createCatalog({ bus });
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      unregisterRoutes.push(...(await registerModelPolicyRoutes(bus, initCtx, createHandlers({ bus, store, catalog }))));

      // The bus cannot unregister a service, so this goes last: a throwing init
      // (for example a route conflict above) never leaves a half-wired hook.
      bus.registerService<Record<string, never>, GetPolicyOutput>(
        SERVICE_GET_POLICY,
        PLUGIN_NAME,
        async (ctx) => {
          const v = await store.read(ctx);
          return { allowed: v.allowed, default: v.default, source: v.source, version: v.version };
        },
        { returns: GetPolicyOutputSchema },
      );
    },
    async shutdown() {
      while (unregisterRoutes.length > 0) {
        try {
          unregisterRoutes.pop()?.();
        } catch (err) {
          console.warn(`[${PLUGIN_NAME}] failed to unregister a route during shutdown`, err);
        }
      }
    },
  };
}

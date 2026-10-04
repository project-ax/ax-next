import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import {
  BlobGcSettingsSchema,
  DEFAULT_SETTINGS,
  InvalidSettingsError,
  SETTINGS_BOUNDS,
  type BlobGcSettings,
  type SettingsStore,
} from './config.js';
import type { BlobGcService } from './service.js';
import {
  BODY_MAX_BYTES,
  parseRequestBody,
  PLUGIN_NAME,
  requireAdmin,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

// ---------------------------------------------------------------------------
// The blob GC's admin surface, under the Storage tab's own prefix:
//
//   GET /admin/storage/cleanup  — admin: the settings and the last sweep's
//                                 report (`report: null` until one finishes).
//                                 Channel-web shows one line from it: "Files
//                                 no longer used by anyone: N (X). Not
//                                 removed yet."
//   PUT /admin/storage/cleanup  — admin: change the settings (any subset of
//                                 `mode`, `graceMs`, `retentionMs`). `mode`
//                                 is 'report' or 'enforce'; 'enforce' is
//                                 what lets the sweep retire and purge.
//   POST /admin/storage/blob-gc/roster/forget  { holder }
//                               — admin: drop one holder from the sweep's
//                                 roster (its plugin was retired on purpose;
//                                 design D2). The only way the roster
//                                 shrinks. A holder that is still loaded just
//                                 rejoins at the next sweep. Logged.
//
// Nothing here takes a sha, a user or a path. CSRF on the mutating verbs is
// enforced by http-server before a handler runs; auth is enforced here, per
// handler.
// ---------------------------------------------------------------------------

export const CLEANUP_ROUTE_PATH = '/admin/storage/cleanup';

export const ROSTER_FORGET_ROUTE_PATH = '/admin/storage/blob-gc/roster/forget';

const PutSettingsSchema = BlobGcSettingsSchema.partial();

const ForgetHolderSchema = z.object({ holder: z.string().min(1).max(200) }).strict();

export interface CleanupRouteHandlers {
  get(req: RouteRequest, res: RouteResponse): Promise<void>;
  put(req: RouteRequest, res: RouteResponse): Promise<void>;
  forgetHolder(req: RouteRequest, res: RouteResponse): Promise<void>;
}

export function createCleanupRouteHandlers(deps: {
  bus: HookBus;
  settings: SettingsStore;
  service: BlobGcService;
}): CleanupRouteHandlers {
  const { bus, settings, service } = deps;
  const ctx: AgentContext = makeAgentContext({
    sessionId: 'blob-gc',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });

  return {
    async get(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const [current, report] = await Promise.all([settings.get(), service.lastReport()]);
      res.status(200).json({
        settings: current,
        defaults: { ...DEFAULT_SETTINGS },
        bounds: {
          graceMs: { ...SETTINGS_BOUNDS.graceMs },
          retentionMs: { ...SETTINGS_BOUNDS.retentionMs },
        },
        report,
      });
    },

    async put(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const parsed = parseRequestBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const body = PutSettingsSchema.safeParse(parsed.value);
      if (!body.success) {
        res.status(400).json({ error: 'invalid-settings' });
        return;
      }
      // Only the fields the admin sent; exactOptionalPropertyTypes forbids
      // handing `set` an explicit undefined.
      const partial: Partial<BlobGcSettings> = {};
      if (body.data.mode !== undefined) partial.mode = body.data.mode;
      if (body.data.graceMs !== undefined) partial.graceMs = body.data.graceMs;
      if (body.data.retentionMs !== undefined) partial.retentionMs = body.data.retentionMs;
      try {
        const saved = await settings.set(partial);
        ctx.logger.info('blob_gc_settings_changed', { by: actor.id, ...saved });
        res.status(200).json({ settings: saved });
      } catch (err) {
        if (err instanceof InvalidSettingsError) {
          res.status(400).json({ error: 'invalid-settings' });
          return;
        }
        throw err;
      }
    },

    async forgetHolder(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const parsed = parseRequestBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const body = ForgetHolderSchema.safeParse(parsed.value);
      if (!body.success) {
        res.status(400).json({ error: 'invalid-holder' });
        return;
      }
      const forgotten = await service.forgetHolder(body.data.holder);
      ctx.logger.info('blob_gc_roster_forgotten', { by: actor.id, holder: body.data.holder, forgotten });
      res.status(200).json({ forgotten });
    },
  };
}

interface RouteSpec {
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

/**
 * Register the routes. Returns the unregister callbacks; unwinds the ones
 * already registered if any registration throws.
 */
export async function registerCleanupRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  handlers: CleanupRouteHandlers,
): Promise<Array<() => void>> {
  const routes: RouteSpec[] = [
    { method: 'GET', path: CLEANUP_ROUTE_PATH, handler: handlers.get },
    { method: 'PUT', path: CLEANUP_ROUTE_PATH, handler: handlers.put, maxBodyBytes: BODY_MAX_BYTES },
    {
      method: 'POST',
      path: ROSTER_FORGET_ROUTE_PATH,
      handler: handlers.forgetHolder,
      maxBodyBytes: BODY_MAX_BYTES,
    },
  ];
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<RouteSpec, { unregister: () => void }>(
        'http:register-route',
        initCtx,
        route,
      );
      unregisters.push(result.unregister);
    }
  } catch (err) {
    while (unregisters.length > 0) {
      try {
        unregisters.pop()?.();
      } catch {
        // best-effort unwind
      }
    }
    throw err;
  }
  return unregisters;
}

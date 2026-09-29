import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import {
  DEFAULT_LIMITS,
  DiskQuotaLimitsSchema,
  InvalidLimitsError,
  LIMIT_BOUNDS,
  limitBytesOf,
  statusOf,
  type DiskQuotaLimits,
  type LimitsStore,
  type StorageStatus,
} from './config.js';
import {
  mapBounded,
  parseRequestBody,
  PLUGIN_NAME,
  requireAdmin,
  requireAuthenticated,
  STORAGE_BODY_MAX_BYTES,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';
import type { DiskQuotaStore } from './store.js';

// ---------------------------------------------------------------------------
// The storage HTTP surface:
//
//   GET /settings/storage       — any signed-in person: THEIR OWN numbers
//   GET /admin/storage          — admin: the limits and the biggest owners
//   PUT /admin/storage/limits   — admin: change the limits
//
// Nothing here takes a user from the URL or the body: `/settings/storage`
// answers for the session user and only for them, so there is no id to
// tamper with. CSRF on the mutating verb is enforced by http-server before a
// handler runs; auth is enforced here, per handler.
// ---------------------------------------------------------------------------

/** The admin list shows this many owners, biggest first. */
export const ADMIN_OWNER_LIMIT = 200;
const NAME_LOOKUP_CONCURRENCY = 8;

const PutLimitsSchema = DiskQuotaLimitsSchema.partial();

interface WireOwner {
  ownerId: string;
  kind: 'person' | 'team';
  displayName: string | null;
  email: string | null;
  usedBytes: number;
  workspaceBytes: number;
  fileBytes: number;
  status: StorageStatus;
}

export interface StorageRouteHandlers {
  getMine(req: RouteRequest, res: RouteResponse): Promise<void>;
  getAdmin(req: RouteRequest, res: RouteResponse): Promise<void>;
  putLimits(req: RouteRequest, res: RouteResponse): Promise<void>;
}

export function createStorageRouteHandlers(deps: {
  bus: HookBus;
  store: DiskQuotaStore;
  limits: LimitsStore;
}): StorageRouteHandlers {
  const { bus, store, limits } = deps;
  const ctx: AgentContext = makeAgentContext({
    sessionId: 'disk-quota',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });

  async function lookupName(
    ownerId: string,
  ): Promise<{ displayName: string | null; email: string | null }> {
    // Optional hook: without it, or on any failure, the admin sees the raw id.
    // A name is never worth failing the whole page over.
    if (!bus.hasService('auth:get-user')) return { displayName: null, email: null };
    try {
      const u = await bus.call<{ userId: string }, { displayName?: unknown; email?: unknown } | null>(
        'auth:get-user',
        ctx,
        { userId: ownerId },
      );
      return {
        displayName: typeof u?.displayName === 'string' ? u.displayName : null,
        email: typeof u?.email === 'string' ? u.email : null,
      };
    } catch {
      return { displayName: null, email: null };
    }
  }

  return {
    async getMine(req, res) {
      const actor = await requireAuthenticated(bus, ctx, req, res);
      if (actor === null) return;
      const [current, usage] = await Promise.all([limits.get(), store.usageFor(actor.id)]);
      const bytes = limitBytesOf(current);
      const usedBytes = usage.workspaceBytes + usage.fileBytes;
      res.status(200).json({
        usedBytes,
        limitBytes: bytes.limitBytes,
        warnBytes: bytes.warnBytes,
        workspaceBytes: usage.workspaceBytes,
        fileBytes: usage.fileBytes,
        status: statusOf(usedBytes, bytes),
      });
    },

    async getAdmin(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const [current, top, totals] = await Promise.all([
        limits.get(),
        store.topOwners(ADMIN_OWNER_LIMIT),
        store.totals(),
      ]);
      const bytes = limitBytesOf(current);
      const names = await mapBounded(top, NAME_LOOKUP_CONCURRENCY, (o) =>
        o.ownerId.startsWith('team:')
          ? Promise.resolve({ displayName: null, email: null })
          : lookupName(o.ownerId),
      );
      const owners: WireOwner[] = top.map((o, i) => {
        const usedBytes = o.workspaceBytes + o.fileBytes;
        return {
          ownerId: o.ownerId,
          kind: o.ownerId.startsWith('team:') ? 'team' : 'person',
          displayName: names[i]!.displayName,
          email: names[i]!.email,
          usedBytes,
          workspaceBytes: o.workspaceBytes,
          fileBytes: o.fileBytes,
          status: statusOf(usedBytes, bytes),
        };
      });
      res.status(200).json({
        limits: current,
        defaults: { ...DEFAULT_LIMITS },
        bounds: {
          limitMb: { ...LIMIT_BOUNDS.limitMb },
          warnPercent: { ...LIMIT_BOUNDS.warnPercent },
        },
        owners,
        // Across EVERY owner, not just the capped list above.
        ownerCount: totals.owners,
        totalBytes: totals.bytes,
      });
    },

    async putLimits(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const parsed = parseRequestBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const body = PutLimitsSchema.safeParse(parsed.value);
      if (!body.success) {
        res.status(400).json({ error: 'invalid-limits' });
        return;
      }
      // Only the fields the admin sent; exactOptionalPropertyTypes forbids
      // handing `set` an explicit undefined.
      const partial: Partial<DiskQuotaLimits> = {};
      if (body.data.limitMb !== undefined) partial.limitMb = body.data.limitMb;
      if (body.data.warnPercent !== undefined) partial.warnPercent = body.data.warnPercent;
      try {
        const saved = await limits.set(partial);
        res.status(200).json({ limits: saved });
      } catch (err) {
        if (err instanceof InvalidLimitsError) {
          res.status(400).json({ error: 'invalid-limits' });
          return;
        }
        throw err;
      }
    },
  };
}

interface RouteSpec {
  method: 'GET' | 'PUT';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

/**
 * Register the routes. Returns the unregister callbacks; unwinds the ones
 * already registered if any registration throws.
 */
export async function registerStorageRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  handlers: StorageRouteHandlers,
): Promise<Array<() => void>> {
  const routes: RouteSpec[] = [
    { method: 'GET', path: '/settings/storage', handler: handlers.getMine },
    { method: 'GET', path: '/admin/storage', handler: handlers.getAdmin },
    {
      method: 'PUT',
      path: '/admin/storage/limits',
      handler: handlers.putLimits,
      maxBodyBytes: STORAGE_BODY_MAX_BYTES,
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

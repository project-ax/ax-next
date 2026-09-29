import { z } from 'zod';
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { InvalidLimitsError, UsageLimitsSchema, type LimitsStore, type UsageLimits } from './config.js';
import type { Suspension, UsageStore, UserUsageSummary } from './store.js';
import {
  parseRequestBody,
  requireAdmin,
  USAGE_BODY_MAX_BYTES,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

// ---------------------------------------------------------------------------
// Admin-only HTTP surface:
//
//   GET    /admin/usage                              — who spent what (24h)
//   PUT    /admin/usage/limits                       — change the limits
//   PUT    /admin/usage/users/:userId/suspension     — kill switch on
//   DELETE /admin/usage/users/:userId/suspension     — kill switch off
//
// Everything goes through `requireAdmin` first (401 / 403). CSRF on the
// mutating verbs is enforced by http-server before these handlers run.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/usage-limits';
const WINDOW_HOURS = 24;
const NEAR_LIMIT_RATIO = 0.8;
const NAME_LOOKUP_CONCURRENCY = 8;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

const PutLimitsSchema = UsageLimitsSchema.partial({ assumedTurnCostUsd: true });

const PutSuspensionSchema = z
  .object({
    note: z.string().max(200).optional(),
  })
  .strict();

export type UsageStatus = 'ok' | 'near-limit' | 'at-limit' | 'suspended';

interface WireUser {
  userId: string;
  displayName: string | null;
  email: string | null;
  turnsLastHour: number;
  turnsLast24h: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  spendUsd: number;
  status: UsageStatus;
  suspended: WireSuspension | null;
}

interface WireSuspension {
  at: string;
  by: string;
  note: string | null;
}

/** micro-USD -> USD, rounded to 4 decimals (a hundredth of a cent). */
function toUsd(micros: number): number {
  return Math.round(micros / 100) / 10_000;
}

function toWireSuspension(s: Suspension): WireSuspension {
  return { at: s.at.toISOString(), by: s.by, note: s.note };
}

export function deriveStatus(u: UserUsageSummary, limits: UsageLimits): UsageStatus {
  if (u.suspended !== null) return 'suspended';
  const spendRatio = u.spendMicros / (limits.dailySpendUsd * 1_000_000);
  const rateRatio = u.turnsLastHour / limits.turnsPerHour;
  if (spendRatio >= 1 || rateRatio >= 1) return 'at-limit';
  if (spendRatio >= NEAR_LIMIT_RATIO || rateRatio >= NEAR_LIMIT_RATIO) return 'near-limit';
  return 'ok';
}

/** Run `fn` over `items` with at most `limit` in flight; results keep order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface UsageRouteHandlers {
  getUsage(req: RouteRequest, res: RouteResponse): Promise<void>;
  putLimits(req: RouteRequest, res: RouteResponse): Promise<void>;
  putSuspension(req: RouteRequest, res: RouteResponse): Promise<void>;
  deleteSuspension(req: RouteRequest, res: RouteResponse): Promise<void>;
}

export function createUsageRouteHandlers(deps: {
  bus: HookBus;
  store: UsageStore;
  limits: LimitsStore;
  now: () => Date;
}): UsageRouteHandlers {
  const { bus, store, limits, now } = deps;
  const ctx: AgentContext = makeAgentContext({
    sessionId: 'usage-limits',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });

  async function lookupName(userId: string): Promise<{ displayName: string | null; email: string | null }> {
    // Optional hook: without it, or on any failure, the admin sees the raw id.
    // A name is never worth failing the whole page over.
    if (!bus.hasService('auth:get-user')) return { displayName: null, email: null };
    try {
      const u = await bus.call<{ userId: string }, { displayName?: unknown; email?: unknown } | null>(
        'auth:get-user',
        ctx,
        { userId },
      );
      return {
        displayName: typeof u?.displayName === 'string' ? u.displayName : null,
        email: typeof u?.email === 'string' ? u.email : null,
      };
    } catch {
      return { displayName: null, email: null };
    }
  }

  /**
   * Best-effort: stop the target's in-flight turns. New turns are already
   * refused by the suspension row, so every failure here is swallowed (per
   * conversation) and simply not counted.
   */
  async function interruptInFlight(userId: string): Promise<number> {
    if (!bus.hasService('conversations:list') || !bus.hasService('agent:interrupt')) return 0;
    // Both hooks are ownership-checked by userId, so act AS the target user.
    const targetCtx = makeAgentContext({ sessionId: 'usage-limits-suspend', agentId: PLUGIN_NAME, userId });
    let conversations: unknown;
    try {
      conversations = await bus.call('conversations:list', targetCtx, { userId });
    } catch (err) {
      ctx.logger.warn('usage_suspend_list_failed', { err });
      return 0;
    }
    if (!Array.isArray(conversations)) return 0;
    let interrupted = 0;
    for (const c of conversations as Array<{ conversationId?: unknown; activeReqId?: unknown }>) {
      if (typeof c?.conversationId !== 'string') continue;
      if (typeof c.activeReqId !== 'string' || c.activeReqId.length === 0) continue;
      try {
        const out = await bus.call<{ conversationId: string; userId: string }, { interrupted?: unknown }>(
          'agent:interrupt',
          targetCtx,
          { conversationId: c.conversationId, userId },
        );
        if (out?.interrupted === true) interrupted++;
      } catch (err) {
        ctx.logger.warn('usage_suspend_interrupt_failed', { err });
      }
    }
    return interrupted;
  }

  function targetUserId(req: RouteRequest, res: RouteResponse): string | null {
    const id = req.params.userId;
    if (typeof id !== 'string' || !USER_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid-user-id' });
      return null;
    }
    return id;
  }

  return {
    async getUsage(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const current = await limits.get();
      const summary = await store.summary({ now: now(), limits: current });
      const names = await mapBounded(summary.users, NAME_LOOKUP_CONCURRENCY, (u) => lookupName(u.userId));
      const users: WireUser[] = summary.users.map((u, i) => ({
        userId: u.userId,
        displayName: names[i]!.displayName,
        email: names[i]!.email,
        turnsLastHour: u.turnsLastHour,
        turnsLast24h: u.turnsLast24h,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        spendUsd: toUsd(u.spendMicros),
        status: deriveStatus(u, current),
        suspended: u.suspended === null ? null : toWireSuspension(u.suspended),
      }));
      res.status(200).json({
        windowHours: WINDOW_HOURS,
        truncated: summary.truncated,
        limits: current,
        totals: {
          turns: summary.totals.turns,
          spendUsd: toUsd(summary.totals.spendMicros),
          users: summary.totals.users,
        },
        users,
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
      try {
        const { assumedTurnCostUsd, ...required } = body.data;
        const saved = await limits.set(
          assumedTurnCostUsd === undefined ? required : { ...required, assumedTurnCostUsd },
        );
        res.status(200).json({ limits: saved });
      } catch (err) {
        if (err instanceof InvalidLimitsError) {
          res.status(400).json({ error: 'invalid-limits' });
          return;
        }
        throw err;
      }
    },

    async putSuspension(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const userId = targetUserId(req, res);
      if (userId === null) return;
      const parsed = parseRequestBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const body = PutSuspensionSchema.safeParse(parsed.value);
      if (!body.success) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      // The kill switch has no "unlock yourself" path that doesn't need
      // another admin, so an admin may not throw it on themselves.
      if (userId === actor.id) {
        res.status(400).json({ error: 'cannot-suspend-self' });
        return;
      }
      const suspended = await store.suspend({
        userId,
        by: actor.id,
        note: body.data.note ?? null,
        now: now(),
      });
      const interrupted = await interruptInFlight(userId);
      res.status(200).json({ suspended: toWireSuspension(suspended), interrupted });
    },

    async deleteSuspension(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;
      const userId = targetUserId(req, res);
      if (userId === null) return;
      await store.resume(userId);
      res.status(200).json({ suspended: null });
    },
  };
}

interface RouteSpec {
  method: 'GET' | 'PUT' | 'DELETE';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

/**
 * Register the admin routes. Returns the unregister callbacks; unwinds the
 * ones already registered if any registration throws.
 */
export async function registerUsageRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  handlers: UsageRouteHandlers,
): Promise<Array<() => void>> {
  const routes: RouteSpec[] = [
    { method: 'GET', path: '/admin/usage', handler: handlers.getUsage },
    {
      method: 'PUT',
      path: '/admin/usage/limits',
      handler: handlers.putLimits,
      maxBodyBytes: USAGE_BODY_MAX_BYTES,
    },
    {
      method: 'PUT',
      path: '/admin/usage/users/:userId/suspension',
      handler: handlers.putSuspension,
      maxBodyBytes: USAGE_BODY_MAX_BYTES,
    },
    {
      method: 'DELETE',
      path: '/admin/usage/users/:userId/suspension',
      handler: handlers.deleteSuspension,
      maxBodyBytes: USAGE_BODY_MAX_BYTES,
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

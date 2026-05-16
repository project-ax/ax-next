import type { AgentContext, HookBus, WorkspaceDelta } from '@ax/core';
import type { RoutinesStore } from './store.js';
import { parseRoutineRow } from './parse-routine.js';
import { engineFor } from './engines/index.js';
import { makeWebhookHandler } from './webhook-handler.js';
import type { FireResult } from './tick.js';
import type { RoutineRow, FireSource } from './types.js';

const ROUTINE_PATH = /^\.ax\/routines\/[^/]+\.md$/;

export interface HandleWorkspaceAppliedDeps {
  store: RoutinesStore;
  bus: HookBus;
  webhookRoutes: Map<string, () => void>;
  fireRoutine: (row: RoutineRow, source: FireSource, payload?: unknown) => Promise<FireResult>;
}

function webhookKey(agentId: string, path: string): string {
  return `${agentId}::${path}`;
}

export async function handleWorkspaceApplied(
  deps: HandleWorkspaceAppliedDeps,
  ctx: AgentContext,
  delta: WorkspaceDelta,
  now: Date,
): Promise<void> {
  const agentId = delta.author?.agentId;
  const userId = delta.author?.userId;
  if (typeof agentId !== 'string' || agentId.length === 0) return;
  if (typeof userId !== 'string' || userId.length === 0) return;

  for (const change of delta.changes) {
    if (!ROUTINE_PATH.test(change.path)) continue;
    const key = webhookKey(agentId, change.path);

    if (change.kind === 'deleted') {
      const unreg = deps.webhookRoutes.get(key);
      if (unreg !== undefined) {
        try { unreg(); } catch { /* idempotent per http-server */ }
        deps.webhookRoutes.delete(key);
      }
      try {
        await deps.store.delete({ agentId, path: change.path });
      } catch (err) {
        ctx.logger.warn('routines_sync_delete_failed', {
          agentId, path: change.path,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    try {
      const fetcher = change.contentAfter;
      if (typeof fetcher !== 'function') continue;
      const bytes = await fetcher();
      const parsed = parseRoutineRow(bytes);
      if (!parsed.ok) {
        ctx.logger.warn('routines_sync_parse_failed', {
          agentId, path: change.path, reason: parsed.reason,
        });
        continue;
      }
      const eng = engineFor(parsed.fields.trigger);
      const nextRunAt = parsed.fields.trigger.kind === 'webhook'
        ? null
        : eng?.nextRun(parsed.fields.trigger, now) ?? null;

      const upsertResult = await deps.store.upsert({
        agentId,
        path: change.path,
        authorUserId: userId,
        name: parsed.fields.name,
        description: parsed.fields.description,
        specHash: parsed.specHash,
        trigger: parsed.fields.trigger,
        activeHours: parsed.fields.activeHours ?? null,
        silenceToken: parsed.fields.silenceToken ?? null,
        silenceMax: parsed.fields.silenceMaxChars,
        conversation: parsed.fields.conversation,
        promptBody: parsed.fields.promptBody,
        nextRunAt,
      });

      // ---- Webhook lifecycle ----
      if (parsed.fields.trigger.kind !== 'webhook') {
        // Was webhook, now isn't — drop the prior closure (transition from webhook → interval/cron).
        const stale = deps.webhookRoutes.get(key);
        if (stale !== undefined) {
          try { stale(); } catch { /* swallow */ }
          deps.webhookRoutes.delete(key);
        }
        continue;
      }

      // No-op apply: same spec_hash AND we already have a closure → keep as-is (K6).
      if (!upsertResult.changed && deps.webhookRoutes.has(key)) continue;

      try {
        const ensured = await deps.bus.call<
          { actor: { userId: string; isAdmin: boolean }; agentId: string },
          { token: string }
        >('agents:ensure-webhook-token', ctx,
          { actor: { userId, isAdmin: false }, agentId });
        const token = ensured.token;
        // Unregister prior closure before binding the fresh path.
        const stale = deps.webhookRoutes.get(key);
        if (stale !== undefined) {
          try { stale(); } catch { /* swallow */ }
        }
        const out = await deps.bus.call<
          { method: 'POST'; path: string; handler: unknown; bypassCsrf: boolean },
          { unregister: () => void }
        >('http:register-route', ctx,
          {
            method: 'POST',
            path: `/webhooks/${token}${parsed.fields.trigger.path}`,
            handler: makeWebhookHandler({
              bus: deps.bus, store: deps.store,
              agentId, routinePath: change.path, fire: deps.fireRoutine,
            }),
            // Webhook receivers are explicitly external — the per-agent
            // URL token IS the auth (Phase C design §5). Browser-origin
            // CSRF guarding would reject every legitimate caller (no
            // Origin header from GitHub/Stripe/etc.), so opt this route
            // out of the http-server's CSRF subscriber.
            bypassCsrf: true,
          },
        );
        deps.webhookRoutes.set(key, out.unregister);
      } catch (err) {
        // K10: log + record last_status='error'; don't wedge the apply.
        ctx.logger.warn('routines_sync_webhook_bind_failed', {
          agentId, path: change.path,
          err: err instanceof Error ? err.message : String(err),
        });
        try {
          await deps.store.advance({
            agentId, path: change.path, nextRunAt: null,
            lastRunAt: now, lastStatus: 'error',
            lastError: err instanceof Error ? err.message : String(err),
          });
        } catch { /* best-effort */ }
      }
    } catch (err) {
      ctx.logger.warn('routines_sync_upsert_failed', {
        agentId, path: change.path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Re-binds every webhook routine for the given agent against the current
 * token. Called by the `agents:webhook-token-rotated` subscriber in plugin.ts
 * so that stale routes (pointing at the old token URL) are torn down and fresh
 * ones registered before the next inbound request arrives.
 *
 * Per-routine failures are caught, logged, and skipped (K10). A failure on one
 * routine does NOT stop rebinding the remaining routines for the same agent.
 */
export async function rebindWebhooksForAgent(
  deps: HandleWorkspaceAppliedDeps,
  ctx: AgentContext,
  agentId: string,
): Promise<void> {
  const rows = await deps.store.list({ agentId });
  for (const row of rows) {
    if (row.trigger.kind !== 'webhook') continue;
    const key = webhookKey(agentId, row.path);
    // Tear down the stale closure (the one registered with the old token).
    const stale = deps.webhookRoutes.get(key);
    if (stale !== undefined) {
      try { stale(); } catch { /* idempotent */ }
    }
    try {
      // Re-resolve the (now-rotated) token. ensure-webhook-token is the
      // canonical read path — the token is never stored in this plugin.
      const ensured = await deps.bus.call<
        { actor: { userId: string; isAdmin: boolean }; agentId: string },
        { token: string }
      >('agents:ensure-webhook-token', ctx,
        { actor: { userId: row.authorUserId, isAdmin: false }, agentId });
      const out = await deps.bus.call<
        { method: 'POST'; path: string; handler: unknown; bypassCsrf: boolean },
        { unregister: () => void }
      >('http:register-route', ctx,
        {
          method: 'POST',
          path: `/webhooks/${ensured.token}${(row.trigger as { path: string }).path}`,
          handler: makeWebhookHandler({
            bus: deps.bus, store: deps.store,
            agentId, routinePath: row.path, fire: deps.fireRoutine,
          }),
          // See bypassCsrf rationale in handleWorkspaceApplied above.
          bypassCsrf: true,
        },
      );
      deps.webhookRoutes.set(key, out.unregister);
    } catch (err) {
      // K10: remove the stale entry (no longer valid) and log; don't throw.
      deps.webhookRoutes.delete(key);
      ctx.logger.warn('routines_rebind_one_webhook_failed', {
        agentId, path: row.path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

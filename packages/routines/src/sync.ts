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
        const resolved = await deps.bus.call<
          { agentId: string; userId: string },
          { agent: { id: string; ownerId: string; webhookToken: string | null } }
        >('agents:resolve', ctx, { agentId, userId });
        let token = resolved.agent.webhookToken;
        if (typeof token !== 'string' || token.length === 0) {
          const rot = await deps.bus.call<
            { actor: { userId: string; isAdmin: boolean }; agentId: string },
            { token: string }
          >('agents:rotate-webhook-token', ctx,
            { actor: { userId, isAdmin: false }, agentId });
          token = rot.token;
        }
        // Unregister prior closure before binding the fresh path.
        const stale = deps.webhookRoutes.get(key);
        if (stale !== undefined) {
          try { stale(); } catch { /* swallow */ }
        }
        const out = await deps.bus.call<
          { method: 'POST'; path: string; handler: unknown },
          { unregister: () => void }
        >('http:register-route', ctx,
          {
            method: 'POST',
            path: `/webhooks/${token}${parsed.fields.trigger.path}`,
            handler: makeWebhookHandler({
              bus: deps.bus, store: deps.store,
              agentId, routinePath: change.path, fire: deps.fireRoutine,
            }),
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

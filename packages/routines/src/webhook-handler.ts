import { githubDeliveryId } from './repeat-limits.js';
import type { RepeatDeliveryStore } from './repeat-deliveries.js';
export { githubDeliveryId, repeatQueueFits } from './repeat-limits.js';
import { verifyWebhookSignature } from './webhook-signature.js';
import { makeAgentContext, type HookBus } from '@ax/core';
import { type WebhookRefusalReason, validateWebhookPath } from '@ax/routines-contract';
import { credentialRef } from './definition.js';
import type { RoutinesStore } from './store.js';
import type { WebhookAddressProof } from './webhook-address.js';

// HTTP is duck-typed here: no runtime dependency on another plugin.
export interface HttpRequest {
  readonly path: string;
  readonly rawPath: string;
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}
export interface HttpResponse {
  status(code: number): HttpResponse;
  end(): void;
  json(body: unknown): void;
}
export type HttpRouteHandler = (req: HttpRequest, res: HttpResponse) => Promise<void>;
export interface WebhookRouterDeps {
  bus: HookBus;
  store: RoutinesStore;
  deliveries: RepeatDeliveryStore;
  pump: () => Promise<void>;
  now: () => Date;
}

/** Token authentication routes a request; the fire path separately checks the stored owner's ACL. */
export function createWebhookRouter(deps: WebhookRouterDeps): HttpRouteHandler {
  return async (req, res) => {
    const token = req.params.token;
    const path = '/' + (req.params['*'] ?? '');
    // Token params are decoded by the HTTP adapter; require the original spelling too.
    if (!token || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token) || !validateWebhookPath(path)
      || req.rawPath !== `/webhooks/${token}${path}`) { res.status(404).end(); return; }
    const requestCtx = makeAgentContext({ sessionId: 'routine-webhook-routing', agentId: '@ax/routines', userId: 'system' });
    const resolveLegacy = () => deps.bus.callJoined<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', requestCtx, { token });
    const taskRow = await deps.store.findWebhookByToken({ token, path });
    const legacy = taskRow ? null : await resolveLegacy();
    const row = taskRow ?? (legacy?.agent ? await deps.store.findWebhook({ agentId: legacy.agent.id, path, legacyOnly: true }) : null);
    if (!row || row.webhook === null) { res.status(404).end(); return; }
    const generation = await deps.store.webhookGeneration(row);
    if (generation === null) { res.status(404).end(); return; }
    const address: WebhookAddressProof = { kind: taskRow ? 'task' : 'legacy', token, generation };
    const observe = (observation: WebhookRefusalReason | 'verified') => deps.store.observeWebhook({ row, address, observation, now: deps.now() }, async () => (await resolveLegacy())?.agent.id === row.agentId);
    const refuse = async (status: number, reason: WebhookRefusalReason) => {
      try { if (!await observe(reason)) { res.status(404).end(); return; } } catch { res.status(503).end(); return; }
      res.status(status).end();
    };
    if (req.body.byteLength > 1024 * 1024) { await refuse(413, 'too-large'); return; }
    const trigger = row.webhook;
    const ctx = makeAgentContext({ sessionId: 'routine-webhook', agentId: row.agentId, userId: row.ownerUserId });
    // Step 2: HMAC verify (if configured)
    if (trigger.hmac !== undefined) {
      let secret: string;
      try {
        secret = await deps.bus.callJoined<{ ref: string; userId: string }, string>(
          'credentials:get', ctx,
          { ref: credentialRef(row), userId: row.ownerUserId },
        );
      } catch {
        ctx.logger.warn('routines_webhook_secret_fetch_failed', { agentId: row.agentId, routineId: row.routineId });
        await refuse(401, 'secret');
        return;
      }

      if (!verifyWebhookSignature(trigger.hmac, req.headers, req.body, secret, deps.now())) {
        await refuse(401, 'signature');
        return;
      }
    }

    // Step 3: body parse by Content-Type
    const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    let payload: unknown;
    if (ct === 'application/json') {
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        await refuse(400, 'invalid-body');
        return;
      }
    } else if (ct === 'application/x-www-form-urlencoded') {
      payload = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
    } else {
      await refuse(415, 'unsupported-content');
      return;
    }

    // Slack verifies the connection before sending events. This is authenticated
    // setup traffic, not a job; never enqueue its challenge or expose it to a model.
    if (trigger.hmac && 'app' in trigger.hmac && trigger.hmac.app === 'slack'
      && payload !== null && typeof payload === 'object' && 'type' in payload && payload.type === 'url_verification') {
      if (!('challenge' in payload) || typeof payload.challenge !== 'string' || payload.challenge.length === 0 || payload.challenge.length > 4096) {
        await refuse(400, 'invalid-body'); return;
      }
      try { if (!await observe('verified')) { res.status(404).end(); return; } } catch { res.status(503).end(); return; }
      res.status(200).json({ challenge: payload.challenge }); return;
    }

    // Step 4: optional GitHub event filter
    // Only filter when the header is present — absent header means "not a GitHub webhook"
    // and we pass through (caller didn't configure per-event filtering for non-GitHub sources).
    if (trigger.events !== undefined && trigger.events.length > 0) {
      const ghEvent = req.headers['x-github-event'];
      if (typeof ghEvent === 'string' && ghEvent.length > 0 && !trigger.events.includes(ghEvent)) {
        await refuse(204, 'event-filter');
        return;
      }
    }

    let deliveryId: string | null;
    try { deliveryId=githubDeliveryId(req.headers['x-github-delivery']); }
    catch { await refuse(400, 'delivery-id'); return; }
    let admitted: 'accepted' | 'duplicate' | 'full' | 'missing';
    try {
      const admit = row.kind === 'repeat' ? deps.deliveries.admit.bind(deps.deliveries) : deps.store.admitTaskEvent.bind(deps.store);
      admitted = await admit({row,payload,deliveryId,now:deps.now(),address},async(bytes,owner)=>
        deps.bus.callJoined('blob:put',makeAgentContext({sessionId:'repeat-delivery-admission',agentId:row.agentId,userId:owner}),{bytes}),
      async () => (await resolveLegacy())?.agent.id === row.agentId);
    } catch (error) {
      const quota = error !== null && typeof error==='object' && 'code' in error && error.code==='rejected';
      await refuse(quota ? 429 : 503, quota ? 'capacity' : 'unavailable'); return;
    }
    if (admitted==='missing') { await refuse(404, row.enabled ? 'unavailable' : 'paused'); return; }
    if (admitted==='full') { await refuse(429, 'capacity'); return; }
    // Admission is already durable. Pump failure never turns an accepted delivery into a retryable write.
    // A task update only brings its durable scheduler due time forward. The
    // receiver must never start task check-ins; batching and work hours belong
    // to the existing scheduler. Repeat retains its per-delivery drain.
    if (admitted==='accepted' && row.kind === 'repeat') {
      try { await deps.pump(); } catch { ctx.logger.warn('repeat_queue_drain_failed',{agentId:row.agentId,routineId:row.routineId}); }
    }
    res.status(202).end();
  };
}

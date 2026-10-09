import { createHmac, timingSafeEqual } from 'node:crypto';
import { makeAgentContext, type HookBus } from '@ax/core';
import { validateWebhookPath } from '@ax/routines-contract';
import { credentialRef } from './definition.js';
import type { AcceptedDispatch } from './types.js';
import type { FireResult } from './tick.js';
import type { RoutinesStore } from './store.js';

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
}
export type HttpRouteHandler = (req: HttpRequest, res: HttpResponse) => Promise<void>;
export interface WebhookRouterDeps {
  bus: HookBus;
  store: RoutinesStore;
  fire: (accepted: AcceptedDispatch, payload?: unknown) => Promise<FireResult>;
  now: () => Date;
}

/** Token authentication routes a request; the fire path separately checks the stored owner's ACL. */
export function createWebhookRouter(deps: WebhookRouterDeps): HttpRouteHandler {
  return async (req, res) => {
    const token = req.params.token;
    const path = '/' + (req.params['*'] ?? '');
    // Token params are decoded by the HTTP adapter; require the original spelling too.
    if (!token || !/^[A-Za-z0-9_-]+$/.test(token) || !validateWebhookPath(path)
      || req.rawPath !== `/webhooks/${token}${path}`) { res.status(404).end(); return; }
    if (req.body.byteLength > 1024 * 1024) { res.status(413).end(); return; }
    const requestCtx = makeAgentContext({ sessionId: 'routine-webhook-routing', agentId: '@ax/routines', userId: 'system' });
    const resolved = await deps.bus.callJoined<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', requestCtx, { token });
    if (!resolved?.agent) { res.status(404).end(); return; }
    const row = await deps.store.findWebhook({ agentId: resolved.agent.id, path });
    if (!row || !row.enabled || row.trigger.kind !== 'webhook') { res.status(404).end(); return; }
    const trigger = row.trigger;
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
        res.status(401).end();
        return;
      }

      const headerName = trigger.hmac.header.toLowerCase();
      const header = req.headers[headerName];
      if (typeof header !== 'string' || header.length === 0) {
        res.status(401).end();
        return;
      }

      // Strip optional prefix (e.g. "sha256=") before comparing
      const bare = trigger.hmac.prefix !== undefined && header.startsWith(trigger.hmac.prefix)
        ? header.slice(trigger.hmac.prefix.length)
        : header;

      const algorithm = trigger.hmac.algorithm;
      const computed = createHmac(algorithm, secret).update(req.body).digest('hex');

      // Constant-time comparison over equal-length lowercase hex strings.
      // Explicit length check first — timingSafeEqual throws on length mismatch.
      const lhs = Buffer.from(bare.toLowerCase(), 'utf8');
      const rhs = Buffer.from(computed, 'utf8');
      if (lhs.length !== rhs.length || !timingSafeEqual(lhs, rhs)) {
        res.status(401).end();
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
        res.status(400).end();
        return;
      }
    } else if (ct === 'application/x-www-form-urlencoded') {
      payload = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
    } else {
      res.status(415).end();
      return;
    }

    // Step 4: optional GitHub event filter
    // Only filter when the header is present — absent header means "not a GitHub webhook"
    // and we pass through (caller didn't configure per-event filtering for non-GitHub sources).
    if (trigger.events !== undefined && trigger.events.length > 0) {
      const ghEvent = req.headers['x-github-event'];
      if (typeof ghEvent === 'string' && ghEvent.length > 0 && !trigger.events.includes(ghEvent)) {
        res.status(204).end();
        return;
      }
    }

    const dispatch = await deps.store.acceptDispatch({ agentId: row.agentId, routineId: row.routineId,
      expectedRevision: row.revision, actorUserId: row.ownerUserId, source: 'webhook',
      requestId: crypto.randomUUID(), now: deps.now() });
    if (!dispatch) { res.status(404).end(); return; }
    if (!dispatch.replayed) await deps.fire(dispatch.accepted, payload);
    res.status(202).end();
  };
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { makeAgentContext, type HookBus } from '@ax/core';
import type { HttpRouteHandler } from '@ax/http-server';
import type { CredentialsGetInput, CredentialsGetOutput } from '@ax/credentials';
import type { RoutineRow, FireSource } from './types.js';
import type { FireResult } from './tick.js';
import type { RoutinesStore } from './store.js';

export interface WebhookHandlerDeps {
  bus: HookBus;
  store: Pick<RoutinesStore, 'findOne'>;
  agentId: string;
  routinePath: string;
  fire: (row: RoutineRow, source: FireSource, payload?: unknown) => Promise<FireResult>;
}

/**
 * Build the http handler bound to a specific (agentId, routinePath).
 *
 * Chain (design §5):
 *   1. lookup row by (agentId, routinePath); 404 if gone / wrong kind
 *   2. if hmac configured: fetch secret, compute, timingSafeEqual; 401 on miss
 *   3. parse body by Content-Type; 400 on malformed JSON, 415 on unknown CT
 *   4. if events configured AND X-GitHub-Event present AND mismatch: 204
 *   5. fire(row, 'webhook', payload) fire-and-forget
 *   6. 202
 *
 * Trust boundary K9: req.body flows JSON.parse → renderTemplate (in fire.ts)
 * → agent:invoke. No dynamic-evaluation sink is reachable from the payload.
 *
 * Trust boundary K11: HMAC verification uses crypto.timingSafeEqual only.
 * Buffer-of-utf8 equality with an explicit length-mismatch short-circuit so
 * timingSafeEqual never receives unequal-length buffers (which would throw).
 */
export function makeWebhookHandler(deps: WebhookHandlerDeps): HttpRouteHandler {
  return async (req, res) => {
    const ctx = makeAgentContext({
      sessionId: `webhook-${deps.agentId}-${deps.routinePath}`,
      agentId: deps.agentId,
      userId: 'system',
    });

    // Step 1: row lookup
    const row = await deps.store.findOne({ agentId: deps.agentId, path: deps.routinePath });
    if (row === null || row.trigger.kind !== 'webhook') {
      res.status(404).end();
      return;
    }
    const trigger = row.trigger;

    // Step 2: HMAC verify (if configured)
    if (trigger.hmac !== undefined) {
      let secret: string;
      try {
        secret = await deps.bus.call<CredentialsGetInput, CredentialsGetOutput>(
          'credentials:get', ctx,
          { ref: trigger.hmac.secretRef, userId: row.authorUserId },
        );
      } catch {
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

    // Step 5: fire-and-forget dispatch
    // The fire path records its own status (ok | silenced | error) via the
    // chat:turn-end one-shot in plugin.ts. We 202 immediately so the sender
    // isn't blocked on agent:invoke completing.
    void deps.fire(row, 'webhook', payload).catch((err: unknown) => {
      process.stderr.write(
        `[ax/routines] webhook fire failed for ${deps.agentId}${deps.routinePath}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    });

    // Step 6: 202 Accepted
    res.status(202).end();
  };
}

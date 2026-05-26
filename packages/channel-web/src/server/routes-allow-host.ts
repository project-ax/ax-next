/**
 * POST /api/chat/allow-host — the reactive egress wall's grant route (TASK-37).
 *
 * The browser's <PermissionCard> "Allow access to <host>?" card POSTs
 * `{ sessionId, host }` here when the user grants. This route is the ONLY
 * caller of the host-internal `proxy:add-host` service hook — the untrusted
 * runner can never reach `proxy:add-host` (it's not an IPC action; fork #1),
 * so the only path to widening a session's live egress allowlist is an
 * authenticated, CSRF-gated user action.
 *
 * Security posture:
 *  - Auth: `auth:require-user` → 401 on rejection. The per-request ctx is built
 *    from the AUTHENTICATED user id, never the browser-supplied sessionId.
 *  - CSRF: the http-server's subscriber requires `X-Requested-With: ax-admin`
 *    on state-changing methods (the same gate as POST /api/chat/messages); the
 *    client `grantHost()` sends it.
 *  - Ownership: the browser supplies `sessionId` only so the proxy knows WHICH
 *    session to widen; the proxy re-validates `SessionConfig.userId ===
 *    ctx.userId`, so a forged/guessed sessionId for another user's session is
 *    rejected (`forbidden` → 403). The proxy also re-validates `host`
 *    (defense-in-depth, I2; `invalid-host` → 400).
 *
 * I2 — no `@ax/credential-proxy` / `@ax/http-server` import; the RouteRequest/
 * RouteResponse shapes are reused from routes-chat.ts (the same duck-typed
 * subset), and the proxy hook is a duck-typed bus call.
 */
import { makeAgentContext, makeReqId, PluginError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const BodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  host: z.string().min(1).max(253),
});

interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}

interface AddHostInput {
  sessionId: string;
  host: string;
}
interface AddHostOutput {
  added: boolean;
}

export function makeAllowHostHandler(deps: { bus: HookBus; initCtx: AgentContext }) {
  return async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    // 1) Auth — host-side identity. Never trust the browser's sessionId for
    //    authorization; the proxy re-checks ownership below.
    let userId: string;
    try {
      const r = await deps.bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
        'auth:require-user',
        deps.initCtx,
        { req },
      );
      userId = r.user.id;
    } catch (err) {
      if (err instanceof PluginError) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      throw err;
    }

    // 2) Parse + validate the body. The http-server already capped the body
    //    size before we ran; here we only contend with malformed/invalid JSON.
    let body: z.infer<typeof BodySchema>;
    try {
      const raw = req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf-8')) as unknown);
      const parsed = BodySchema.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid-body' });
        return;
      }
      body = parsed.data;
    } catch {
      res.status(400).json({ error: 'invalid-body' });
      return;
    }

    // 3) Per-request ctx carries the AUTHENTICATED identity. The proxy
    //    re-validates ownership against SessionConfig.userId — a forged
    //    sessionId can't widen someone else's session.
    const ctx = makeAgentContext({
      sessionId: body.sessionId,
      agentId: '',
      userId,
      reqId: makeReqId(),
    });
    try {
      const out = await deps.bus.call<AddHostInput, AddHostOutput>('proxy:add-host', ctx, {
        sessionId: body.sessionId,
        host: body.host,
      });
      res.status(200).json(out);
    } catch (err) {
      if (err instanceof PluginError && err.code === 'forbidden') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (err instanceof PluginError && err.code === 'invalid-host') {
        res.status(400).json({ error: 'invalid-host' });
        return;
      }
      throw err;
    }
  };
}

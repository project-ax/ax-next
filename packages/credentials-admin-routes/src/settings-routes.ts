import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import {
  parseRequestBody,
  requireUser,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

// ---------------------------------------------------------------------------
// /settings/credentials* CRUD handlers (per-user).
//
// Routes:
//   GET    /settings/credentials             → list (filtered to scope=user, ownerId=actor)
//   POST   /settings/credentials             → create (forced scope=user, ownerId=actor)
//   DELETE /settings/credentials/:ref        → delete (scope=user, ownerId=actor)
//
// Same shape as /admin/credentials but every operation is locked to
// `scope='user'` + `ownerId=actor.id`. The body schema deliberately
// omits scope/ownerId — even if the operator sends them they get
// silently overridden, so we drop them from the schema entirely
// (`.strict()` would 400 on extra keys, which is the right behavior
// here too: a confused caller that thinks they're hitting /admin/* gets
// a clear "this isn't that endpoint" error).
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/credentials-admin-routes/settings';

const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const settingsCreateBodySchema = z
  .object({
    ref: z.string().regex(REF_RE),
    kind: z.string().regex(KIND_RE),
    payload: z.string().min(1), // base64
    expiresAt: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface SettingsRouteDeps {
  bus: HookBus;
}

export function createSettingsCredentialsHandlers(deps: SettingsRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  // The actor's userId fills the ctx.userId slot per call (not the
  // top-level closure) so audit subscribers see the real actor instead
  // of a static 'settings' string.
  const baseCtx = makeAgentContext({
    sessionId: 'credentials-settings',
    agentId: PLUGIN_NAME,
    userId: 'settings',
  });

  function ctxForActor(actorId: string): AgentContext {
    return makeAgentContext({
      sessionId: baseCtx.sessionId,
      agentId: PLUGIN_NAME,
      userId: actorId,
    });
  }

  return {
    /** GET /settings/credentials — only shows the actor's own user-scoped creds. */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, baseCtx, req, res);
      if (actor === null) return;
      const ctx = ctxForActor(actor.id);
      try {
        const out = await deps.bus.call<
          { scope: 'user'; ownerId: string },
          { credentials: unknown[] }
        >('credentials:list', ctx, { scope: 'user', ownerId: actor.id });
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /settings/credentials — body fields scope/ownerId are ignored / forced. */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, baseCtx, req, res);
      if (actor === null) return;
      const ctx = ctxForActor(actor.id);
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const result = settingsCreateBodySchema.safeParse(parsedBody.value);
      if (!result.success) {
        const first = result.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }
      const data = result.data;
      let payload: Uint8Array;
      try {
        payload = new Uint8Array(Buffer.from(data.payload, 'base64'));
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      if (payload.length === 0) {
        res.status(400).json({ error: 'payload must decode to non-empty bytes' });
        return;
      }
      try {
        await deps.bus.call('credentials:set', ctx, {
          scope: 'user',
          ownerId: actor.id,
          ref: data.ref,
          kind: data.kind,
          payload,
          ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        });
        const credential: Record<string, unknown> = {
          scope: 'user',
          ownerId: actor.id,
          ref: data.ref,
          kind: data.kind,
          createdAt: new Date().toISOString(),
        };
        if (data.expiresAt !== undefined) {
          credential.expiresAt = new Date(data.expiresAt).toISOString();
        }
        if (data.metadata !== undefined) credential.metadata = data.metadata;
        res.status(201).json({ credential });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** DELETE /settings/credentials/:ref — only the actor's own user-cred. */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, baseCtx, req, res);
      if (actor === null) return;
      const ctx = ctxForActor(actor.id);
      const ref = req.params.ref;
      if (ref === undefined || ref.length === 0) {
        res.status(400).json({ error: 'missing-params' });
        return;
      }
      try {
        await deps.bus.call('credentials:delete', ctx, {
          scope: 'user',
          ownerId: actor.id,
          ref,
        });
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

export async function registerSettingsCredentialsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createSettingsCredentialsHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/settings/credentials', handler: handlers.list },
    { method: 'POST', path: '/settings/credentials', handler: handlers.create },
    {
      method: 'DELETE',
      path: '/settings/credentials/:ref',
      handler: handlers.destroy,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}

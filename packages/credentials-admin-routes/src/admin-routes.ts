import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import {
  parseRequestBody,
  requireAdmin,
  requireUser,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

// ---------------------------------------------------------------------------
// /admin/credentials* CRUD handlers (admin-only).
//
// Routes:
//   GET    /admin/credentials                                  → list (metadata only)
//   POST   /admin/credentials                                  → create
//   DELETE /admin/credentials/:scope/:ownerId/:ref             → delete
//
// All endpoints require an authenticated admin session (auth:require-user
// + isAdmin). Body cap: 64 KiB (ADMIN_BODY_MAX_BYTES). Body schema is
// re-validated at the route layer for friendly 400 messages — the
// credentials facade re-validates again, so this layer's looseness can't
// trick the store into accepting a malformed shape (but a route-layer
// reject avoids the round-trip).
//
// `/admin/credentials/kinds` (the kinds catalog) is mounted under the
// admin namespace for routing convenience but the auth gate is relaxed
// to `auth:require-user` — the catalog isn't admin-sensitive (it just
// answers "what flows does this deployment support?") and the settings
// UI for any authed user consumes it too. Same posture as a public
// "supported features" endpoint.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/credentials-admin-routes';

const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

/**
 * Body schema for `POST /admin/credentials`. Mirrors the credentials
 * facade's CredentialsSetInput (packages/credentials/src/plugin.ts) — the
 * facade re-validates so this layer can't be the only gate, but matching
 * shape here gives the operator a crisper 400.
 *
 * `payload` is the secret material as base64 — the bytes never traverse
 * JSON in the clear. The handler decodes to Uint8Array before the
 * `credentials:set` call.
 *
 * `.strict()` means unknown keys are a 400. We don't want to silently
 * accept e.g. `userId` typos that would otherwise be ignored.
 */
const createBodySchema = z
  .object({
    scope: z.enum(['global', 'user', 'agent']),
    ownerId: z.string().regex(OWNER_ID_RE).nullable(),
    ref: z.string().regex(REF_RE),
    kind: z.string().regex(KIND_RE),
    payload: z.string().min(1), // base64
    expiresAt: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === 'global' && v.ownerId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId must be null when scope='global'",
        path: ['ownerId'],
      });
    }
    if ((v.scope === 'user' || v.scope === 'agent') && v.ownerId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ownerId is required when scope='${v.scope}'`,
        path: ['ownerId'],
      });
    }
  });

export interface AdminRouteDeps {
  bus: HookBus;
}

export function createAdminCredentialsHandlers(deps: AdminRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  kinds: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  // Per-handler ctx is acceptable for MVP. A subscriber observing audit
  // events sees `userId: 'admin'` in the ctx — the actual acting-user id
  // is communicated via subscriber payloads (which Phase 6 will add for
  // credentials).
  const ctx = makeAgentContext({
    sessionId: 'credentials-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** GET /admin/credentials */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<
          Record<string, never>,
          { credentials: unknown[] }
        >('credentials:list', ctx, {});
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/credentials */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const result = createBodySchema.safeParse(parsedBody.value);
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
      // Empty bytes after base64 decode = the operator passed a string
      // that decoded to nothing. Either a typo or an attempted tombstone
      // bypass; either way reject.
      if (payload.length === 0) {
        res.status(400).json({ error: 'payload must decode to non-empty bytes' });
        return;
      }
      try {
        await deps.bus.call('credentials:set', ctx, {
          scope: data.scope,
          ownerId: data.ownerId,
          ref: data.ref,
          kind: data.kind,
          payload,
          ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        });
        // Echo metadata-only — the secret bytes never traverse the response
        // wire. The createdAt is the server's clock (the facade stamps the
        // same value into the envelope; we don't have a way to read it back
        // without an extra round-trip, so we use Date.now() here — the two
        // stamps are within ms of each other).
        const credential: Record<string, unknown> = {
          scope: data.scope,
          ownerId: data.ownerId,
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

    /**
     * GET /admin/credentials/kinds — catalog of supported credential
     * kinds and their flow shape (paste vs oauth). Auth gate is relaxed
     * to any authed user (settings UI consumes the same route).
     */
    async kinds(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<
          Record<string, never>,
          { kinds: Array<{ kind: string; flow: string }> }
        >('credentials:list-kinds', ctx, {});
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** DELETE /admin/credentials/:scope/:ownerId/:ref */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { scope, ownerId, ref } = req.params;
      if (
        scope === undefined ||
        scope.length === 0 ||
        ownerId === undefined ||
        ownerId.length === 0 ||
        ref === undefined ||
        ref.length === 0
      ) {
        res.status(400).json({ error: 'missing-params' });
        return;
      }
      // The URL placeholder for "no owner" (scope='global') is `_` — JSON
      // `null` doesn't path-encode. We translate before the bus call;
      // the facade will reject scope='global' with non-null ownerId
      // anyway, which is the contract the URL layer just decoded.
      const ownerIdResolved = ownerId === '_' ? null : ownerId;
      if (scope !== 'global' && scope !== 'user' && scope !== 'agent') {
        res.status(400).json({ error: 'invalid-scope' });
        return;
      }
      try {
        await deps.bus.call('credentials:delete', ctx, {
          scope,
          ownerId: ownerIdResolved,
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

/**
 * Register all three admin routes against @ax/http-server. Returned
 * unregister callbacks should be tracked by the plugin and called on
 * shutdown so a re-init in tests doesn't trip duplicate-route.
 */
export async function registerAdminCredentialsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAdminCredentialsHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/credentials', handler: handlers.list },
    // `/admin/credentials/kinds` is a literal route — exact-match dispatch
    // in @ax/http-server's router wins over the `:scope/:ownerId/:ref`
    // pattern below regardless of registration order, but we list it first
    // for readability.
    { method: 'GET', path: '/admin/credentials/kinds', handler: handlers.kinds },
    { method: 'POST', path: '/admin/credentials', handler: handlers.create },
    {
      method: 'DELETE',
      path: '/admin/credentials/:scope/:ownerId/:ref',
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

export { ADMIN_BODY_MAX_BYTES } from './shared.js';

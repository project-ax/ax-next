import { makeAgentContext, PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { Destination } from '@ax/credentials';
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
// /admin/destinations/:destinationKind/credential   (POST / DELETE)
// /settings/destinations/:destinationKind/credential (POST / DELETE)
//
// Destination-first credential CRUD. Instead of accepting a pre-computed
// ref string, the client describes WHERE the credential goes (destination
// object), and this layer computes the deterministic ref via refForDestination.
//
// This prevents clients from supplying an arbitrary ref that bypasses the
// naming convention — the ref is always derived from a validated destination
// shape.
//
// Admin routes: full scope axis (global / user / agent).
// Settings routes: scope forced to 'user', ownerId forced to the actor's id.
//
// The :destinationKind URL param must match destination.kind in the body
// (400 otherwise). This guards against routing confusion where a client
// sends a mcp-env body to the provider endpoint.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/credentials-admin-routes/destinations';

// ---------------------------------------------------------------------------
// refForDestination — inlined from @ax/credentials/refs.ts.
//
// Cross-plugin runtime imports are forbidden (CLAUDE.md invariant I2); this
// is a pure helper with no external deps, so inlining is the right call.
// The Destination type is still imported as `import type` (erased at compile
// time, allowed by the lint rule) so the two definitions stay structurally
// in sync. A drift test in @ax/credentials/src/__tests__/refs.test.ts pins
// the ref format; if refs.ts changes, those tests will catch it.
// ---------------------------------------------------------------------------

function assertNoColon(field: string, value: string): void {
  if (value.includes(':')) {
    throw new PluginError({
      code: 'invalid-destination-identifier',
      plugin: PLUGIN_NAME,
      message: `${field} must not contain ':' (reserved as ref separator)`,
    });
  }
}

function refForDestination(dest: Destination): string {
  switch (dest.kind) {
    case 'provider':
      assertNoColon('provider', dest.provider);
      return `provider:${dest.provider}`;
    case 'skill-slot':
      assertNoColon('skillId', dest.skillId);
      assertNoColon('slot', dest.slot);
      return `skill:${dest.skillId}:${dest.slot}`;
    case 'mcp-env':
      assertNoColon('serverId', dest.serverId);
      assertNoColon('envName', dest.envName);
      return `mcp:${dest.serverId}:env:${dest.envName}`;
    case 'mcp-header':
      assertNoColon('serverId', dest.serverId);
      assertNoColon('headerName', dest.headerName);
      return `mcp:${dest.serverId}:header:${dest.headerName}`;
    case 'routine-hmac':
      assertNoColon('agentId', dest.agentId);
      assertNoColon('routinePath', dest.routinePath);
      return `routine:${dest.agentId}:${dest.routinePath}:hmac`;
  }
}

// ---------------------------------------------------------------------------
// Destination schema — mirrors Destination union in @ax/credentials/refs.ts.
// .strict() so unknown fields (typos, future extensions) are a 400 at this
// layer rather than silently ignored.
// ---------------------------------------------------------------------------

const DestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider'), provider: z.literal('anthropic') }).strict(),
  z
    .object({
      kind: z.literal('skill-slot'),
      skillId: z.string().min(1).max(128),
      slot: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp-env'),
      serverId: z.string().min(1).max(64),
      envName: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp-header'),
      serverId: z.string().min(1).max(64),
      headerName: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('routine-hmac'),
      agentId: z.string().min(1).max(64),
      routinePath: z.string().min(1).max(256),
    })
    .strict(),
]);

const CreateBodySchema = z
  .object({
    destination: DestinationSchema,
    scope: z.enum(['global', 'user', 'agent']),
    ownerId: z.string().min(1).max(128).nullable(),
    kind: z.literal('api-key'),
    payloadB64: z.string().min(1),
  })
  .strict();

const DeleteBodySchema = z
  .object({
    destination: DestinationSchema,
    scope: z.enum(['global', 'user', 'agent']),
    ownerId: z.string().min(1).max(128).nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface DestinationRouteDeps {
  bus: HookBus;
}

export function createDestinationHandlers(deps: DestinationRouteDeps): {
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  createSettings: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroySettings: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'credentials-destinations',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });

  /**
   * Core create logic. forceUser is non-null for /settings routes; the
   * scope and ownerId from the body are ignored and overridden to
   * scope='user' / ownerId=forceUser.id.
   */
  async function doCreate(
    req: RouteRequest,
    res: RouteResponse,
    forceUser: { id: string } | null,
  ): Promise<void> {
    const parsedBody = parseRequestBody(req.body);
    if (!parsedBody.ok) {
      res.status(parsedBody.status).json({ error: parsedBody.message });
      return;
    }
    const result = CreateBodySchema.safeParse(parsedBody.value);
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

    // URL param guard: destination.kind must match the :destinationKind route
    // param so a client can't accidentally route a mcp-env payload to the
    // provider endpoint and get a silently wrong ref.
    if (data.destination.kind !== req.params.destinationKind) {
      res
        .status(400)
        .json({ error: 'destination.kind does not match route param' });
      return;
    }

    const scope = forceUser !== null ? ('user' as const) : data.scope;
    const ownerId = forceUser !== null ? forceUser.id : data.ownerId;

    let ref: string;
    try {
      ref = refForDestination(data.destination as Destination);
    } catch (err) {
      if (writeServiceError(res, err)) return;
      throw err;
    }

    let payload: Uint8Array;
    try {
      payload = new Uint8Array(Buffer.from(data.payloadB64, 'base64'));
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
        scope,
        ownerId,
        ref,
        kind: data.kind,
        payload,
      });
      res.status(204).end();
    } catch (err) {
      if (writeServiceError(res, err)) return;
      throw err;
    }
  }

  /**
   * Core delete logic. forceUser is non-null for /settings routes; scope
   * and ownerId from the body are overridden similarly.
   */
  async function doDelete(
    req: RouteRequest,
    res: RouteResponse,
    forceUser: { id: string } | null,
  ): Promise<void> {
    const parsedBody = parseRequestBody(req.body);
    if (!parsedBody.ok) {
      res.status(parsedBody.status).json({ error: parsedBody.message });
      return;
    }
    const result = DeleteBodySchema.safeParse(parsedBody.value);
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

    if (data.destination.kind !== req.params.destinationKind) {
      res
        .status(400)
        .json({ error: 'destination.kind does not match route param' });
      return;
    }

    const scope = forceUser !== null ? ('user' as const) : data.scope;
    const ownerId = forceUser !== null ? forceUser.id : data.ownerId;

    let ref: string;
    try {
      ref = refForDestination(data.destination as Destination);
    } catch (err) {
      if (writeServiceError(res, err)) return;
      throw err;
    }

    try {
      await deps.bus.call('credentials:delete', ctx, { scope, ownerId, ref });
      res.status(204).end();
    } catch (err) {
      if (writeServiceError(res, err)) return;
      throw err;
    }
  }

  return {
    /** POST /admin/destinations/:destinationKind/credential */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doCreate(req, res, null);
    },

    /** POST /settings/destinations/:destinationKind/credential */
    async createSettings(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doCreate(req, res, { id: actor.id });
    },

    /** DELETE /admin/destinations/:destinationKind/credential */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doDelete(req, res, null);
    },

    /** DELETE /settings/destinations/:destinationKind/credential */
    async destroySettings(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doDelete(req, res, { id: actor.id });
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerDestinationRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const h = createDestinationHandlers({ bus });
  const routes: Array<{
    method: 'POST' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    {
      method: 'POST',
      path: '/admin/destinations/:destinationKind/credential',
      handler: h.create,
    },
    {
      method: 'DELETE',
      path: '/admin/destinations/:destinationKind/credential',
      handler: h.destroy,
    },
    {
      method: 'POST',
      path: '/settings/destinations/:destinationKind/credential',
      handler: h.createSettings,
    },
    {
      method: 'DELETE',
      path: '/settings/destinations/:destinationKind/credential',
      handler: h.destroySettings,
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

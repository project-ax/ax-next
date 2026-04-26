import {
  isRejection,
  makeChatContext,
  PluginError,
  type ChatContext,
  type HookBus,
} from '@ax/core';
import type {
  Actor,
  AddMemberInput,
  AddMemberOutput,
  CreateTeamInput,
  CreateTeamOutput,
  ListForUserInput,
  ListForUserOutput,
  ListMembersInput,
  ListMembersOutput,
  Membership,
  RemoveMemberInput,
  RemoveMemberOutput,
  Team,
  TeamRole,
} from './types.js';

// ---------------------------------------------------------------------------
// HTTP route handlers for /admin/teams[/:id/members[/:userId]].
//
// Mirrors the @ax/agents and @ax/mcp-client admin-routes pattern (Tasks 9
// and 10): handlers duck-type the http-server's request/response surface
// (Invariant I2 — no @ax/http-server import) so a future non-HTTP transport
// could provide them.
//
// All endpoints:
//   - require a valid signed session cookie (auth:require-user) — 401 on miss
//   - cap the request body at 64 KiB BEFORE JSON-parsing — 413 on overflow
//   - delegate to the existing teams:* service hooks for ACL + persistence
//
// Authorization model recap (see acl.ts + plugin.ts):
//   - POST /admin/teams           — any authenticated user (creator becomes admin)
//   - GET  /admin/teams           — any authenticated user (lists their own teams)
//   - POST /admin/teams/:id/members        — caller must be team admin
//   - DELETE /admin/teams/:id/members/:userId — caller must be team admin
//   - GET  /admin/teams/:id/members        — caller must be team admin
//
// "non-existent team" intentionally collapses to 403, NOT 404, so the
// endpoint does not leak existence to non-members. The hook itself returns
// PluginError{code:'forbidden'} when the actor's role is null (acl.ts).
// ---------------------------------------------------------------------------

/** 64 KiB cap on request bodies. Mirrors @ax/agents and @ax/mcp-client —
 *  smaller than http-server's 1 MiB cap so the admin API doesn't accept
 *  blobs the storage layer can't sanely hold, but plenty of slack for a
 *  displayName + role payload. */
export const ADMIN_BODY_MAX_BYTES = 64 * 1024;

const PLUGIN_NAME = '@ax/teams';

// --- duck-typed request/response (mirrors @ax/http-server's HttpRequest /
// HttpResponse minus the import) -------------------------------------------

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  /** Pattern-route capture for `/admin/teams/:id[/members/:userId]`. */
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

// --- helpers ---------------------------------------------------------------

/**
 * Try to authenticate. Returns the user on success, null on failure (we
 * already wrote the 401). Mirrors @ax/agents / @ax/mcp-client: the check
 * is inline, not a wrapper, so each handler has explicit control over its
 * response shape.
 */
async function requireUser(
  bus: HookBus,
  ctx: ChatContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<{ id: string; isAdmin: boolean } | null> {
  try {
    const result = await bus.call<
      { req: RouteRequest },
      { user: { id: string; isAdmin: boolean } }
    >('auth:require-user', ctx, { req });
    return { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    // Any auth failure (PluginError 'unauthenticated', or the auth plugin
    // not being loaded at all) is treated as a closed door. An admin
    // endpoint that can't authenticate fails closed.
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

interface ParsedBody<T> {
  ok: true;
  value: T;
}
interface ParseError {
  ok: false;
  status: 400 | 413;
  message: string;
}

/**
 * Body parsing pipeline. Returns either a parsed value or an error
 * descriptor. The caller writes the descriptor's status/message verbatim.
 *
 * Order of checks:
 *   1. 413 on body > ADMIN_BODY_MAX_BYTES (the http-server's own 1 MiB
 *      cap is wider; we tighten here for the admin surface).
 *   2. 400 on JSON.parse failure or empty body for endpoints that expect one.
 */
function parseJsonBody(body: Buffer): ParsedBody<unknown> | ParseError {
  if (body.length > ADMIN_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  if (body.length === 0) {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function serializeTeam(t: Team): Record<string, unknown> {
  return {
    id: t.id,
    displayName: t.displayName,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

function serializeMembership(m: Membership): Record<string, unknown> {
  return {
    teamId: m.teamId,
    userId: m.userId,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  };
}

/**
 * Translate a service-hook PluginError into an HTTP status. `forbidden`
 * → 403 (also covers "team doesn't exist" — see acl.requireAdmin: a
 * non-member's role is null, which collapses to forbidden). `not-found`
 * → 404. `cannot-remove-last-admin` → 400 with the explicit code so
 * callers can render a useful message. `invalid-payload` → 400.
 *
 * Returns true if a response was written.
 */
function writeServiceError(res: RouteResponse, err: unknown): boolean {
  if (err instanceof PluginError) {
    if (err.code === 'forbidden') {
      res.status(403).json({ error: 'forbidden' });
      return true;
    }
    if (err.code === 'not-found') {
      res.status(404).json({ error: 'not-found' });
      return true;
    }
    if (err.code === 'cannot-remove-last-admin') {
      res.status(400).json({ error: 'cannot-remove-last-admin' });
      return true;
    }
    if (err.code === 'duplicate-membership') {
      res.status(409).json({ error: 'duplicate-membership' });
      return true;
    }
    if (err.code === 'invalid-payload') {
      res.status(400).json({ error: err.message });
      return true;
    }
  }
  return false;
}

// --- handler factory -------------------------------------------------------

export interface AdminRouteDeps {
  bus: HookBus;
}

export function createAdminTeamRouteHandlers(deps: AdminRouteDeps) {
  // Per-handler-bundle ctx mirrors the @ax/agents and @ax/mcp-client
  // admin-routes pattern. The synthetic userId 'admin' shows up in audit
  // logs against this ctx; the real acting-user id flows through the
  // service-hook payloads (Actor.userId).
  const ctx = makeChatContext({
    sessionId: 'teams-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** POST /admin/teams */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      if (!isRecord(parsed.value)) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      const displayName = parsed.value.displayName;
      if (typeof displayName !== 'string') {
        res.status(400).json({ error: 'displayName must be a string' });
        return;
      }
      try {
        const out = await deps.bus.call<CreateTeamInput, CreateTeamOutput>(
          'teams:create',
          ctx,
          {
            actor: { userId: actor.id } satisfies Actor,
            displayName,
          },
        );
        res.status(201).json({ team: serializeTeam(out.team) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /admin/teams */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<ListForUserInput, ListForUserOutput>(
          'teams:list-for-user',
          ctx,
          { userId: actor.id },
        );
        res.status(200).json({ teams: out.teams.map(serializeTeam) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/teams/:id/members */
    async addMember(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const teamId = req.params.id;
      if (typeof teamId !== 'string' || teamId.length === 0) {
        res.status(400).json({ error: 'missing-team-id' });
        return;
      }
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      if (!isRecord(parsed.value)) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      const userId = parsed.value.userId;
      const role = parsed.value.role;
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId must be a non-empty string' });
        return;
      }
      if (role !== 'admin' && role !== 'member') {
        res.status(400).json({ error: "role must be 'admin' or 'member'" });
        return;
      }
      try {
        const out = await deps.bus.call<AddMemberInput, AddMemberOutput>(
          'teams:add-member',
          ctx,
          {
            actor: { userId: actor.id } satisfies Actor,
            teamId,
            userId,
            role: role as TeamRole,
          },
        );
        res.status(201).json({ membership: serializeMembership(out.membership) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** DELETE /admin/teams/:id/members/:userId */
    async removeMember(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const teamId = req.params.id;
      const userId = req.params.userId;
      if (typeof teamId !== 'string' || teamId.length === 0) {
        res.status(400).json({ error: 'missing-team-id' });
        return;
      }
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'missing-user-id' });
        return;
      }
      try {
        await deps.bus.call<RemoveMemberInput, RemoveMemberOutput>(
          'teams:remove-member',
          ctx,
          {
            actor: { userId: actor.id } satisfies Actor,
            teamId,
            userId,
          },
        );
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /admin/teams/:id/members */
    async listMembers(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const teamId = req.params.id;
      if (typeof teamId !== 'string' || teamId.length === 0) {
        res.status(400).json({ error: 'missing-team-id' });
        return;
      }
      try {
        const out = await deps.bus.call<ListMembersInput, ListMembersOutput>(
          'teams:list-members',
          ctx,
          {
            actor: { userId: actor.id } satisfies Actor,
            teamId,
          },
        );
        res
          .status(200)
          .json({ members: out.members.map(serializeMembership) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

// --- registration ----------------------------------------------------------

/**
 * Register all five admin routes against @ax/http-server. Returned
 * unregister callbacks should be tracked by the plugin and called on
 * shutdown so a re-init in tests doesn't trip duplicate-route.
 */
export async function registerAdminTeamRoutes(
  bus: HookBus,
  initCtx: ChatContext,
): Promise<Array<() => void>> {
  const handlers = createAdminTeamRouteHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'POST', path: '/admin/teams', handler: handlers.create },
    { method: 'GET', path: '/admin/teams', handler: handlers.list },
    {
      method: 'POST',
      path: '/admin/teams/:id/members',
      handler: handlers.addMember,
    },
    {
      method: 'DELETE',
      path: '/admin/teams/:id/members/:userId',
      handler: handlers.removeMember,
    },
    {
      method: 'GET',
      path: '/admin/teams/:id/members',
      handler: handlers.listMembers,
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

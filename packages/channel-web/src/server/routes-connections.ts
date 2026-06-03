/**
 * GET    /api/chat/connections/:agentId
 * DELETE /api/chat/connections/:agentId/skills/:skillId
 *
 * The Settings "Connections" surface (TASK-42) — a per-(user, agent) read of
 * "what this agent can do," merged from three sources via the bus:
 *   - default-attached (locked)   — skills:list, defaultAttached === true
 *   - agent-global    (locked)    — agents:resolve → agent.skillAttachments
 *   - per-user        (removable) — skills:list-user-attachments
 * Precedence on id collision mirrors the orchestrator union: user > agent >
 * default (a higher-precedence source claims a colliding id).
 *
 * Security: identity is the AUTHENTICATED user (auth:require-user); agents:resolve
 * enforces the agent ACL (a not-accessible agent → 404, no existence leak). The
 * per-user reads/writes are SERVER-FORCED to the resolved actor id — a caller
 * can never read or detach another user's row (IDOR guard). I2 — no cross-plugin
 * import; every hook is a duck-typed bus call. The detach hook
 * (`skills:detach-for-user`) is host-internal, NOT an IPC action: this
 * authenticated, CSRF-gated route is its only caller.
 */
import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}

interface AgentsResolveInput {
  agentId: string;
  userId: string;
}
interface AgentSkillAttachment {
  skillId: string;
  credentialBindings: Record<string, string>;
}
interface AgentsResolveOutput {
  agent: { id: string; skillAttachments: AgentSkillAttachment[] };
}

interface SkillsListInput {
  scope: 'all';
  ownerUserId: string;
}
interface SkillCapabilitySlotLite {
  slot: string;
  /** JIT P2 — when set, the slot binds the user's shared `account:<service>` vault. */
  account?: string;
}
interface SkillSummaryLite {
  id: string;
  description: string;
  defaultAttached: boolean;
  /** Declared connector-id references (TASK-100: a skill's reach is its connectors). */
  connectors?: string[];
  capabilities?: { credentials?: SkillCapabilitySlotLite[] };
}
interface SkillsListOutput {
  skills: SkillSummaryLite[];
}

// TASK-54 — host-grants (per-(user, agent) "always allow" sites). Host-internal
// hooks shipped by @ax/host-grants (TASK-44); this CSRF-gated route is the
// settings consumer. Conditionally called (optionalCalls + hasService) so a
// preset without @ax/host-grants degrades to empty.
interface HostGrantsListInput {
  ownerUserId: string;
  agentId: string;
}
interface HostGrantsListOutput {
  hosts: Array<{ host: string; grantedAt: string }>;
}
// The Settings one-list view: every grant the user owns across ALL their agents.
interface HostGrantsListForUserInput {
  ownerUserId: string;
}
interface HostGrantsListForUserOutput {
  grants: Array<{ host: string; agentId: string; grantedAt: string }>;
}
interface HostGrantsRevokeInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}
interface HostGrantsRevokeOutput {
  revoked: boolean;
}

// TASK-131 — proactive "Add a site". The durable grant write that mirrors the
// reactive wall's "Always for this agent" but initiated from Settings, not a
// mid-task wall. host-grants:grant is host-internal (the untrusted runner can
// never widen its own persistent egress — same posture as proxy:add-host); this
// authenticated, CSRF-gated route is its only Settings caller.
interface HostGrantsGrantInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}
interface HostGrantsGrantOutput {
  created: boolean;
}

interface ListUserAttachmentsInput {
  userId: string;
  agentId: string;
}
interface ListUserAttachmentsOutput {
  attachments: Array<{ skillId: string }>;
}

interface DetachInput {
  userId: string;
  agentId: string;
  skillId: string;
}
interface DetachOutput {
  removed: boolean;
}

// TASK-126 (Skills app-store) — self-install. The attach HOOK
// (`skills:attach-for-user`) is host-internal (NOT an IPC action — the untrusted
// runner must never self-attach a skill); this authenticated, CSRF-gated route
// is its only browser caller. A skill declares no capability block (TASK-100) —
// its reach is the connectors it references — so a self-install needs NO
// credential bindings (`{}`). The skillId is validated to be a real GLOBAL
// catalog id before the attach, so a browser can only ever install one of the
// workspace's vetted catalog skills (capability-minimization, invariant #5).
interface AttachInput {
  userId: string;
  agentId: string;
  skillId: string;
  credentialBindings: Record<string, string>;
}
interface AttachOutput {
  created: boolean;
}

export interface ConnectionSkill {
  skillId: string;
  description: string;
  source: 'default' | 'agent' | 'user';
  removable: boolean;
}
export interface ConnectionsResponse {
  agentId: string;
  skills: ConnectionSkill[];
}

export interface AllowedSitesResponse {
  agentId: string;
  hosts: Array<{ host: string; grantedAt: string }>;
}

/** The flat, all-agents allowed-sites view: every grant the user owns, each row
 *  carrying its `agentId` so the Settings UI can list each host once and show
 *  which agents it applies to. */
export interface AllAllowedSitesResponse {
  grants: Array<{ host: string; agentId: string; grantedAt: string }>;
}

/** One installable global-catalog skill for the app-store "Not installed" shelf. */
export interface CatalogSkillListing {
  skillId: string;
  description: string;
  defaultAttached: boolean;
  connectors: string[];
}
export interface CatalogSkillsResponse {
  skills: CatalogSkillListing[];
}

/** Resolve the authenticated caller, or write 401 and return null. */
async function authOr401(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<string | null> {
  try {
    const r = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
      'auth:require-user',
      ctx,
      { req },
    );
    return r.user.id;
  } catch (err) {
    if (err instanceof PluginError) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

/** Resolve the agent for ACL. Any PluginError → 404 (do not leak existence). */
async function resolveAgentOr404(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
  res: RouteResponse,
): Promise<AgentsResolveOutput['agent'] | null> {
  try {
    const r = await bus.call<AgentsResolveInput, AgentsResolveOutput>(
      'agents:resolve',
      ctx,
      { agentId, userId },
    );
    return r.agent;
  } catch (err) {
    if (err instanceof PluginError) {
      res.status(404).json({ error: 'agent-not-found' });
      return null;
    }
    throw err;
  }
}

export function makeConnectionsHandlers(deps: { bus: HookBus; initCtx: AgentContext }) {
  const { bus, initCtx } = deps;
  return {
    /** GET /api/chat/connections/:agentId */
    async get(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }

      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      const [userAtt, listed] = await Promise.all([
        bus.call<ListUserAttachmentsInput, ListUserAttachmentsOutput>(
          'skills:list-user-attachments',
          initCtx,
          { userId, agentId },
        ),
        bus.call<SkillsListInput, SkillsListOutput>('skills:list', initCtx, {
          scope: 'all',
          ownerUserId: userId,
        }),
      ]);

      const descById = new Map(listed.skills.map((s) => [s.id, s.description]));
      const defaultIds = new Set(
        listed.skills.filter((s) => s.defaultAttached).map((s) => s.id),
      );
      const userIds = new Set(userAtt.attachments.map((a) => a.skillId));
      const agentIds = new Set(agent.skillAttachments.map((a) => a.skillId));

      const skills: ConnectionSkill[] = [];
      const pushAll = (ids: string[], source: ConnectionSkill['source']) => {
        for (const id of [...ids].sort()) {
          skills.push({
            skillId: id,
            description: descById.get(id) ?? '',
            source,
            removable: source === 'user',
          });
        }
      };
      // Precedence user > agent > default: subtract higher-precedence ids.
      pushAll(
        [...defaultIds].filter((id) => !userIds.has(id) && !agentIds.has(id)),
        'default',
      );
      pushAll(
        [...agentIds].filter((id) => !userIds.has(id)),
        'agent',
      );
      pushAll([...userIds], 'user');

      res.status(200).json({ agentId, skills } satisfies ConnectionsResponse);
    },

    /** DELETE /api/chat/connections/:agentId/skills/:skillId */
    async detach(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      const skillId = req.params.skillId ?? '';
      if (agentId.length === 0 || skillId.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      // ACL: a not-accessible agent → 404 (no cross-user detach, no leak).
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      // userId is SERVER-FORCED from auth — never from the request.
      await bus.call<DetachInput, DetachOutput>('skills:detach-for-user', initCtx, {
        userId,
        agentId,
        skillId,
      });
      res.status(204).end(); // idempotent — 204 whether or not a row existed
    },

    /**
     * GET /api/chat/catalog-skills — the every-user read backing the Skills
     * app-store "Not installed · available in your workspace" shelf (TASK-126).
     * Returns the GLOBAL catalog as installable listings (id + description +
     * default flag + the connector-id references a skill declares).
     *
     * Why not reuse `/admin/skills`? That route is admin-gated (defense in depth
     * stays). The app-store shelf is every-user (a non-admin can self-install),
     * so it needs its own non-admin read. The data is metadata-only (no secrets,
     * no manifest bytes) — the public catalog surface.
     */
    async listCatalog(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const listed = await bus.call<SkillsListInput, SkillsListOutput>(
        'skills:list',
        initCtx,
        // The store's `scope:'global'` overload returns only admin-curated rows;
        // ownerUserId is unused for a pure-global read but required by the type.
        { scope: 'global' } as unknown as SkillsListInput,
      );
      const skills: CatalogSkillListing[] = listed.skills.map((s) => ({
        skillId: s.id,
        description: s.description,
        defaultAttached: s.defaultAttached,
        connectors: s.connectors ?? [],
      }));
      res.status(200).json({ skills } satisfies CatalogSkillsResponse);
    },

    /**
     * POST /api/chat/connections/:agentId/skills  body: { skillId }
     *
     * Self-install (TASK-126): attach a vetted GLOBAL catalog skill to the
     * caller's accessible agent (a per-(user, agent) user-scoped attachment).
     * The out-of-band twin of the in-chat grant — but for an admin-vetted catalog
     * item, so no approval wall (decision §#5): the UI shows a consent card and
     * this writes the attachment directly.
     *
     * Security (invariant #5): identity is SERVER-FORCED from auth (never the
     * body); the agent ACL is enforced via agents:resolve (404, no existence
     * leak); and the skillId MUST be a real global-catalog id (rejected 404
     * otherwise) so a browser can only ever install one of the workspace's vetted
     * skills — not an arbitrary id. A skill declares no capability block
     * (TASK-100), so the attachment carries empty credentialBindings.
     */
    async attach(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      // ACL: a not-accessible agent → 404 (no cross-user attach, no leak).
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      let skillId: string;
      try {
        const raw =
          req.body.length === 0
            ? {}
            : (JSON.parse(req.body.toString('utf8')) as unknown);
        const candidate = (raw as { skillId?: unknown }).skillId;
        if (typeof candidate !== 'string' || candidate.trim().length === 0) {
          res.status(400).json({ error: 'missing-skill-id' });
          return;
        }
        skillId = candidate.trim();
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      // Capability-min gate: the requested id MUST be a real GLOBAL catalog
      // skill. A browser may only self-install one of the workspace's vetted
      // catalog skills — never an arbitrary or user-private id.
      const listed = await bus.call<SkillsListInput, SkillsListOutput>(
        'skills:list',
        initCtx,
        { scope: 'global' } as unknown as SkillsListInput,
      );
      if (!listed.skills.some((s) => s.id === skillId)) {
        res.status(404).json({ error: 'skill-not-found' });
        return;
      }

      // userId is SERVER-FORCED from auth — never from the request. A skill
      // declares no caps (TASK-100) → empty bindings.
      const out = await bus.call<AttachInput, AttachOutput>(
        'skills:attach-for-user',
        initCtx,
        { userId, agentId, skillId, credentialBindings: {} },
      );
      res.status(201).json({ created: out.created });
    },

    // TASK-54 — Allowed-sites panel (design P3/P6/P7.3). The Settings mirror of
    // the reactive wall's "Always for this agent" choice (TASK-44). Same posture
    // as the connections reads: auth → agents:resolve ACL (404, no leak) →
    // host-grants:* with a SERVER-FORCED ownerUserId. host-grants:* are
    // host-internal hooks (the untrusted runner can never grant/revoke its own
    // persistent egress — same reasoning as proxy:add-host); this CSRF-gated
    // route is the only settings caller. Conditionally called + hasService-gated:
    // a preset without @ax/host-grants degrades to empty / idempotent-204.

    /**
     * POST /api/chat/allowed-sites/:agentId  body: { host }
     *
     * Proactive "Add a site" (TASK-131): durably grant a host to the agent's
     * "always allow" egress allowlist — the Settings-initiated twin of the
     * reactive wall's "Always for this agent" (TASK-44). The persisted grant
     * loads into a FUTURE session's allowlist at open; it never widens a LIVE
     * session out of band (mirror property, design P6).
     *
     * Security (invariant #5; the one widening surface here): identity is the
     * AUTHENTICATED user (auth:require-user → 401); the agent ACL is enforced
     * (agents:resolve → 404, no existence leak); ownerUserId is SERVER-FORCED
     * from auth — never the body (no cross-user grant / IDOR). The browser-
     * supplied host is UNTRUSTED — the @ax/host-grants store is the authoritative
     * validator (assertValidHost: exact-match hostname only, no wildcards/ports/
     * schemes) and cap (256/agent); a client field is convenience, never the gate.
     * Store PluginErrors map to honest statuses (invalid-host → 400, grant-limit
     * → 409). Unlike list/revoke (which degrade to empty / idempotent-204),
     * a grant that can't persist must NOT report success — without @ax/host-grants
     * this returns 503 (never silently a no-op).
     */
    async addAllowedSite(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      // ACL: a not-accessible agent → 404 (no cross-user grant, no leak).
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      let host: string;
      try {
        const raw =
          req.body.length === 0
            ? {}
            : (JSON.parse(req.body.toString('utf8')) as unknown);
        const candidate = (raw as { host?: unknown }).host;
        if (typeof candidate !== 'string' || candidate.trim().length === 0) {
          res.status(400).json({ error: 'missing-host' });
          return;
        }
        host = candidate.trim();
      } catch {
        res.status(400).json({ error: 'invalid-body' });
        return;
      }

      // The grant MUST persist — without @ax/host-grants the add cannot succeed.
      // 503 (not a silent success) so the UI surfaces an honest failure.
      if (!bus.hasService('host-grants:grant')) {
        res.status(503).json({ error: 'host-grants-unavailable' });
        return;
      }
      try {
        // ownerUserId SERVER-FORCED from auth — never from the request body.
        // The store re-validates the host (defense in depth) + enforces the cap.
        const out = await bus.call<HostGrantsGrantInput, HostGrantsGrantOutput>(
          'host-grants:grant',
          initCtx,
          { ownerUserId: userId, agentId, host },
        );
        res.status(201).json({ created: out.created });
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-host') {
          res.status(400).json({ error: 'invalid-host' });
          return;
        }
        if (err instanceof PluginError && err.code === 'grant-limit') {
          res.status(409).json({ error: 'grant-limit' });
          return;
        }
        throw err;
      }
    },

    /**
     * GET /api/chat/allowed-sites — the flat, all-agents view. Returns every
     * grant the session user owns across ALL their agents (each row carries its
     * agentId), so the Settings panel can list each host once and show which
     * agents it applies to. Owner-scoped at the store; no per-agent ACL needed
     * here because the list only ever contains the caller's OWN grants. Degrades
     * to an empty list when @ax/host-grants isn't loaded.
     */
    async listAllowedSitesForUser(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      let grants: AllAllowedSitesResponse['grants'] = [];
      if (bus.hasService('host-grants:list-for-user')) {
        const r = await bus.call<HostGrantsListForUserInput, HostGrantsListForUserOutput>(
          'host-grants:list-for-user',
          initCtx,
          { ownerUserId: userId },
        );
        grants = r.grants;
      }
      res.status(200).json({ grants } satisfies AllAllowedSitesResponse);
    },

    /** GET /api/chat/allowed-sites/:agentId */
    async listAllowedSites(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      let hosts: AllowedSitesResponse['hosts'] = [];
      if (bus.hasService('host-grants:list')) {
        const r = await bus.call<HostGrantsListInput, HostGrantsListOutput>(
          'host-grants:list',
          initCtx,
          { ownerUserId: userId, agentId },
        );
        hosts = r.hosts;
      }
      res.status(200).json({ agentId, hosts } satisfies AllowedSitesResponse);
    },

    /** DELETE /api/chat/allowed-sites/:agentId/:host
     *
     * Mirror property (design P6): revoking removes the DURABLE grant so it is
     * not re-loaded into the next session's allowlist at open (the grant store
     * is the source of truth; the live allowlist is a per-session snapshot built
     * at open). The current live session keeps the host until it ends — there is
     * no live-removal hook, and absence fails SAFE (a stale live host dies with
     * the session, never widens egress). Idempotent: 204 whether or not a row
     * existed (and whether or not @ax/host-grants is present). */
    async revokeAllowedSite(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      const host = req.params.host ?? '';
      if (agentId.length === 0 || host.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      // ACL: a not-accessible agent → 404 (no cross-user revoke, no leak).
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      if (bus.hasService('host-grants:revoke')) {
        // ownerUserId SERVER-FORCED from auth — never from the request.
        await bus.call<HostGrantsRevokeInput, HostGrantsRevokeOutput>(
          'host-grants:revoke',
          initCtx,
          { ownerUserId: userId, agentId, host },
        );
      }
      res.status(204).end();
    },
  };
}

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
interface HostGrantsRevokeInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}
interface HostGrantsRevokeOutput {
  revoked: boolean;
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

/** service → sorted, deduped skill ids whose manifest declares `account: <service>`. */
export interface AccountUsageResponse {
  usage: Record<string, string[]>;
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

    // TASK-54 — Allowed-sites panel (design P3/P6/P7.3). The Settings mirror of
    // the reactive wall's "Always for this agent" choice (TASK-44). Same posture
    // as the connections reads: auth → agents:resolve ACL (404, no leak) →
    // host-grants:* with a SERVER-FORCED ownerUserId. host-grants:* are
    // host-internal hooks (the untrusted runner can never grant/revoke its own
    // persistent egress — same reasoning as proxy:add-host); this CSRF-gated
    // route is the only settings caller. Conditionally called + hasService-gated:
    // a preset without @ax/host-grants degrades to empty / idempotent-204.

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

    /** GET /api/chat/account-usage
     *
     * The "used by" hint for the Settings "Keys" service-keyed vault (design
     * P2/P6, decision #13): which skills declare `account: <service>`. Derived
     * from skills:list (which already carries each slot's optional `account`) —
     * NO new hook. Auth-gated; degrades to {} when skills:list is absent. The
     * derivation is metadata-only (skill ids + service names), never secrets. */
    async accountUsage(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      // TASK-100 — a skill manifest declares no credential slots (its reach is
      // the connectors it references), so a SKILL never contributes to per-account
      // (`account:<service>`) usage anymore: that mapping now belongs to the
      // connector surface (TASK-99's Connectors tab derives a connector's account
      // usage). This route therefore reports no skill-derived account usage. The
      // null-prototype object preserves the prototype-pollution-safe response shape.
      const out: AccountUsageResponse['usage'] = Object.create(null) as AccountUsageResponse['usage'];
      res.status(200).json({ usage: out } satisfies AccountUsageResponse);
    },
  };
}

/**
 * GET    /api/chat/remembered-sites
 * DELETE /api/chat/remembered-sites/:host
 *
 * The Settings mirror of `@ax/tool-policy`'s `web_extract` egress allowlist —
 * the hosts a page read may be pointed at without stopping to ask, as opposed
 * to `routes-connections.ts`'s allowed-sites surface, which is host-grants
 * (sandbox egress / raw sockets). Conflating the two would mean approving a
 * page read also opened a socket to that host — they are deliberately
 * separate stores behind separate hooks.
 *
 * Security: identity is the AUTHENTICATED user (auth:require-user → 401).
 * Both `egress-allowlist:list` and `egress-allowlist:revoke` derive the owner
 * from `ctx.userId` and carry NO owner field on the payload. THIS ROUTE IS
 * WHERE THAT PROPERTY IS ACTUALLY WORTH SOMETHING: a trusted in-process plugin
 * could forge a ctx for anybody, but a browser cannot — it only ever reaches
 * the allowlist through here, and here the identity comes from the auth cookie.
 * So this route builds a per-request AgentContext carrying the AUTHENTICATED
 * user id (never `initCtx`, whose `userId` is `'system'`) and never invents an
 * owner field on the call input. Nothing the client sends names an owner,
 * because there is no field in which to name one.
 *
 * No per-agent ACL here (unlike routes-connections.ts's allowed-sites
 * surface): this store has no agent axis at all. The hook only ever returns
 * the caller's own rows plus the operator's `scope: 'global'` rows, because
 * it keys off `ctx.userId` server-side — there is no id to check against an
 * agent, so a reader must not "add the missing ACL" later.
 *
 * I2 — no cross-plugin import. `@ax/tool-policy` owns the store; every hook
 * here is a duck-typed bus call, and the wire types below are a LOCAL mirror
 * of its hook shapes (same pattern as `HostGrantsListForUserInput` etc. in
 * routes-connections.ts). Because the mirror is hand-declared, tsc cannot
 * warn us if the real hook's shape widens — `scope` is typed as the exact
 * union the hook promises today, and if it's ever switched on, an
 * unexpected value must be handled explicitly rather than falling through a
 * silent default (TASK-330 scar, `.claude/memory/patterns.md:1170`).
 */
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { authOr401 } from './routes-connections.js';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

// Deliberately empty — the hook derives the owner from ctx.userId, never
// from the payload.
type EgressAllowlistListInput = Record<string, never>;
export interface RememberedSite {
  host: string;
  scope: 'global' | 'user';
  rememberedAt: string;
}
interface EgressAllowlistListOutput {
  sites: RememberedSite[];
}

interface EgressAllowlistRevokeInput {
  host: string;
}
interface EgressAllowlistRevokeOutput {
  revoked: boolean;
}

export interface RememberedSitesResponse {
  sites: RememberedSite[];
}
export interface RevokeRememberedSiteResponse {
  revoked: boolean;
}

export function makeRememberedSitesHandlers(deps: { bus: HookBus; initCtx: AgentContext }) {
  const { bus, initCtx } = deps;
  return {
    /** GET /api/chat/remembered-sites */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      // agentId here is a LOG LABEL only, not an ownership axis — this store
      // has no agent axis, and the hook derives the owner from ctx.userId.
      const ctx = makeAgentContext({
        sessionId: 'settings-remembered-sites',
        agentId: '@ax/channel-web',
        userId,
      });

      if (!bus.hasService('egress-allowlist:list')) {
        // Absence means nothing is holding page reads in this preset, so
        // there is nothing to show — a quiet empty list is honest here (this
        // is a read; contrast the POST-add for host-grants, which 503s
        // because a grant that can't persist must not report success).
        res.status(200).json({ sites: [] } satisfies RememberedSitesResponse);
        return;
      }
      const r = await bus.call<EgressAllowlistListInput, EgressAllowlistListOutput>(
        'egress-allowlist:list',
        ctx,
        {},
      );
      res.status(200).json({ sites: r.sites } satisfies RememberedSitesResponse);
    },

    /** DELETE /api/chat/remembered-sites/:host */
    async revoke(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const host = req.params.host ?? '';
      if (host.length === 0) {
        res.status(400).json({ error: 'missing-host' });
        return;
      }
      // No hostname validation beyond emptiness here on purpose:
      // @ax/tool-policy is the trust boundary that WRITES this store and it
      // re-validates (normalizeHost). A second regex here is a second rule
      // to keep in step with that one, and getting it wrong fails in the
      // direction of refusing a legitimate revoke.
      const ctx = makeAgentContext({
        sessionId: 'settings-remembered-sites',
        agentId: '@ax/channel-web',
        userId,
      });

      if (!bus.hasService('egress-allowlist:revoke')) {
        res.status(200).json({ revoked: false } satisfies RevokeRememberedSiteResponse);
        return;
      }
      const r = await bus.call<EgressAllowlistRevokeInput, EgressAllowlistRevokeOutput>(
        'egress-allowlist:revoke',
        ctx,
        { host },
      );
      // 200 with a body, not 204, deliberately: the panel shows a different
      // sentence for "we'll ask about that next time" vs "that one was
      // already gone" (or is a non-revocable global entry), and a 204
      // collapses the two. Mirrors routes-connections.ts's addAllowedSite /
      // routes-workspace.ts's revokeGrant for the same reason.
      res.status(200).json({ revoked: r.revoked } satisfies RevokeRememberedSiteResponse);
    },
  };
}

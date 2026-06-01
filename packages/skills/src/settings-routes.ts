import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import type {
  SkillsListOutput,
  SkillsGetOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
  CatalogSubmitInput,
  CatalogSubmitOutput,
  SkillsListAuthoredInput,
  SkillsListAuthoredOutput,
  AuthoredSkillListing,
  SettingsAuthoredSkillsOutput,
} from './types.js';
import {
  requireAuthenticated,
  parseRequestBody,
  writeServiceError,
  splitSkillMd,
  upsertBodySchema,
  type RouteRequest,
  type RouteResponse,
} from './_routes-shared.js';

// ---------------------------------------------------------------------------
// /settings/skills* CRUD handlers (any authenticated user — user-scope only).
//
// Routes:
//   GET    /settings/skills          → list caller's user-scoped skills
//   GET    /settings/skills/:id      → get caller's user-scoped skill by id
//   POST   /settings/skills          → create/upsert caller's user-scoped skill
//   PUT    /settings/skills/:id      → update caller's user-scoped skill
//   DELETE /settings/skills/:id      → delete caller's user-scoped skill
//   POST   /settings/skills/:id/share → submit caller's own skill to the catalog
//
// Security contract:
//   - Every hook call forces scope:'user' + ownerUserId: actor.id.
//   - A user can only ever read/write THEIR OWN user-scoped rows.
//   - Global skills installed by admins are NOT visible here (use /admin/skills
//     or the skills:list{scope:'global'} hook directly for those).
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/skills';

// Structural mirror of @ax/agents' `agents:list-for-user` output (I2 — no
// @ax/agents import; the inter-plugin contract is the hook, not a TS import).
// We read only the fields the authored-listing route needs.
interface AgentsListForUserAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
}
interface AgentsListForUserOutput {
  agents: AgentsListForUserAgent[];
}

// The subset of the `skills:list-authored` projection this helper reads.
interface AuthoredProjectionLike {
  status: 'active' | 'pending' | 'quarantined';
  manifestYaml: string;
}

/**
 * JIT discoverability (TASK-83). Compute the `{ pendingCapabilities }` patch for
 * an authored-skill listing.
 *
 * TASK-100 — a skill manifest no longer declares capabilities at all (reach lives
 * only on the connectors a skill references). A skill therefore has NOTHING to
 * approve of its own: the only approvable surface is its connectors, which are
 * gated by the connector approval card (TASK-94), not the skill listing. So this
 * always returns `{}` (the optional `pendingCapabilities` field is simply never
 * present for a cap-free skill). Kept as a function (rather than inlined) so the
 * call sites read unchanged and a future per-skill affordance has one home.
 */
function pendingCapabilitiesFor(
  _s: AuthoredProjectionLike,
): Pick<AuthoredSkillListing, 'pendingCapabilities'> {
  return {};
}

export interface SettingsRouteDeps {
  bus: HookBus;
}

export function createSettingsSkillsHandlers(deps: SettingsRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  listAuthored: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  get: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  update: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  share: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  // The ctx here is the HTTP-server identity; actual scope isolation is
  // enforced by passing ownerUserId: actor.id to every hook call, NOT by ctx.
  const ctx = makeAgentContext({
    sessionId: 'skills-settings',
    agentId: PLUGIN_NAME,
    userId: 'user',
  });

  return {
    /** GET /settings/skills */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAuthenticated(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<
          { scope: 'user'; ownerUserId: string },
          SkillsListOutput
        >('skills:list', ctx, { scope: 'user', ownerUserId: actor.id });
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /**
     * GET /settings/skills/authored — list the caller's agent-AUTHORED skills
     * (TASK-85). The "My Skills" panel surfaces these alongside the user's
     * catalog skills so authored/approved work doesn't read as "No skills
     * installed".
     *
     * Authored skills are keyed `(ownerUserId, agentId)` and the panel is
     * per-user with no agent selector, so we aggregate across the caller's
     * PERSONAL agents (team agents have no single-owner authored namespace).
     * For each personal agent we read its authored projection via the existing
     * `skills:list-authored` hook (same plugin), keep only the user-facing
     * `active` + `pending` rows (quarantined drafts are NOT listed — a flagged
     * bundle is not an "installed" skill), and tag each with its owning agent.
     *
     * Security (I5): every authored read is forced to `ownerUserId: actor.id`,
     * and we only ever read agents the actor OWNS (`ownerType === 'user' &&
     * ownerId === actor.id`) — a user can never see another user's authored
     * skills. `agents:list-for-user` is a SOFT dep (hasService-guarded): a
     * preset without @ax/agents yields an empty authored list, not an error.
     */
    async listAuthored(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAuthenticated(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        // No agents plugin wired → no authored skills (safe default).
        if (!deps.bus.hasService('agents:list-for-user')) {
          res.status(200).json({ skills: [] } satisfies SettingsAuthoredSkillsOutput);
          return;
        }
        const { agents } = await deps.bus.call<
          { userId: string },
          AgentsListForUserOutput
        >('agents:list-for-user', ctx, { userId: actor.id });

        // Only the actor's OWN personal agents have an authored namespace
        // routable from this per-user surface.
        const ownAgentIds = agents
          .filter((a) => a.ownerType === 'user' && a.ownerId === actor.id)
          .map((a) => a.id);

        // TASK-100 — a skill no longer declares capabilities (reach lives on the
        // connectors it references), so there is no per-skill vault lookup to do
        // for an "approve early" affordance; the connector approval card owns that
        // surface now. The listing therefore carries no `pendingCapabilities`.
        const listings: AuthoredSkillListing[] = [];
        for (const agentId of ownAgentIds) {
          const { skills } = await deps.bus.call<
            SkillsListAuthoredInput,
            SkillsListAuthoredOutput
          >('skills:list-authored', ctx, { ownerUserId: actor.id, agentId });
          for (const s of skills) {
            // Surface only user-facing lifecycle states. A `quarantined` draft
            // is withheld (it was flagged by the safety scan; not an installed
            // skill).
            if (s.status !== 'active' && s.status !== 'pending') continue;
            listings.push({
              skillId: s.skillId,
              agentId,
              description: s.description,
              status: s.status,
              // TASK-100 — always `{}` (a skill declares no capabilities; the
              // connector approval card owns the approve-early affordance now).
              ...pendingCapabilitiesFor(s),
            });
          }
        }
        // Deterministic order: by skill id, then agent id.
        listings.sort(
          (a, b) =>
            (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0) ||
            (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
        );
        res.status(200).json({ skills: listings } satisfies SettingsAuthoredSkillsOutput);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /settings/skills/:id */
    async get(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAuthenticated(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }
      try {
        const detail = await deps.bus.call<
          { skillId: string; scope: 'user'; ownerUserId: string },
          SkillsGetOutput
        >('skills:get', ctx, { skillId: id, scope: 'user', ownerUserId: actor.id });
        res.status(200).json(detail);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /settings/skills */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAuthenticated(deps.bus, ctx, req, res);
      if (actor === null) return;

      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }

      const zodResult = upsertBodySchema.safeParse(parsedBody.value);
      if (!zodResult.success) {
        const first = zodResult.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }

      const split = splitSkillMd(zodResult.data.skillMd);
      if (split === null) {
        res.status(400).json({ error: 'missing frontmatter fence' });
        return;
      }

      // Forward `files` only when supplied — see the admin-routes create
      // handler for the omit-vs-replace semantics (absent = preserve current
      // bundle; present array, even `[]`, = replace). The host gate
      // (validateBundleFiles inside skills:upsert) is the source of truth.
      const filesPatch =
        zodResult.data.files !== undefined ? { files: zodResult.data.files } : {};

      try {
        const out = await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
          'skills:upsert',
          ctx,
          {
            ...split,
            ...filesPatch,
            defaultAttached: zodResult.data.defaultAttached ?? false,
            scope: 'user',
            ownerUserId: actor.id,
          },
        );
        res.status(201).json({ skillId: out.skillId, created: out.created });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** PUT /settings/skills/:id */
    async update(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAuthenticated(deps.bus, ctx, req, res);
      if (actor === null) return;

      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }

      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }

      const zodResult = upsertBodySchema.safeParse(parsedBody.value);
      if (!zodResult.success) {
        const first = zodResult.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }

      const split = splitSkillMd(zodResult.data.skillMd);
      if (split === null) {
        res.status(400).json({ error: 'missing frontmatter fence' });
        return;
      }

      // Quick name extraction to validate path-vs-manifest consistency
      // before the round-trip. Mirror of admin-routes.ts update handler.
      const nameMatch =
        /^\s*name\s*:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#\r\n]+))\s*(?:#.*)?$/m.exec(
          split.manifestYaml,
        );
      const skillIdFromManifest =
        nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
      if (skillIdFromManifest !== undefined && skillIdFromManifest !== id) {
        res
          .status(400)
          .json({ error: 'skill id in path does not match manifest name' });
        return;
      }

      // See admin-routes.ts update handler for the omit-vs-replace `files`
      // semantics. Forward verbatim only when present.
      const filesPatch =
        zodResult.data.files !== undefined ? { files: zodResult.data.files } : {};
      try {
        const out = await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
          'skills:upsert',
          ctx,
          {
            ...split,
            ...filesPatch,
            defaultAttached: zodResult.data.defaultAttached ?? false,
            scope: 'user',
            ownerUserId: actor.id,
          },
        );

        // Double-check after the parse in case our quick regex missed something.
        if (out.skillId !== id) {
          res
            .status(400)
            .json({ error: 'skill id in path does not match manifest name' });
          return;
        }

        res.status(200).json({ skillId: out.skillId, created: out.created });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** DELETE /settings/skills/:id */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAuthenticated(deps.bus, ctx, req, res);
      if (actor === null) return;

      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }

      try {
        await deps.bus.call<
          { skillId: string; scope: 'user'; ownerUserId: string },
          Record<string, never>
        >('skills:delete', ctx, { skillId: id, scope: 'user', ownerUserId: actor.id });
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /**
     * POST /settings/skills/:id/share — submit the caller's OWN user-scoped
     * skill to the org catalog (fires the existing `catalog:submit` hook with
     * kind:'share', TASK-41/§6D). This is the user-facing producer for the
     * admit-to-catalog queue: the host snapshots the skill's bytes, an admin
     * reviews them, and on admission they ship read-only org-wide while the
     * author's editable copy is retired.
     *
     * Security (invariant I5): the sharer identity (`requestedByUserId`) is
     * ALWAYS the authenticated actor — never the request body. `catalog:submit`
     * only allows sharing the requester's OWN skill, so a user can never propose
     * someone else's skill. The body is ignored entirely (no client fields are
     * needed — the skill id comes from the path, the bytes from the host-side
     * snapshot).
     *
     * Dedup: a second submission while one is pending returns `created:false`
     * (HTTP 200, not an error). Sharing an id the caller doesn't own throws
     * `skill-not-found` → 404 via `writeServiceError`.
     */
    async share(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAuthenticated(deps.bus, ctx, req, res);
      if (actor === null) return;

      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }

      try {
        const out = await deps.bus.call<CatalogSubmitInput, CatalogSubmitOutput>(
          'catalog:submit',
          ctx,
          {
            kind: 'share',
            skillId: id,
            requestedByUserId: actor.id, // host-supplied; body is ignored (I5)
          },
        );
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerSettingsSkillsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createSettingsSkillsHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/settings/skills', handler: handlers.list },
    // Literal /settings/skills/authored is an EXACT route — the router's
    // exact-match Map is checked before the /settings/skills/:id pattern scan,
    // so it never collides with `:id`. (Registration order is irrelevant here.)
    { method: 'GET', path: '/settings/skills/authored', handler: handlers.listAuthored },
    { method: 'GET', path: '/settings/skills/:id', handler: handlers.get },
    { method: 'POST', path: '/settings/skills', handler: handlers.create },
    { method: 'PUT', path: '/settings/skills/:id', handler: handlers.update },
    { method: 'DELETE', path: '/settings/skills/:id', handler: handlers.destroy },
    { method: 'POST', path: '/settings/skills/:id/share', handler: handlers.share },
  ];
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<unknown, { unregister: () => void }>(
        'http:register-route',
        initCtx,
        route,
      );
      unregisters.push(result.unregister);
    }
  } catch (err) {
    // If a later route fails to register (e.g. duplicate path), unwind the
    // ones that already went live before rethrowing — otherwise this throws
    // before returning `unregisters` and the plugin-level catch can't reach
    // the already-registered route, leaking it. (Mirrors registerCatalogRoutes.)
    while (unregisters.length > 0) {
      const fn = unregisters.pop();
      try {
        fn?.();
      } catch {
        // best-effort unwind
      }
    }
    throw err;
  }
  return unregisters;
}

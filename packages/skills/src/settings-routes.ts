import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import type {
  SkillsListOutput,
  SkillsGetOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
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
//
// Security contract:
//   - Every hook call forces scope:'user' + ownerUserId: actor.id.
//   - A user can only ever read/write THEIR OWN user-scoped rows.
//   - Global skills installed by admins are NOT visible here (use /admin/skills
//     or the skills:list{scope:'global'} hook directly for those).
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/skills';

export interface SettingsRouteDeps {
  bus: HookBus;
}

export function createSettingsSkillsHandlers(deps: SettingsRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  get: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  update: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
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
    { method: 'GET', path: '/settings/skills/:id', handler: handlers.get },
    { method: 'POST', path: '/settings/skills', handler: handlers.create },
    { method: 'PUT', path: '/settings/skills/:id', handler: handlers.update },
    { method: 'DELETE', path: '/settings/skills/:id', handler: handlers.destroy },
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

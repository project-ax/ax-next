import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import type {
  SkillsCheckForUpdatesOutput,
  SkillsListOutput,
  SkillsGetOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
} from './types.js';
import {
  ADMIN_BODY_MAX_BYTES,
  requireAuthenticated,
  requireAdmin,
  parseRequestBody,
  writeServiceError,
  splitSkillMd,
  upsertBodySchema,
  type RouteRequest,
  type RouteResponse,
} from './_routes-shared.js';

// Re-export the shared plumbing so existing consumers (tests, plugin.ts) that
// import from 'admin-routes.js' continue to compile without changes.
export type {
  RouteRequest,
  RouteResponse,
  AuthedUser,
  ParseBodyResult,
} from './_routes-shared.js';
export {
  ADMIN_BODY_MAX_BYTES,
  requireAuthenticated,
  requireAdmin,
  parseRequestBody,
  writeServiceError,
} from './_routes-shared.js';

// ---------------------------------------------------------------------------
// /admin/skills* CRUD handlers (admin-only).
//
// Routes:
//   GET    /admin/skills            → list skill summaries
//   GET    /admin/skills/:id        → get full skill detail
//   POST   /admin/skills            → create (or upsert) from full SKILL.md
//   PUT    /admin/skills/:id        → update from full SKILL.md
//   DELETE /admin/skills/:id        → delete (409 if in-use)
//
// Shared plumbing lives in _routes-shared.ts (Invariant I4: one source of
// truth per concept). Re-exported above for backward compatibility.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/skills';

export interface AdminRouteDeps {
  bus: HookBus;
}

export function createAdminSkillsHandlers(deps: AdminRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  get: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  update: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  checkUpdate: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  refresh: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'skills-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** GET /admin/skills */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        // Explicitly scope=global so the admin UI always shows only the
        // admin-managed skill list, not individual users' private copies.
        const out = await deps.bus.call<{ scope: 'global' }, SkillsListOutput>(
          'skills:list',
          ctx,
          { scope: 'global' },
        );
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /admin/skills/:id */
    async get(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }
      try {
        // Explicitly scope=global so the admin UI always shows only the
        // admin-managed skill, not the user's private copy of the same id.
        const detail = await deps.bus.call<{ skillId: string; scope: 'global' }, SkillsGetOutput>(
          'skills:get',
          ctx,
          { skillId: id, scope: 'global' },
        );
        res.status(200).json(detail);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/skills */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
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

      try {
        const out = await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
          'skills:upsert',
          ctx,
          { ...split, defaultAttached: zodResult.data.defaultAttached ?? false },
        );
        res.status(201).json({ skillId: out.skillId, created: out.created });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** PUT /admin/skills/:id */
    async update(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
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
      // before the round-trip. The full parse happens inside skills:upsert
      // and the post-call equality check below is the source of truth;
      // this is just to give the caller a crisper 4xx without taking the
      // round-trip. Accepts unquoted, single-quoted, and double-quoted
      // scalars with optional trailing comments — same surface yaml itself
      // would accept.
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

      try {
        const out = await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
          'skills:upsert',
          ctx,
          { ...split, defaultAttached: zodResult.data.defaultAttached ?? false },
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

    /** DELETE /admin/skills/:id */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;

      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }

      try {
        await deps.bus.call<{ skillId: string }, Record<string, never>>(
          'skills:delete',
          ctx,
          { skillId: id },
        );
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/skills/:id/check-update */
    async checkUpdate(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }
      try {
        const out = await deps.bus.call<
          { skillId: string },
          SkillsCheckForUpdatesOutput
        >('skills:check-for-updates', ctx, { skillId: id });
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/skills/:id/refresh-from-source — convenience: check + if available, upsert. */
    async refresh(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }
      try {
        const check = await deps.bus.call<
          { skillId: string },
          SkillsCheckForUpdatesOutput
        >('skills:check-for-updates', ctx, { skillId: id });
        if (!check.available || check.latestSkillMd === undefined) {
          res.status(200).json({ updated: false, currentVersion: check.currentVersion });
          return;
        }
        // Re-use the splitter so /refresh follows the same upsert path as /create.
        const split = splitSkillMd(check.latestSkillMd);
        if (split === null) {
          res.status(502).json({ error: 'remote skill missing frontmatter fence' });
          return;
        }
        await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
          'skills:upsert',
          ctx,
          { ...split },
        );
        res.status(200).json({ updated: true, newVersion: check.latestVersion });
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

export async function registerAdminSkillsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAdminSkillsHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/skills', handler: handlers.list },
    { method: 'GET', path: '/admin/skills/:id', handler: handlers.get },
    { method: 'POST', path: '/admin/skills', handler: handlers.create },
    { method: 'PUT', path: '/admin/skills/:id', handler: handlers.update },
    { method: 'DELETE', path: '/admin/skills/:id', handler: handlers.destroy },
    { method: 'POST', path: '/admin/skills/:id/check-update', handler: handlers.checkUpdate },
    { method: 'POST', path: '/admin/skills/:id/refresh-from-source', handler: handlers.refresh },
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

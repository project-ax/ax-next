import { makeAgentContext, PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { SkillsStore } from './store.js';
import type {
  SkillsCheckForUpdatesOutput,
  SkillsListOutput,
  SkillsGetOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
  SkillTier,
} from './types.js';
import { classifyTier } from './catalog-tier.js';
import {
  requireAdmin,
  parseRequestBody,
  writeServiceError,
  splitSkillMd,
  upsertBodySchema,
  patchDefaultBodySchema,
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
  /**
   * The plugin's own global skills store. OPTIONAL so the bus-only handler
   * construction the unit tests use (`{ bus }`) keeps compiling. When present,
   * the PATCH default-toggle route uses the store's ATOMIC partial-update
   * (`setDefaultAttached`) instead of the racy read-detail + re-upsert path —
   * the whole point of TASK-57. Production (plugin.ts) always injects it.
   * Same package (no cross-plugin import), so the route may hold a direct store
   * reference without violating I2.
   */
  store?: SkillsStore;
}

export function createAdminSkillsHandlers(deps: AdminRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  get: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  update: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  checkUpdate: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  refresh: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  setDefaultAttached: (req: RouteRequest, res: RouteResponse) => Promise<void>;
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
        // Annotate each summary with its server-derived supply-chain tier
        // (classifyTier is the single source of truth — never a stored column,
        // never re-derived on the client). This is the set the broker proposes
        // from (design §3).
        const skills = out.skills.map((s) => ({
          ...s,
          tier: classifyTier(s.capabilities) satisfies SkillTier,
        }));
        res.status(200).json({ skills });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /admin/skills/:id
     *
     * `?missingOk=1` (query keys are lowercased by http-server) turns a
     * missing skill into a clean `200 { skill: null }` instead of a `404`,
     * and wraps a found skill as `200 { skill: detail }`. The Admit-queue
     * diff probe asks "is there a current catalog version?" for a net-new
     * share request — without the opt-in param the route 404s (correct REST),
     * and the browser auto-logs that *expected* 404 as a console error. The
     * param lets the probe avoid provoking the 404 at all. The default
     * (no param) behavior is unchanged: found → bare detail, missing → 404. */
    async get(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing skill id' });
        return;
      }
      const missingOk = req.query.missingok === '1';
      try {
        // Explicitly scope=global so the admin UI always shows only the
        // admin-managed skill, not the user's private copy of the same id.
        const detail = await deps.bus.call<{ skillId: string; scope: 'global' }, SkillsGetOutput>(
          'skills:get',
          ctx,
          { skillId: id, scope: 'global' },
        );
        res.status(200).json(missingOk ? { skill: detail } : detail);
      } catch (err) {
        if (missingOk && err instanceof PluginError && err.code === 'skill-not-found') {
          res.status(200).json({ skill: null });
          return;
        }
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

      // Forward `files` ONLY when the caller supplied the key. Omitting it
      // tells skills:upsert to leave the current bundle unchanged (store.upsert
      // rewrites the tree only when `files !== undefined`); a present array —
      // even `[]` — replaces it. The host gate (validateBundleFiles) is the
      // source of truth and surfaces invalid-bundle-file as a 400 below.
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
          },
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

      // `files` semantics: a SKILL.md-only caller (no `files` key) preserves the
      // current bundle — skills:upsert treats an absent `files` as "leave the
      // current bundle unchanged" (store.upsert only rewrites the tree when
      // `files !== undefined`). The multi-file editor sends the full intended
      // set (even `[]` to clear), which REPLACES the bundle. We forward `files`
      // verbatim only when present; we never re-read + re-send the existing
      // files on the caller's behalf — a stale read could clobber a concurrent
      // change, and on a name-mismatch (caught only after the upsert below) it
      // would copy this id's files onto the wrong parsed id before the 400.
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

    /** PATCH /admin/skills/:id — partial update: flip defaultAttached only.
     *
     * Race-safe via the store's ATOMIC partial-update (TASK-57): when a `store`
     * is injected (production), the flag flip is a single SELECT … FOR UPDATE +
     * flag-only UPDATE inside one transaction (store.setDefaultAttached). It
     * never reads-then-rewrites the manifest/body/bundle, so a concurrent
     * SKILL.md edit can no longer be clobbered (the documented read-then-write
     * race this route used to carry — same class as plugin.ts's credential-purge
     * `previous` read). The I-S2 "default skills are instruction-only" guard runs
     * inside the same lock; a credentialed skill is rejected as
     * `default-attached-requires-no-credentials` (→ 400).
     *
     * FALLBACK (no `store`, e.g. a bus-only handler in a stripped harness): the
     * original `skills:get` + `skills:upsert` path. It OMITS `files` so the
     * bundle is preserved, but the manifest/body are read-then-written and so
     * still carry the small race window. Production never takes this path. */
    async setDefaultAttached(req: RouteRequest, res: RouteResponse): Promise<void> {
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
      const zr = patchDefaultBodySchema.safeParse(parsedBody.value);
      if (!zr.success) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      try {
        if (deps.store !== undefined) {
          // Atomic path: one transaction, flag-only write.
          let result: { found: boolean; defaultAttached: boolean };
          try {
            result = await deps.store.setDefaultAttached(id, zr.data.defaultAttached);
          } catch (err) {
            // The store throws a plain Error for the I-S2 credential rejection;
            // re-wrap it as the PluginError code writeServiceError maps to 400
            // (same code the full-upsert path surfaces — one source of truth).
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith('default-attached-requires-no-credentials')) {
              throw new PluginError({
                code: 'default-attached-requires-no-credentials',
                plugin: PLUGIN_NAME,
                message: msg,
              });
            }
            throw err;
          }
          if (!result.found) {
            throw new PluginError({
              code: 'skill-not-found',
              plugin: PLUGIN_NAME,
              message: `skill '${id}' does not exist`,
            });
          }
          res.status(200).json({ skillId: id, defaultAttached: result.defaultAttached });
          return;
        }

        // Fallback (no store injected): the original read-then-write path.
        const detail = await deps.bus.call<{ skillId: string; scope: 'global' }, SkillsGetOutput>(
          'skills:get',
          ctx,
          { skillId: id, scope: 'global' },
        );
        await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', ctx, {
          manifestYaml: detail.manifestYaml,
          bodyMd: detail.bodyMd,
          defaultAttached: zr.data.defaultAttached,
          scope: 'global',
        });
        res.status(200).json({ skillId: id, defaultAttached: zr.data.defaultAttached });
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
  // The plugin's own global store, forwarded so the PATCH default-toggle route
  // uses the atomic partial-update (TASK-57). Optional to keep test call sites
  // that don't need it (register-routes-unwind) compiling unchanged.
  store?: SkillsStore,
): Promise<Array<() => void>> {
  const handlers = createAdminSkillsHandlers(store !== undefined ? { bus, store } : { bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/skills', handler: handlers.list },
    { method: 'GET', path: '/admin/skills/:id', handler: handlers.get },
    { method: 'POST', path: '/admin/skills', handler: handlers.create },
    { method: 'PUT', path: '/admin/skills/:id', handler: handlers.update },
    { method: 'PATCH', path: '/admin/skills/:id', handler: handlers.setDefaultAttached },
    { method: 'DELETE', path: '/admin/skills/:id', handler: handlers.destroy },
    { method: 'POST', path: '/admin/skills/:id/check-update', handler: handlers.checkUpdate },
    { method: 'POST', path: '/admin/skills/:id/refresh-from-source', handler: handlers.refresh },
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

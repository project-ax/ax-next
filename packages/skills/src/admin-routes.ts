import { makeAgentContext, PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type {
  SkillsListOutput,
  SkillsGetOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
} from './types.js';

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
// Shared plumbing copied locally per Invariant I2 (no cross-plugin imports):
//   - RouteRequest / RouteResponse / AuthedUser interfaces
//   - ADMIN_BODY_MAX_BYTES
//   - requireAuthenticated / requireAdmin
//   - parseRequestBody
//   - writeServiceError (skills-specific error codes)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Duck-typed route plumbing (copied from @ax/credentials-admin-routes/shared.ts
// — do NOT import that package, Invariant I2 forbids cross-plugin imports).
// ---------------------------------------------------------------------------

export const ADMIN_BODY_MAX_BYTES = 64 * 1024;

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

export interface AuthedUser {
  id: string;
  isAdmin: boolean;
}

export async function requireAuthenticated(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  try {
    const result = await bus.call<
      { req: RouteRequest },
      { user: { id: string; isAdmin: boolean } }
    >('auth:require-user', ctx, { req });
    return { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

export async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  const actor = await requireAuthenticated(bus, ctx, req, res);
  if (actor === null) return null;
  if (!actor.isAdmin) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
}

export type ParseBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export function parseRequestBody(body: Buffer): ParseBodyResult {
  if (body.length > ADMIN_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}

// ---------------------------------------------------------------------------
// Skills-specific PluginError -> HTTP status mapping
// ---------------------------------------------------------------------------

export function writeServiceError(res: RouteResponse, err: unknown): boolean {
  if (err instanceof PluginError) {
    if (err.code === 'skill-not-found') {
      res.status(404).json({ error: err.message });
      return true;
    }
    if (err.code === 'skill-in-use') {
      res.status(409).json({ error: err.message, code: 'skill-in-use' });
      return true;
    }
    const badRequestCodes = new Set([
      'invalid-name',
      'invalid-description',
      'invalid-host',
      'invalid-slot',
      'duplicate-slot',
      'invalid-kind',
      'invalid-yaml',
      'invalid-manifest',
      'invalid-version',
      'inline-secret-forbidden',
      'capability-deferred',
      'invalid-payload',
      'default-attached-requires-no-credentials',
    ]);
    if (badRequestCodes.has(err.code)) {
      res.status(400).json({ error: err.message, code: err.code });
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

const SKILL_MD_MAX = 32 * 1024;

const upsertBodySchema = z
  .object({
    skillMd: z.string().min(1).max(SKILL_MD_MAX),
    defaultAttached: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// SKILL.md splitter
//
// Expects: ---\n<frontmatter>\n---\n<body> (body optional).
// Returns null if the fence pair is absent.
// ---------------------------------------------------------------------------

function splitSkillMd(
  skillMd: string,
): { manifestYaml: string; bodyMd: string } | null {
  // Accept both LF and CRLF line endings on every fence boundary so a
  // SKILL.md authored / copy-pasted on Windows doesn't 400 here.
  const re = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*)|$)/;
  const m = re.exec(skillMd);
  if (m === null) return null;
  return { manifestYaml: m[1] ?? '', bodyMd: m[2] ?? '' };
}

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
        const out = await deps.bus.call<Record<string, never>, SkillsListOutput>(
          'skills:list',
          ctx,
          {},
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
        const detail = await deps.bus.call<{ skillId: string }, SkillsGetOutput>(
          'skills:get',
          ctx,
          { skillId: id },
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

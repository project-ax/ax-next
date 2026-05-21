import { PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared route plumbing for @ax/skills HTTP route modules.
//
// This file is MODULE-PRIVATE to the @ax/skills package — NOT part of the
// public index.ts surface. It exists solely to avoid duplicating guards,
// body parsing, and schema definitions across admin-routes.ts and
// settings-routes.ts (Invariant I4: one source of truth per concept).
//
// Copied from @ax/credentials-admin-routes/shared.ts per Invariant I2 (no
// cross-plugin imports). If the shared surface needs to change, change it
// here; both route modules import from here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Duck-typed route plumbing
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
      'invalid-mcp-command',
      'invalid-mcp-transport',
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

export const SKILL_MD_MAX = 32 * 1024;

export const upsertBodySchema = z
  .object({
    skillMd: z.string().min(1).max(SKILL_MD_MAX),
    defaultAttached: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// SKILL.md splitter — re-exported from @ax/skills-parser (pure leaf package).
// ---------------------------------------------------------------------------

export { splitSkillMd } from '@ax/skills-parser';

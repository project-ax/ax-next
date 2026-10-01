import { PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
export const PLUGIN_NAME = '@ax/model-policy';
export const POLICY_STORAGE_KEY = 'settings:model-policy';
export const SERVICE_GET_POLICY = 'models:get-policy';

export const MAX_ALLOWED_MODELS = 1000;
export const MAX_REF_CHARS = 200;
export const POLICY_BODY_MAX_BYTES = 256 * 1024;
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
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

export interface AuthedUser {
  id: string;
  isAdmin: boolean;
}

/** 401 when there is no session, 403 when the user is not an admin. Returns the admin, or null after answering. */
export async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  let actor: AuthedUser;
  try {
    const result = await bus.call<{ req: RouteRequest }, { user: { id: string; isAdmin: boolean } }>(
      'auth:require-user',
      ctx,
      { req },
    );
    actor = { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
  if (actor.isAdmin !== true) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
}

export type ParseBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export function parseRequestBody(body: Buffer): ParseBodyResult {
  if (body.length > POLICY_BODY_MAX_BYTES) return { ok: false, status: 413, message: 'body-too-large' };
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}

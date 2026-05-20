import {
  isRejection,
  PluginError,
  makeAgentContext,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// /admin/settings/:key  (GET / PUT)
//
// Tiny HTTP layer over the kernel `storage:get` / `storage:set` surface for
// admin-managed, non-credential global settings. The set of allowed `:key`
// values is an explicit allowlist (see ALLOWED_SETTINGS) — a free-form KV
// admin surface would be a footgun (anyone can clobber any storage key).
//
// Today the only entry is `fast-model`, which the admin "Model config" tab
// writes and the @ax/conversation-titles plugin reads (with a fallback to
// plugin config). The onboarding wizard seeds the same key on first run.
//
// Wire shape:
//   GET  /admin/settings/:key            → { value: string | null }
//   PUT  /admin/settings/:key  body:     → 204
//        { value: string }
//
// `value` flows as a plain JSON string so the admin UI doesn't have to
// base64-encode model ids (these aren't secrets). The storage layer reads
// and writes bytes; we encode/decode at this boundary.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/admin-settings-routes';

/**
 * Public allowlist of `:key` values → underlying storage key. Adding a new
 * entry requires a deliberate code change (and the storage key gets the
 * `settings:` prefix so it shares a namespace separate from credentials,
 * sessions, audit logs, etc.).
 */
export const ALLOWED_SETTINGS = {
  'fast-model': 'settings:fast-model',
} as const;

export type SettingsKey = keyof typeof ALLOWED_SETTINGS;

const VALUE_MAX_LEN = 256;

// ---------------------------------------------------------------------------
// Duck-typed RouteRequest / RouteResponse (no @ax/http-server import per
// Invariant I2). Mirrors the shape used by credentials-admin-routes and
// routines-admin-routes.
// ---------------------------------------------------------------------------

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

async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  let actor: AuthedUser;
  try {
    const result = await bus.call<
      { req: RouteRequest },
      { user: { id: string; isAdmin: boolean } }
    >('auth:require-user', ctx, { req });
    actor = { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
  if (!actor.isAdmin) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
}

const SETTINGS_BODY_MAX_BYTES = 4 * 1024;

function parseBody(body: Buffer): { ok: true; value: unknown } | { ok: false; status: 400 | 413; message: string } {
  if (body.length > SETTINGS_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}

const PutBodySchema = z
  .object({
    value: z.string().min(1).max(VALUE_MAX_LEN),
  })
  .strict();

function resolveSettingsKey(
  req: RouteRequest,
  res: RouteResponse,
): { storageKey: string } | null {
  const k = req.params.key;
  if (k === undefined || !(k in ALLOWED_SETTINGS)) {
    res.status(404).json({ error: 'unknown-setting' });
    return null;
  }
  const storageKey = ALLOWED_SETTINGS[k as SettingsKey];
  return { storageKey };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface SettingsRouteDeps {
  bus: HookBus;
}

export function createSettingsHandlers(deps: SettingsRouteDeps): {
  get: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  put: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'admin-settings',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });

  return {
    /** GET /admin/settings/:key */
    async get(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const resolved = resolveSettingsKey(req, res);
      if (resolved === null) return;
      const out = await deps.bus.call<
        { key: string },
        { value: Uint8Array | undefined }
      >('storage:get', ctx, { key: resolved.storageKey });
      if (out.value === undefined || out.value.length === 0) {
        res.status(200).json({ value: null });
        return;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(out.value);
      } catch {
        // Stored bytes are not valid UTF-8 — surface as null so the UI
        // doesn't render garbage. A future writer should either reject
        // non-UTF-8 at write time (we do, via z.string()) or own its own
        // encoding contract here.
        res.status(200).json({ value: null });
        return;
      }
      res.status(200).json({ value: text });
    },

    /** PUT /admin/settings/:key */
    async put(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const resolved = resolveSettingsKey(req, res);
      if (resolved === null) return;
      const parsed = parseBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const schemaResult = PutBodySchema.safeParse(parsed.value);
      if (!schemaResult.success) {
        const first = schemaResult.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }
      await deps.bus.call('storage:set', ctx, {
        key: resolved.storageKey,
        value: new TextEncoder().encode(schemaResult.data.value),
      });
      res.status(204).end();
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminSettingsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createSettingsHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'PUT';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    {
      method: 'GET',
      path: '/admin/settings/:key',
      handler: handlers.get,
    },
    {
      method: 'PUT',
      path: '/admin/settings/:key',
      handler: handlers.put,
    },
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

import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import {
  parseRequestBody,
  requireAdmin,
  requireUser,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

// ---------------------------------------------------------------------------
// /admin/credentials/oauth/* + /settings/credentials/oauth/* — web-paste
// flow for OAuth-style credentials (anthropic-oauth, future kinds).
//
// Sequence:
//   POST .../oauth/start   { scope?, ownerId?, ref, kind }
//     → bus.call credentials:login:<kind>             (PKCE + authorize URL)
//     → bus.call credentials:oauth:stash-pending       (in-memory state)
//     → 200 { pendingId, authorizeUrl, instructions }
//
//   user signs in at provider, copies code from redirect page
//
//   POST .../oauth/finish  { pendingId, code }
//     → bus.call credentials:oauth:claim-pending       (single-use, userId-bound)
//     → bus.call credentials:exchange:<kind>           (code → token blob)
//     → bus.call credentials:set                       (writes encrypted blob)
//     → 201 { credential }
//
// The admin variant accepts the full scope axis. The settings variant
// forces scope='user', ownerId=actor.id and omits scope/ownerId from
// the request body — same posture as the CRUD settings handlers.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/credentials-admin-routes/oauth';

const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

const adminStartSchema = z
  .object({
    scope: z.enum(['global', 'user', 'agent']),
    ownerId: z.string().regex(OWNER_ID_RE).nullable(),
    ref: z.string().regex(REF_RE),
    kind: z.string().regex(KIND_RE),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === 'global' && v.ownerId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId must be null when scope='global'",
        path: ['ownerId'],
      });
    }
    if ((v.scope === 'user' || v.scope === 'agent') && v.ownerId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ownerId is required when scope='${v.scope}'`,
        path: ['ownerId'],
      });
    }
  });

const settingsStartSchema = z
  .object({
    ref: z.string().regex(REF_RE),
    kind: z.string().regex(KIND_RE),
  })
  .strict();

// pendingId is 32 random bytes → 43 base64url chars. Floor at 20, cap at
// 64 so stray query-string junk doesn't masquerade as an id. `code` is
// the provider's authorization code; values vary by provider but 2 KiB
// is a generous ceiling.
const finishSchema = z
  .object({
    pendingId: z
      .string()
      .min(20)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    code: z.string().min(1).max(2048),
  })
  .strict();

export interface OauthDeps {
  bus: HookBus;
}

interface PendingEntry {
  codeVerifier: string;
  state: string;
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  userId: string;
}

interface ExchangeResult {
  payload: Uint8Array;
  expiresAt?: number;
  kind: string;
}

interface LoginResult {
  authorizeUrl: string;
  codeVerifier: string;
  state: string;
}

/**
 * Shared `finish` body for both admin and settings flows. The only thing
 * that differs is the auth gate before this fires; the claim/exchange/set
 * sequence is identical.
 */
async function runFinish(
  bus: HookBus,
  ctx: AgentContext,
  actorId: string,
  req: RouteRequest,
  res: RouteResponse,
): Promise<void> {
  const parsedBody = parseRequestBody(req.body);
  if (!parsedBody.ok) {
    res.status(parsedBody.status).json({ error: parsedBody.message });
    return;
  }
  const result = finishSchema.safeParse(parsedBody.value);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error:
        first?.message !== undefined && first.message.length > 0
          ? first.message
          : 'invalid-payload',
    });
    return;
  }
  const claim = await bus.call<
    { pendingId: string; expectedUserId: string },
    { entry: PendingEntry | undefined }
  >('credentials:oauth:claim-pending', ctx, {
    pendingId: result.data.pendingId,
    expectedUserId: actorId,
  });
  if (claim.entry === undefined) {
    // 410 Gone is the right shape: the resource (the pendingId) either
    // never existed in this replica, expired, or was already claimed.
    // We deliberately don't distinguish — same defensive posture as the
    // PendingStore (no oracle on whether the id existed).
    res.status(410).json({ error: 'pending-expired-or-not-found' });
    return;
  }
  const exchangeService = `credentials:exchange:${claim.entry.kind}`;
  if (!bus.hasService(exchangeService)) {
    // The kind disappeared between start and finish (plugin unloaded
    // mid-flow, or the operator removed it). Surface as 400 — same
    // bucket as "unsupported kind" on /start.
    res.status(400).json({ error: `unsupported kind: ${claim.entry.kind}` });
    return;
  }
  try {
    const exchange = await bus.call<
      { code: string; codeVerifier: string; state: string },
      ExchangeResult
    >(exchangeService, ctx, {
      code: result.data.code,
      codeVerifier: claim.entry.codeVerifier,
      state: claim.entry.state,
    });
    await bus.call('credentials:set', ctx, {
      scope: claim.entry.scope,
      ownerId: claim.entry.ownerId,
      ref: claim.entry.ref,
      kind: exchange.kind,
      payload: exchange.payload,
      ...(exchange.expiresAt !== undefined ? { expiresAt: exchange.expiresAt } : {}),
    });
    const credential: Record<string, unknown> = {
      scope: claim.entry.scope,
      ownerId: claim.entry.ownerId,
      ref: claim.entry.ref,
      kind: exchange.kind,
      createdAt: new Date().toISOString(),
    };
    if (exchange.expiresAt !== undefined) {
      credential.expiresAt = new Date(exchange.expiresAt).toISOString();
    }
    res.status(201).json({ credential });
  } catch (err) {
    if (writeServiceError(res, err)) return;
    throw err;
  }
}

export function createAdminOauthHandlers(deps: OauthDeps): {
  start: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  finish: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'credentials-admin-oauth',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    async start(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const result = adminStartSchema.safeParse(parsedBody.value);
      if (!result.success) {
        const first = result.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }
      const data = result.data;
      const loginService = `credentials:login:${data.kind}`;
      if (!deps.bus.hasService(loginService)) {
        res.status(400).json({ error: `unsupported kind: ${data.kind}` });
        return;
      }
      try {
        const login = await deps.bus.call<unknown, LoginResult>(
          loginService,
          ctx,
          {},
        );
        const stash = await deps.bus.call<
          PendingEntry,
          { pendingId: string }
        >('credentials:oauth:stash-pending', ctx, {
          codeVerifier: login.codeVerifier,
          state: login.state,
          scope: data.scope,
          ownerId: data.ownerId,
          ref: data.ref,
          kind: data.kind,
          userId: actor.id,
        });
        res.status(200).json({
          pendingId: stash.pendingId,
          authorizeUrl: login.authorizeUrl,
          instructions:
            'Open the link, sign in, copy the code from the page, and paste it back here.',
        });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async finish(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      await runFinish(deps.bus, ctx, actor.id, req, res);
    },
  };
}

export function createSettingsOauthHandlers(deps: OauthDeps): {
  start: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  finish: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const baseCtx = makeAgentContext({
    sessionId: 'credentials-settings-oauth',
    agentId: PLUGIN_NAME,
    userId: 'settings',
  });

  function ctxForActor(actorId: string): AgentContext {
    return makeAgentContext({
      sessionId: baseCtx.sessionId,
      agentId: PLUGIN_NAME,
      userId: actorId,
    });
  }

  return {
    async start(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, baseCtx, req, res);
      if (actor === null) return;
      const ctx = ctxForActor(actor.id);
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const result = settingsStartSchema.safeParse(parsedBody.value);
      if (!result.success) {
        const first = result.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }
      const data = result.data;
      const loginService = `credentials:login:${data.kind}`;
      if (!deps.bus.hasService(loginService)) {
        res.status(400).json({ error: `unsupported kind: ${data.kind}` });
        return;
      }
      try {
        const login = await deps.bus.call<unknown, LoginResult>(
          loginService,
          ctx,
          {},
        );
        // Force scope='user', ownerId=actor.id — the settings flow can't
        // touch any other scope. Mirrors settings-routes.create.
        const stash = await deps.bus.call<
          PendingEntry,
          { pendingId: string }
        >('credentials:oauth:stash-pending', ctx, {
          codeVerifier: login.codeVerifier,
          state: login.state,
          scope: 'user',
          ownerId: actor.id,
          ref: data.ref,
          kind: data.kind,
          userId: actor.id,
        });
        res.status(200).json({
          pendingId: stash.pendingId,
          authorizeUrl: login.authorizeUrl,
          instructions:
            'Open the link, sign in, copy the code from the page, and paste it back here.',
        });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async finish(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, baseCtx, req, res);
      if (actor === null) return;
      await runFinish(deps.bus, ctxForActor(actor.id), actor.id, req, res);
    },
  };
}

/**
 * Register all four OAuth routes against @ax/http-server. Returned
 * unregister callbacks should be tracked by the plugin and called on
 * shutdown.
 */
export async function registerOauthRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const admin = createAdminOauthHandlers({ bus });
  const settings = createSettingsOauthHandlers({ bus });
  const routes: Array<{
    method: 'POST';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'POST', path: '/admin/credentials/oauth/start', handler: admin.start },
    { method: 'POST', path: '/admin/credentials/oauth/finish', handler: admin.finish },
    { method: 'POST', path: '/settings/credentials/oauth/start', handler: settings.start },
    { method: 'POST', path: '/settings/credentials/oauth/finish', handler: settings.finish },
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

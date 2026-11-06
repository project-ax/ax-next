import type { AgentContext, HookBus } from '@ax/core';
import { isShareCode } from '@ax/ipc-protocol';
import type { RouteRequest, RouteResponse } from './routes-attachments.js';
import {
  answerHookFailure,
  answerTextPreview,
  authOr401,
  jsonBody,
  noStore,
  requestCtx,
  TOKEN_PURPOSES,
} from './routes-artifacts.js';
import { createPerUserRateLimiter, type PerUserRateLimiter } from './per-user-rate-limit.js';

// ---------------------------------------------------------------------------
// @ax/channel-web — artifact routes for someone holding a share link.
//
//   GET  /api/shared/:code         — what the link points at (current version)
//   GET  /api/shared/:code/text    — text preview of the current version
//   POST /api/shared/:code/token   — view/download URL for the current version
//
// The page itself (/a/:code) is NOT a server route: it stays the SPA's,
// served through the static-files fallback, and calls these.
//
// Every route: no-store, sign in (401), then one shared per-person limit
// (30/min, 429 + Retry-After: 60), then the code's shape, then the hook. A
// malformed code, a wrong one, a turned-off one and a deleted artifact are
// all the same 404 — and every lookup counts, because guessing is what the
// limit is there to slow down. The shape check is @ax/ipc-protocol's
// `isShareCode`, the same one @ax/attachments applies.
//
// A link holder sees the CURRENT version only: response bodies are built
// field by field, so no body carries a version number, a version list, a
// source path, an artifact id or the code, whatever a hook hands us (I5). The
// minted token URL is the exception: it goes out as the hook made it, and its
// payload is signed, not encrypted — anyone holding the URL can read what it
// binds (the artifact id and version number). The code itself is not in it,
// only a truncated hash of it (@ax/attachments view-token.ts).
//
// The code is a capability (§6.3): it is never logged, whole or in part. The
// limiter keys on the person; failures log codes only (answerHookFailure).
//
// I2: only @ax/core, the @ax/ipc-protocol wire contract and local modules;
// @ax/attachments is reached by the bus.
// ---------------------------------------------------------------------------

/** Lookups one person may make across all /api/shared routes in a minute. */
export const SHARED_LOOKUPS_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
/** People the limiter tracks at once; past this, new people wait a minute. */
const MAX_TRACKED_USERS = 10_000;

const RATE_LIMITED_MESSAGE = "That's a lot of shared links in a minute — give it a moment and try again.";

// --- duck-typed hook payloads (I2; see @ax/attachments artifacts/types.ts) --

interface SharedArtifactViewWire {
  title: string;
  mediaType: string;
  kind: string;
  preview: string;
  extension: string;
  sizeBytes: number;
  updatedAt: string;
  agentName: string | null;
}

interface SharedReadWire {
  bytes: Uint8Array;
  preview: string;
}

function sharedViewBody(a: SharedArtifactViewWire): SharedArtifactViewWire {
  return {
    title: a.title,
    mediaType: a.mediaType,
    kind: a.kind,
    preview: a.preview,
    extension: a.extension,
    sizeBytes: a.sizeBytes,
    updatedAt: a.updatedAt,
    agentName: a.agentName,
  };
}

// --- handlers ---------------------------------------------------------------

export interface SharedArtifactsRouteDeps {
  bus: HookBus;
  initCtx: AgentContext;
  /** The limiter's clock (tests). */
  now?: () => number;
}

export function createSharedArtifactsRouteHandlers(deps: SharedArtifactsRouteDeps) {
  const { bus, initCtx } = deps;
  const limiter: PerUserRateLimiter = createPerUserRateLimiter({
    limit: SHARED_LOOKUPS_PER_MINUTE,
    windowMs: WINDOW_MS,
    maxUsers: MAX_TRACKED_USERS,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  /**
   * The steps every route shares: no-store, sign in, the limit, the code's
   * shape. Returns the person and the code, or null once it has answered.
   */
  async function admit(req: RouteRequest, res: RouteResponse): Promise<{ userId: string; shareCode: string } | null> {
    noStore(res);
    const userId = await authOr401(bus, initCtx, req, res);
    if (userId === null) return null;
    if (!limiter.take(userId)) {
      res.header('retry-after', '60');
      res.status(429).json({ error: 'rate-limited', message: RATE_LIMITED_MESSAGE });
      return null;
    }
    const shareCode = req.params['code'];
    if (!isShareCode(shareCode)) {
      res.status(404).json({ error: 'link-not-found' });
      return null;
    }
    return { userId, shareCode };
  }

  function refuse(res: RouteResponse, hook: string, err: unknown): void {
    answerHookFailure(initCtx, res, hook, err, 'link-not-found');
  }

  return {
    async resolve(req: RouteRequest, res: RouteResponse): Promise<void> {
      const ok = await admit(req, res);
      if (ok === null) return;
      let out: { artifact: SharedArtifactViewWire };
      try {
        out = await bus.call<{ shareCode: string }, { artifact: SharedArtifactViewWire }>(
          'artifacts:resolve-share-code',
          requestCtx(ok.userId),
          { shareCode: ok.shareCode },
        );
      } catch (err) {
        refuse(res, 'artifacts:resolve-share-code', err);
        return;
      }
      res.status(200).json({ artifact: sharedViewBody(out.artifact) });
    },

    async text(req: RouteRequest, res: RouteResponse): Promise<void> {
      const ok = await admit(req, res);
      if (ok === null) return;
      let read: SharedReadWire;
      try {
        read = await bus.call<{ shareCode: string }, SharedReadWire>('artifacts:read', requestCtx(ok.userId), {
          shareCode: ok.shareCode,
        });
      } catch (err) {
        refuse(res, 'artifacts:read', err);
        return;
      }
      answerTextPreview(res, read);
    },

    async token(req: RouteRequest, res: RouteResponse): Promise<void> {
      const ok = await admit(req, res);
      if (ok === null) return;
      const purpose = jsonBody(req)?.['purpose'];
      if (!TOKEN_PURPOSES.has(purpose)) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      let out: { url: string; expiresAt: string };
      try {
        out = await bus.call<{ shareCode: string; purpose: 'view' | 'download' }, { url: string; expiresAt: string }>(
          'artifacts:mint-view-token',
          requestCtx(ok.userId),
          { shareCode: ok.shareCode, purpose: purpose as 'view' | 'download' },
        );
      } catch (err) {
        refuse(res, 'artifacts:mint-view-token', err);
        return;
      }
      res.status(200).json({ url: out.url, expiresAt: out.expiresAt });
    },
  };
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

/** The routes, in registration order. Deliberately no `/a/:code`: that is the SPA's. */
export function sharedArtifactRoutes(
  handlers: ReturnType<typeof createSharedArtifactsRouteHandlers>,
): Array<{ method: 'GET' | 'POST'; path: string; handler: RouteHandler }> {
  return [
    { method: 'GET', path: '/api/shared/:code', handler: handlers.resolve },
    { method: 'GET', path: '/api/shared/:code/text', handler: handlers.text },
    { method: 'POST', path: '/api/shared/:code/token', handler: handlers.token },
  ];
}

/** Register the link-holder routes against @ax/http-server. */
export async function registerSharedArtifactsRoutes(bus: HookBus, initCtx: AgentContext): Promise<Array<() => void>> {
  const unregisters: Array<() => void> = [];
  for (const route of sharedArtifactRoutes(createSharedArtifactsRouteHandlers({ bus, initCtx }))) {
    const result = await bus.call<unknown, { unregister: () => void }>('http:register-route', initCtx, route);
    unregisters.push(result.unregister);
  }
  return unregisters;
}

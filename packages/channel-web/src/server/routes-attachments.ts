import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { parseSingleFileMultipart } from './multipart.js';

// ---------------------------------------------------------------------------
// @ax/channel-web — attachments REST surface (Phase 3, 2026-05-18).
//
// Routes:
//   - POST /api/attachments   — multipart upload, 25 MiB cap, MIME allowlist.
//                               Calls attachments:store-temp.
//   - GET  /api/files         — ACL'd byte download. Calls attachments:download.
//
// Both endpoints require auth. POST is CSRF-gated by the http-server's
// subscriber (Origin + X-Requested-With check). GET is read-only and
// cookie-authed only — no CSRF gate needed (browsers gate state-changing
// methods; a GET that mutates would be a security bug, but GET /api/files
// never mutates).
//
// Boundary review (I1-I5):
//   - I1: payload field names — path, conversationId, attachmentId,
//     sizeBytes, mediaType, displayName, expiresAt — are workspace +
//     attachment vocabulary. No backend leak.
//   - I2: this file imports only @ax/core (and the local multipart helper).
//     All other plugins reached via bus.call.
//   - I3: full POST + GET surface lands in the same PR with canary
//     coverage (Phase 3 closes the half-wired window opened by Phase 1).
//   - I4: attachment metadata is the conversation transcript; no
//     side-table here. GET /api/files's path-scope ACL reads transcripts
//     via conversations:get inside attachments:download.
//   - I5: 25 MiB body cap per-route; MIME allowlist enforced by
//     attachments:store-temp; 200 MiB per-user pending quota inside the
//     hook; auth required for both; CSRF gated for POST.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';

// Per-route body cap for POST /api/attachments. Matches the per-file cap
// the @ax/attachments plugin defaults to (25 MiB). This is the framework-
// level enforcement; the hook re-enforces inside store-temp for
// defense-in-depth.
const ATTACHMENTS_MAX_BODY_BYTES = 25 * 1024 * 1024;

// --- duck-typed request/response (mirrors @ax/http-server's HttpRequest /
// HttpResponse minus the import — Invariant I2) ----------------------------

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
  /**
   * Send raw bytes (file contents, binary blobs). Optional `contentType`
   * sets Content-Type only when no prior `header('content-type', …)` call
   * has set it. Single-shot like the rest.
   */
  body(buf: Buffer, contentType?: string): void;
  end(): void;
}

// --- duck-typed hook payloads (I2) ----------------------------------------

interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}

interface StoreTempInput {
  bytes: Buffer;
  displayName: string;
  mediaType: string;
}
interface StoreTempOutput {
  attachmentId: string;
  sizeBytes: number;
  expiresAt: string;
}

interface DownloadInput {
  path: string;
  conversationId: string;
  userId: string;
}
interface DownloadOutput {
  bytes: Buffer;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}

// --- shared auth helper (mirrors routes-chat.ts) --------------------------

async function authOr401(
  bus: HookBus,
  initCtx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<string | null> {
  try {
    const result = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
      'auth:require-user',
      initCtx,
      { req },
    );
    return result.user.id;
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

// --- handler factory ------------------------------------------------------

export interface AttachmentsRouteDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function createAttachmentsRouteHandlers(deps: AttachmentsRouteDeps) {
  const { bus, initCtx } = deps;
  return {
    /** POST /api/attachments — multipart upload. */
    async postAttachment(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Auth.
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      // 2) Parse multipart. Errors collapse to 400 (no internal-detail leak).
      let parsed: { filename: string; mimeType: string; bytes: Buffer };
      const contentType = req.headers['content-type'] ?? '';
      try {
        parsed = await parseSingleFileMultipart(req.body, contentType);
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      // 3) Delegate to attachments:store-temp. The hook enforces:
      //    - 25 MiB per-file cap (size check, parallel to the http-server's)
      //    - MIME allowlist (returns invalid-payload on miss → we map to 415)
      //    - per-user pending quota (200 MiB; too-many-pending → 429)
      // Per-request ctx — userId must come from the auth gate, not the
      // route-init ctx (which is the plugin's boot context).
      const ctx = makeAgentContext({
        sessionId: 'attachments-upload',
        agentId: PLUGIN_NAME,
        userId,
      });
      try {
        const out = await bus.call<StoreTempInput, StoreTempOutput>(
          'attachments:store-temp',
          ctx,
          {
            bytes: parsed.bytes,
            displayName: parsed.filename,
            mediaType: parsed.mimeType,
          },
        );
        res.status(200).json({
          attachmentId: out.attachmentId,
          sizeBytes: out.sizeBytes,
          mediaType: parsed.mimeType,
          displayName: parsed.filename,
          expiresAt: out.expiresAt,
        });
      } catch (err) {
        if (err instanceof PluginError) {
          // The hook returns 'invalid-payload' for both oversize AND
          // mediaType rejection. Disambiguate on message content so the
          // status code reflects what actually failed:
          //   - "mediaType '<x>' not in allowlist" → 415
          //   - "attachment exceeds max file size …"  → 413
          //   - anything else                          → 400
          if (err.code === 'invalid-payload') {
            if (err.message.includes('not in allowlist')) {
              res.status(415).json({ error: 'unsupported-media-type' });
              return;
            }
            if (err.message.includes('max file size')) {
              res.status(413).json({ error: 'payload-too-large' });
              return;
            }
            res.status(400).json({ error: 'invalid-payload' });
            return;
          }
          if (err.code === 'too-many-pending') {
            res.status(429).json({ error: 'too-many-pending' });
            return;
          }
        }
        throw err;
      }
    },

    /** GET /api/files — ACL'd download. */
    async getFile(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      // 2) Validate query params at the route layer. The hook re-validates
      //    inside attachments:download; this is the cheap first reject
      //    for malformed shapes. http-server lowercases query-param keys
      //    before delivering them.
      const path = req.query['path'];
      const conversationId = req.query['conversationid'];
      if (typeof path !== 'string' || path.length === 0) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      if (typeof conversationId !== 'string' || conversationId.length === 0) {
        res.status(404).json({ error: 'not-found' });
        return;
      }

      const ctx = makeAgentContext({
        sessionId: 'attachments-download',
        agentId: PLUGIN_NAME,
        userId,
        conversationId,
      });
      try {
        const out = await bus.call<DownloadInput, DownloadOutput>(
          'attachments:download',
          ctx,
          { path, conversationId, userId },
        );
        // Stream-equivalent body write. The framework's HttpResponse.body
        // is single-shot; bytes are flushed atomically. For 25 MiB this
        // is a one-shot write — memory and latency both fine.
        const filename = sanitizeContentDispositionFilename(out.displayName);
        res
          .status(200)
          .header('content-type', out.mediaType)
          .header('content-length', String(out.sizeBytes))
          .header('content-disposition', `attachment; filename="${filename}"`)
          .header('x-content-type-options', 'nosniff')
          .body(out.bytes, out.mediaType);
      } catch (err) {
        if (err instanceof PluginError) {
          // Uniform 404 for every forbidden / not-found condition (the hook
          // itself collapses cross-tenant + missing-path + symlink etc into
          // a not-found posture; we mirror that at the HTTP layer).
          if (err.code === 'not-found' || err.code === 'forbidden') {
            res.status(404).json({ error: 'not-found' });
            return;
          }
        }
        throw err;
      }
    },
  };
}

/**
 * Sanitize a display name for Content-Disposition. Browsers parse this
 * header loosely; we drop anything outside printable ASCII to avoid
 * injection (CRLF, quote-escape). For multi-byte filenames the proper
 * answer is RFC 5987's `filename*=UTF-8''...` syntax — out of scope at
 * v1 (display names are user-typed, not URL-encoded). Drop chars
 * outside [A-Za-z0-9._ -] to a single `_`.
 */
function sanitizeContentDispositionFilename(displayName: string): string {
  const trimmed = displayName.slice(0, 255);
  return trimmed.replace(/[^A-Za-z0-9._ -]/g, '_');
}

/** Register routes against @ax/http-server. */
export async function registerAttachmentsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAttachmentsRouteHandlers({ bus, initCtx });
  // Same duck-typed cast as routes-chat.ts — http-server's HttpRequest /
  // HttpResponse are a structural superset of our adapter; the
  // exactOptionalPropertyTypes lint forces us through `unknown` to line
  // up the narrower-optional-fields surface.
  type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
  const routes: Array<{
    method: 'POST' | 'GET';
    path: string;
    handler: RouteHandler;
    maxBodyBytes?: number;
  }> = [
    {
      method: 'POST',
      path: '/api/attachments',
      handler: handlers.postAttachment as unknown as RouteHandler,
      maxBodyBytes: ATTACHMENTS_MAX_BODY_BYTES,
    },
    {
      method: 'GET',
      path: '/api/files',
      handler: handlers.getFile as unknown as RouteHandler,
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

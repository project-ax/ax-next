import {
  answerRequireUserFailure,
  makeAgentContext,
  PluginError,
  sanitizeContentDispositionFilename,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import type { RouteRequest, RouteResponse } from './routes-attachments.js';
import { errorCodes } from './user-file-download.js';
import { buildStoreZip, uniqueNames } from './zip-store.js';

// ---------------------------------------------------------------------------
// @ax/channel-web — artifact routes for the agent's members (owners).
//
//   GET    /api/workspace/agents/:agentId/artifacts                 — the list
//   GET    /api/workspace/agents/:agentId/artifacts/download-all    — one zip
//   GET    /api/workspace/artifacts/:artifactId                     — detail + versions
//   GET    /api/workspace/artifacts/:artifactId/versions/:version/text — text preview
//   POST   /api/workspace/artifacts/:artifactId/versions/:version/token — view/download URL
//   PATCH  /api/workspace/artifacts/:artifactId                     — rename
//   POST   /api/workspace/artifacts/:artifactId/restore             — restore a version
//   POST   /api/workspace/artifacts/:artifactId/link                — share link on/off/rotate
//   DELETE /api/workspace/artifacts/:artifactId                     — delete
//
// Every route signs the caller in first. Access is NOT decided here: every
// `artifacts:*` hook runs the one access rule itself and answers `not-found`
// for a stranger exactly as for a missing id, and this file folds both (and
// any `forbidden`) into the one 404 body, so a non-member learns nothing.
//
// These are the OWNER shapes. A link holder (Task 10, /api/shared/*) gets a
// separate, narrower shape — no artifact id, no version numbers. Bodies here
// are built field by field rather than passed through, so a field a hook adds
// by mistake (a source path, a share code) is dropped here too (I5).
//
// I2: only @ax/core and local modules; @ax/attachments is reached by the bus.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';

/** A text preview shows at most this much of the file. */
export const ARTIFACT_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Download all refuses a bundle bigger than this… */
export const ARTIFACTS_ZIP_MAX_BYTES = 256 * 1024 * 1024;
/** …or with more files than this. */
export const ARTIFACTS_ZIP_MAX_ENTRIES = 500;

const TOO_LARGE_MESSAGE = "That's too much to bundle at once — download them one at a time.";

// --- duck-typed hook payloads (I2; see @ax/attachments artifacts/types.ts) --

interface ArtifactSummaryWire {
  artifactId: string;
  agentId: string;
  title: string;
  mediaType: string;
  kind: string;
  preview: string;
  extension: string;
  currentVersion: number;
  sizeBytes: number;
  linkOn: boolean;
  createdAt: string;
  updatedAt: string;
}
interface ArtifactVersionWire {
  version: number;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}
interface ArtifactDetailWire extends ArtifactSummaryWire {
  versions: ArtifactVersionWire[];
}
interface ArtifactReadWire {
  bytes: Uint8Array;
  mediaType: string;
  preview: string;
  sizeBytes: number;
  filename: string;
  version: number;
}

interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}

// --- projections: what a body may carry, named field by field --------------

function summaryBody(a: ArtifactSummaryWire): ArtifactSummaryWire {
  return {
    artifactId: a.artifactId,
    agentId: a.agentId,
    title: a.title,
    mediaType: a.mediaType,
    kind: a.kind,
    preview: a.preview,
    extension: a.extension,
    currentVersion: a.currentVersion,
    sizeBytes: a.sizeBytes,
    linkOn: a.linkOn,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function detailBody(a: ArtifactDetailWire): ArtifactDetailWire {
  return {
    ...summaryBody(a),
    versions: a.versions.map((v) => ({
      version: v.version,
      mediaType: v.mediaType,
      sizeBytes: v.sizeBytes,
      createdAt: v.createdAt,
    })),
  };
}

// --- helpers ----------------------------------------------------------------

async function authOr401(
  bus: HookBus,
  initCtx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<string | null> {
  try {
    const result = await bus.call<{ req: RouteRequest }, AuthRequireUserOutput>('auth:require-user', initCtx, {
      req,
    });
    return result.user.id;
  } catch (err) {
    answerRequireUserFailure(initCtx, res, err, 'artifacts_require_user_failed');
    return null;
  }
}

function requestCtx(userId: string): AgentContext {
  return makeAgentContext({ sessionId: 'artifacts', agentId: PLUGIN_NAME, userId });
}

function noStore(res: RouteResponse): RouteResponse {
  return res.header('cache-control', 'private, no-store');
}

/**
 * A hook's refusal, as a status. `not-found` and `forbidden` are the same 404
 * (a 403 would say the artifact exists); anything unplanned is a 500 whose log
 * line carries codes only — never the message, which can hold input (TASK-1024).
 */
function answerHookFailure(initCtx: AgentContext, res: RouteResponse, hook: string, err: unknown): void {
  const code = err instanceof PluginError ? err.code : undefined;
  if (code === 'not-found' || code === 'forbidden') {
    res.status(404).json({ error: 'artifact-not-found' });
    return;
  }
  if (code === 'invalid-payload') {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  if (code === 'conflict') {
    res.status(409).json({ error: 'conflict' });
    return;
  }
  initCtx.logger.error('artifacts_route_failed', { hook, ...errorCodes(err) });
  res.status(500).json({ error: 'internal' });
}

/** A JSON object body, or null for anything else (missing, malformed, an array). */
function jsonBody(req: RouteRequest): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(req.body.toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const VERSION_PARAM = /^[1-9][0-9]{0,8}$/;

/** A `:version` path segment as a positive integer, or null. */
function versionParam(raw: string | undefined): number | null {
  return raw !== undefined && VERSION_PARAM.test(raw) ? Number(raw) : null;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

const LINK_ACTIONS: ReadonlySet<unknown> = new Set(['ensure', 'off', 'rotate']);
const TOKEN_PURPOSES: ReadonlySet<unknown> = new Set(['view', 'download']);
const TEXT_PREVIEWS: ReadonlySet<string> = new Set(['markdown', 'text']);

/** The first `max` bytes, cut back to a UTF-8 character boundary. */
function utf8Prefix(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.byteLength <= max) return bytes;
  let end = max;
  // A continuation byte (10xxxxxx) at the cut means a character straddles it.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

// --- handlers ---------------------------------------------------------------

export interface ArtifactsRouteDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function createArtifactsRouteHandlers(deps: ArtifactsRouteDeps) {
  const { bus, initCtx } = deps;

  /** Call an `artifacts:*` hook; on a refusal, answer it and return undefined. */
  async function callOr<I, O>(res: RouteResponse, hook: string, ctx: AgentContext, input: I): Promise<O | undefined> {
    try {
      return await bus.call<I, O>(hook, ctx, input);
    } catch (err) {
      answerHookFailure(initCtx, res, hook, err);
      return undefined;
    }
  }

  return {
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const out = await callOr<{ agentId: string }, { artifacts: ArtifactSummaryWire[] }>(
        res,
        'artifacts:list',
        requestCtx(userId),
        { agentId: req.params['agentId'] ?? '' },
      );
      if (out === undefined) return;
      noStore(res).status(200).json({ artifacts: out.artifacts.map(summaryBody) });
    },

    async downloadAll(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const ctx = requestCtx(userId);
      const agentId = req.params['agentId'] ?? '';

      // The list is the access check (members only) and the size check: both
      // happen before a single byte is read.
      const listed = await callOr<{ agentId: string }, { artifacts: ArtifactSummaryWire[] }>(
        res,
        'artifacts:list',
        ctx,
        { agentId },
      );
      if (listed === undefined) return;
      const summaries = listed.artifacts;
      const declared = summaries.reduce((n, a) => n + a.sizeBytes, 0);
      if (summaries.length > ARTIFACTS_ZIP_MAX_ENTRIES || declared > ARTIFACTS_ZIP_MAX_BYTES) {
        res.status(413).json({ error: 'too-large', message: TOO_LARGE_MESSAGE });
        return;
      }

      // The agent's name, for the zip's file name. The person wrote it, so it
      // goes through the header sanitizer like any other download name.
      const resolved = await callOr<{ agentId: string; userId: string }, { agent: { displayName?: unknown } }>(
        res,
        'agents:resolve',
        ctx,
        { agentId, userId },
      );
      if (resolved === undefined) return;
      const agentName = typeof resolved.agent.displayName === 'string' ? resolved.agent.displayName : 'Agent';

      const files: Array<{ name: string; bytes: Uint8Array; modified: Date }> = [];
      let total = 0;
      for (const summary of summaries) {
        let read: ArtifactReadWire;
        try {
          read = await bus.call<{ artifactId: string }, ArtifactReadWire>('artifacts:read', ctx, {
            artifactId: summary.artifactId,
          });
        } catch (err) {
          // Deleted since the list was read: leave it out rather than fail the bundle.
          if (err instanceof PluginError && err.code === 'not-found') continue;
          answerHookFailure(initCtx, res, 'artifacts:read', err);
          return;
        }
        total += read.bytes.byteLength;
        // Re-published bigger since the list: the cap holds on the real bytes too.
        if (total > ARTIFACTS_ZIP_MAX_BYTES) {
          res.status(413).json({ error: 'too-large', message: TOO_LARGE_MESSAGE });
          return;
        }
        files.push({ name: read.filename, bytes: read.bytes, modified: new Date(summary.updatedAt) });
      }
      const names = uniqueNames(files.map((f) => f.name));
      const zip = buildStoreZip(files.map((f, i) => ({ ...f, name: names[i] ?? 'download' })));

      const filename = sanitizeContentDispositionFilename(`${agentName} artifacts.zip`);
      noStore(res)
        .status(200)
        .header('content-type', 'application/zip')
        .header('content-length', String(zip.length))
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('x-content-type-options', 'nosniff')
        .body(zip, 'application/zip');
    },

    async get(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const out = await callOr<{ artifactId: string }, { artifact: ArtifactDetailWire }>(
        res,
        'artifacts:get',
        requestCtx(userId),
        { artifactId: req.params['artifactId'] ?? '' },
      );
      if (out === undefined) return;
      noStore(res).status(200).json({ artifact: detailBody(out.artifact) });
    },

    async text(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const version = versionParam(req.params['version']);
      if (version === null) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const read = await callOr<{ artifactId: string; version: number }, ArtifactReadWire>(
        res,
        'artifacts:read',
        requestCtx(userId),
        { artifactId: req.params['artifactId'] ?? '', version },
      );
      if (read === undefined) return;
      if (!TEXT_PREVIEWS.has(read.preview)) {
        res.status(404).json({ error: 'not-previewable' });
        return;
      }
      const shown = utf8Prefix(read.bytes, ARTIFACT_TEXT_PREVIEW_MAX_BYTES);
      noStore(res)
        .status(200)
        .json({
          text: new TextDecoder('utf-8', { fatal: false }).decode(shown),
          truncated: shown.byteLength < read.bytes.byteLength,
        });
    },

    async token(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const version = versionParam(req.params['version']);
      const purpose = jsonBody(req)?.['purpose'];
      if (version === null || !TOKEN_PURPOSES.has(purpose)) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const out = await callOr<
        { artifactId: string; version: number; purpose: 'view' | 'download' },
        { url: string; expiresAt: string }
      >(res, 'artifacts:mint-view-token', requestCtx(userId), {
        artifactId: req.params['artifactId'] ?? '',
        version,
        purpose: purpose as 'view' | 'download',
      });
      if (out === undefined) return;
      noStore(res).status(200).json({ url: out.url, expiresAt: out.expiresAt });
    },

    async rename(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const title = jsonBody(req)?.['title'];
      if (typeof title !== 'string') {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const out = await callOr<{ artifactId: string; title: string }, { artifact: ArtifactSummaryWire }>(
        res,
        'artifacts:rename',
        requestCtx(userId),
        { artifactId: req.params['artifactId'] ?? '', title },
      );
      if (out === undefined) return;
      noStore(res).status(200).json({ artifact: summaryBody(out.artifact) });
    },

    async restore(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const version = jsonBody(req)?.['version'];
      if (!isPositiveInt(version)) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const out = await callOr<{ artifactId: string; version: number }, { artifact: ArtifactSummaryWire }>(
        res,
        'artifacts:restore',
        requestCtx(userId),
        { artifactId: req.params['artifactId'] ?? '', version },
      );
      if (out === undefined) return;
      noStore(res).status(200).json({ artifact: summaryBody(out.artifact) });
    },

    async link(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const action = jsonBody(req)?.['action'];
      if (!LINK_ACTIONS.has(action)) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const out = await callOr<{ artifactId: string; action: string }, { shareCode: string | null }>(
        res,
        'artifacts:set-link',
        requestCtx(userId),
        { artifactId: req.params['artifactId'] ?? '', action: action as string },
      );
      if (out === undefined) return;
      // The one owner answer that carries a code: the owner copies the link from it.
      noStore(res).status(200).json({ shareCode: out.shareCode });
    },

    async remove(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const out = await callOr<{ artifactId: string }, { deleted: true }>(
        res,
        'artifacts:delete',
        requestCtx(userId),
        { artifactId: req.params['artifactId'] ?? '' },
      );
      if (out === undefined) return;
      res.status(204).end();
    },
  };
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

/** The routes, in registration order. */
export function artifactRoutes(
  handlers: ReturnType<typeof createArtifactsRouteHandlers>,
): Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; handler: RouteHandler }> {
  return [
    { method: 'GET', path: '/api/workspace/agents/:agentId/artifacts', handler: handlers.list },
    { method: 'GET', path: '/api/workspace/agents/:agentId/artifacts/download-all', handler: handlers.downloadAll },
    { method: 'GET', path: '/api/workspace/artifacts/:artifactId', handler: handlers.get },
    { method: 'GET', path: '/api/workspace/artifacts/:artifactId/versions/:version/text', handler: handlers.text },
    { method: 'POST', path: '/api/workspace/artifacts/:artifactId/versions/:version/token', handler: handlers.token },
    { method: 'PATCH', path: '/api/workspace/artifacts/:artifactId', handler: handlers.rename },
    { method: 'POST', path: '/api/workspace/artifacts/:artifactId/restore', handler: handlers.restore },
    { method: 'POST', path: '/api/workspace/artifacts/:artifactId/link', handler: handlers.link },
    { method: 'DELETE', path: '/api/workspace/artifacts/:artifactId', handler: handlers.remove },
  ];
}

/** Register the artifact routes against @ax/http-server. */
export async function registerArtifactsRoutes(bus: HookBus, initCtx: AgentContext): Promise<Array<() => void>> {
  const unregisters: Array<() => void> = [];
  for (const route of artifactRoutes(createArtifactsRouteHandlers({ bus, initCtx }))) {
    const result = await bus.call<unknown, { unregister: () => void }>('http:register-route', initCtx, route);
    unregisters.push(result.unregister);
  }
  return unregisters;
}

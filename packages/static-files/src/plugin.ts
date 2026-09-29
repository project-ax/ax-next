import { promises as fs } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { PluginError, makeAgentContext, type Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/static-files';

// Hardcoded MIME map. Keep small — production deploys serve the channel-web
// bundle, which uses a known set of extensions. Adding more isn't free:
// content-type sniffing has its own injection surface, so we list extensions
// we trust to map deterministically and reject everything else as
// application/octet-stream (browsers won't preview-execute it).
const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

// Vite & most bundlers stamp content-hashes into asset filenames
// (`assets/foo-3ab19f02.js`). Files matching this pattern get long-lived
// cache headers; everything else (notably index.html) gets `no-cache` so
// SPA updates propagate. Heuristic, not a security boundary.
const HASHED_FILENAME = /[-.][a-f0-9]{8,}\./i;

export interface StaticFilesConfig {
  /** Absolute path to the directory to serve. Resolved at init. */
  dir: string;
  /**
   * URL pattern, defaults to `'/*'` (serve everything no MORE SPECIFIC route
   * claims: exact and :param routes first, then the longest-prefix splat, no
   * matter which plugin registered first). Use `/static/*` if you only want to
   * serve under a prefix.
   */
  mountPath?: string;
  /**
   * Single-page-app fallback:
   *   - `false` (default): unknown paths → 404
   *   - `true`: unknown paths → serve `<dir>/index.html`
   *   - string: serve `<dir>/<that file>`
   */
  spaFallback?: boolean | string;
  /**
   * Path prefixes that belong to an API, not to the SPA. A GET under one of
   * these that no real route claimed gets a JSON 404 — never `index.html` (and
   * never a file off disk). Without this a missing or misspelled API route
   * answers 200 with HTML, and the browser reports a JSON `SyntaxError` on
   * `<!DOCTYPE` instead of "not found" (TASK-717 hid behind exactly that).
   *
   * A prefix matches on a segment boundary: `/api` covers `/api`, `/api/` and
   * `/api/x`, not `/apiary`. Each entry must start with `/` and name at least
   * one segment. Defaults to `['/api']`; passing a list REPLACES the default.
   */
  apiPathPrefixes?: readonly string[];
}

interface RegisterRouteResult {
  unregister(): void;
}

// Structural minimum we need from @ax/http-server's adapter. I2 forbids
// importing from @ax/http-server, so we duck-type the surface here.
interface HttpRequestLike {
  /** The full request path, as `@ax/http-server` matched it (query stripped). */
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly params: Record<string, string>;
}

interface HttpResponseLike {
  status(n: number): HttpResponseLike;
  header(name: string, value: string): HttpResponseLike;
  body(buf: Buffer, contentType?: string): void;
  end(): void;
  json(v: unknown): void;
}

type HttpRouteHandlerLike = (
  req: HttpRequestLike,
  res: HttpResponseLike,
) => Promise<void>;

interface RegisterRouteInput {
  method: 'GET';
  path: string;
  handler: HttpRouteHandlerLike;
}

const DEFAULT_API_PATH_PREFIXES: readonly string[] = ['/api'];

/**
 * Trim trailing slashes and refuse anything that would swallow the whole site
 * (`/`, `//`) or is not an absolute path (`api`, ``). Returns bare prefixes
 * like `/api`.
 */
function normalizeApiPrefixes(prefixes: readonly string[]): string[] {
  return prefixes.map((raw) => {
    const trimmed = raw.replace(/\/+$/, '');
    if (!raw.startsWith('/') || trimmed === '') {
      throw new PluginError({
        code: 'invalid-config',
        plugin: PLUGIN_NAME,
        message: `static-files apiPathPrefixes entry must start with '/' and name a segment, got ${JSON.stringify(raw)}`,
      });
    }
    return trimmed;
  });
}

export function createStaticFilesPlugin(config: StaticFilesConfig): Plugin {
  const root = resolve(config.dir);
  const apiPrefixes = normalizeApiPrefixes(
    config.apiPathPrefixes ?? DEFAULT_API_PATH_PREFIXES,
  );
  // An error-SHAPE choice (JSON 404 instead of the SPA shell), not a security
  // boundary: nothing may gate access on it. A raw-path spelling it misses
  // (`/%61pi/x`, `//api`) just gets the shell, and no API handler matches those
  // spellings either. A GET on a POST-only /api route also lands here (404, not
  // 405), because this GET catchall matches it.
  const isApiPath = (path: string): boolean =>
    apiPrefixes.some((p) => path === p || path.startsWith(`${p}/`));
  const mountPath = config.mountPath ?? '/*';
  const fallbackFile =
    config.spaFallback === true
      ? 'index.html'
      : typeof config.spaFallback === 'string'
        ? config.spaFallback
        : null;

  let unregister: (() => void) | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['http:register-route'],
      subscribes: [],
    },

    async init({ bus }) {
      // Verify dir exists at boot — fail fast so a missing build directory
      // doesn't show up as 404s after the first request.
      let stat;
      try {
        stat = await fs.stat(root);
      } catch (err) {
        throw new PluginError({
          code: 'invalid-config',
          plugin: PLUGIN_NAME,
          message: `static-files dir does not exist: ${root}`,
          cause: err,
        });
      }
      if (!stat.isDirectory()) {
        throw new PluginError({
          code: 'invalid-config',
          plugin: PLUGIN_NAME,
          message: `static-files dir is not a directory: ${root}`,
        });
      }

      const ctx = makeAgentContext({
        sessionId: 'static-files',
        agentId: 'static-files',
        userId: 'system',
      });

      const handler: HttpRouteHandlerLike = async (req, res) => {
        // An API path that reached this catchall is one nobody registered.
        // Say so in JSON; the SPA shell would only make the caller's
        // `res.json()` explode somewhere far from the cause.
        if (isApiPath(req.path)) {
          res.status(404).json({ error: 'not-found' });
          return;
        }
        const splat = req.params['*'] ?? '';
        const ifNoneMatch = req.headers['if-none-match'];

        const direct = await tryServe(splat, ifNoneMatch, res);
        if (direct === 'served' || direct === '304') return;

        if (fallbackFile !== null) {
          const fb = await tryServe(fallbackFile, ifNoneMatch, res);
          if (fb === 'served' || fb === '304') return;
        }

        res.status(404).json({ error: 'not-found' });
      };

      const result = await bus.call<RegisterRouteInput, RegisterRouteResult>(
        'http:register-route',
        ctx,
        { method: 'GET', path: mountPath, handler },
      );
      unregister = result.unregister;
    },

    async shutdown() {
      unregister?.();
      unregister = undefined;
    },
  };

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  async function tryServe(
    relPath: string,
    ifNoneMatch: string | undefined,
    res: HttpResponseLike,
  ): Promise<'served' | '304' | 'miss'> {
    // Strip a single leading '/' if present — the splat captures
    // everything after the prefix, including the leading slash on `/*`.
    const cleaned = relPath.replace(/^\/+/, '');

    // Resolve against the configured root and verify the result stays
    // inside it. `resolve` does NOT follow symlinks; that's intentional —
    // a symlink target outside `root` would be caught by the prefix
    // check. (We never call `realpath`.)
    const candidate = normalize(resolve(root, cleaned));
    const rootSep = root.endsWith(sep) ? root : root + sep;
    if (candidate !== root && !candidate.startsWith(rootSep)) {
      // Path traversal attempt — return 'miss' so the caller's fallback
      // logic fires. From the attacker's perspective this is
      // indistinguishable from "file doesn't exist".
      return 'miss';
    }

    let stat;
    try {
      stat = await fs.stat(candidate);
    } catch {
      return 'miss';
    }
    if (!stat.isFile()) return 'miss';

    const ext = extname(candidate).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    // Weak ETag = `<size-hex>-<mtime-hex>`. Cheap to compute and good
    // enough for cache validation; clients only need a stable value
    // that changes when the file changes.
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

    if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
      res.status(304).header('etag', etag).end();
      return '304';
    }

    const body = await fs.readFile(candidate);

    const cacheControl = HASHED_FILENAME.test(candidate)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    res
      .status(200)
      .header('etag', etag)
      .header('cache-control', cacheControl)
      .body(body, mime);
    return 'served';
  }
}

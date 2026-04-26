import { promises as fs } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { PluginError, makeChatContext, type Plugin } from '@ax/core';

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
   * URL pattern, defaults to `'/*'` (serve everything not claimed by an
   * earlier exact-match or :param route). Use `/static/*` if you only
   * want to serve under a prefix.
   */
  mountPath?: string;
  /**
   * Single-page-app fallback:
   *   - `false` (default): unknown paths → 404
   *   - `true`: unknown paths → serve `<dir>/index.html`
   *   - string: serve `<dir>/<that file>`
   */
  spaFallback?: boolean | string;
}

interface RegisterRouteResult {
  unregister(): void;
}

// Structural minimum we need from @ax/http-server's adapter. Mirrors the
// pattern @ax/auth-oidc uses with HttpRequestLike: I2 forbids importing
// from @ax/http-server, so we duck-type the surface here.
interface HttpRequestLike {
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

export function createStaticFilesPlugin(config: StaticFilesConfig): Plugin {
  const root = resolve(config.dir);
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

      const ctx = makeChatContext({
        sessionId: 'static-files',
        agentId: 'static-files',
        userId: 'system',
      });

      const handler: HttpRouteHandlerLike = async (req, res) => {
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

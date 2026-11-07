import { createHash } from 'node:crypto';
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
  /**
   * Origins whose view route (`/v/`) the app shell may load in a frame. The
   * shell's HTML ships a CSP meta of exactly `frame-src 'none'` (channel-web's
   * index.html); with origins here, every `.html` file served gets that
   * directive widened to `frame-src <origin>/v/ …` on the way out, and nothing
   * else changes. The artifact viewer frames `<content origin>/v/<token>`, and
   * the content origin is only known at deploy time, so the built file cannot
   * name it. Scoped to `/v/` so neither the shell nor a chat visual navigating
   * its own frame (governed by this same directive) reaches any other route.
   *
   * Fails closed: a file without that exact meta is served as it is on disk,
   * and with no origins the meta stays `'none'`. Each entry must be a bare
   * `scheme://host[:port]` origin (http or https); anything else is refused at
   * construction, because it lands in an HTML attribute and a CSP.
   */
  frameSrc?: readonly string[];
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

// The one path the shell may frame on a `frameSrc` origin: the content
// origin's token view route. A source ending in `/` matches that path prefix.
// The one meta the shell ships (channel-web index.html). Matched exactly: a
// meta spelled any other way is left alone, which keeps its own policy.
const FRAME_SRC_NONE_META = `content="frame-src 'none'"`;
const BARE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

function normalizeFrameSrc(origins: readonly string[]): string[] {
  return origins.map((raw) => {
    if (!BARE_ORIGIN.test(raw)) {
      throw new PluginError({
        code: 'invalid-config',
        plugin: PLUGIN_NAME,
        message: `static-files frameSrc entry must be a bare http(s) origin, got ${JSON.stringify(raw)}`,
      });
    }
    return raw;
  });
}

/**
 * Trim trailing slashes and refuse anything that would swallow the whole site
 * (`/`, `//`) or is not an absolute path (`api`, ``). Returns bare prefixes
 * like `/api`.
 */
function normalizeApiPrefixes(prefixes: readonly string[]): string[] {
  return prefixes.map((raw) => {
    // A scan, not `/\/+$/`: CodeQL flags that regex as polynomial on a long
    // run of slashes, and a loop is as short.
    let end = raw.length;
    while (end > 0 && raw.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
    const trimmed = raw.slice(0, end);
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
  const frameSrc = normalizeFrameSrc(config.frameSrc ?? []);
  const frameSrcMeta =
    frameSrc.length === 0 ? null : `content="frame-src ${frameSrc.map((o) => `${o}/v/`).join(' ')}"`;
  const frameSrcTag =
    frameSrcMeta === null ? '' : createHash('sha256').update(frameSrcMeta).digest('hex').slice(0, 8);
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
    // A widened shell is different bytes from the file on disk, so its tag
    // says so (a cached copy from a deploy with other origins is refetched).
    const widen = frameSrcMeta !== null && (ext === '.html' || ext === '.htm');
    const etagSuffix = widen ? `-f${frameSrcTag}` : '';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${etagSuffix}"`;

    if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
      res.status(304).header('etag', etag).end();
      return '304';
    }

    const raw = await fs.readFile(candidate);
    const body =
      widen && raw.includes(FRAME_SRC_NONE_META)
        ? // A replacer function, so a `$` pattern in the meta is never expanded.
          Buffer.from(raw.toString('utf8').replace(FRAME_SRC_NONE_META, () => frameSrcMeta!), 'utf8')
        : raw;

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

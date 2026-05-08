import { promises as fs } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Inline static-file server for the onboarding SPA.
//
// Intentionally NOT importing @ax/static-files (Invariant I2 — no cross-plugin
// imports). The key difference is that callers apply the I11 post-completion
// gate (410) BEFORE calling these helpers — this module is pure file serving.
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Vite stamps content-hashes into asset filenames (`foo-C9BLoJwu.js`).
// Vite uses base64url-encoded hashes (alphanumeric, A-Z permitted), NOT
// pure hex — so the pattern must accept the full alphanumeric range.
// Files matching this pattern get long-lived cache headers; everything else
// (notably index.html) gets `no-cache` so SPA updates propagate.
const HASHED_FILENAME = /[-_.][a-zA-Z0-9]{8,}\./;

export interface StaticServeDeps {
  /** Absolute path to the dist-spa root. */
  spaRoot: string;
}

export interface StaticServeResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Serve dist-spa/index.html. The path argument is unused (always serves the
 * root index); it's kept for symmetry with serveSpaAsset.
 */
export async function serveSpaIndex(deps: StaticServeDeps): Promise<StaticServeResult> {
  const indexPath = resolve(deps.spaRoot, 'index.html');
  const body = await fs.readFile(indexPath);
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache', // SPA shell is never cached.
    },
    body,
  };
}

/**
 * Serve a static asset from dist-spa/. The requestPath should be the full
 * URL path (e.g. `/setup/static/wizard-abc123.js`). Returns null on unknown
 * extension, path traversal attempt, or missing file — caller emits 404.
 */
export async function serveSpaAsset(
  deps: StaticServeDeps,
  requestPath: string,
): Promise<StaticServeResult | null> {
  // Strip the /setup/ prefix. Vite emits `/setup/static/<file>` in the
  // built index.html, so the on-disk path is `<spaRoot>/static/<file>`.
  const stripped = requestPath.replace(/^\/setup\//, '');

  const ext = extname(stripped).toLowerCase();
  const contentType = MIME_BY_EXT[ext];
  if (contentType === undefined) return null; // unknown extension → 404

  // Strip any leading slashes/dots after normalization to prevent path traversal.
  const normalized = normalize(stripped).replace(/^([./\\])+/, '');
  const full = resolve(deps.spaRoot, normalized);
  const rootWithSep = resolve(deps.spaRoot) + sep;

  // Path traversal guard: resolved path must stay inside spaRoot.
  if (!full.startsWith(rootWithSep) && full !== resolve(deps.spaRoot)) {
    return null;
  }

  let body: Buffer;
  try {
    body = await fs.readFile(full);
  } catch {
    return null;
  }

  return {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': HASHED_FILENAME.test(stripped)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    },
    body,
  };
}

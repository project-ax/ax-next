import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  faultLogFields,
  makeAgentContext,
  sanitizeContentDispositionFilename,
  type HookBus,
  type Logger,
} from '@ax/core';
import { describeMediaType, downloadFilename, type ArtifactPreview } from './media.js';
import type { ArtifactStore } from './store.js';
import { linkBindingFor, verifyViewToken, type ViewTokenClaims } from './view-token.js';

/**
 * The content origin (§6.5): a second HTTP listener, on a different site from
 * the app, that serves artifact bytes and nothing else. What it renders is
 * attacker-controlled HTML, so it must hold nothing worth stealing:
 *
 * - No cookie is read or set, there is no session and no API. The only
 *   credential is a view token in the path (view-token.ts): one version of one
 *   artifact, for minutes.
 * - Every response says nosniff, private no-store and no-referrer, so the token
 *   in the URL is not cached and not sent onward as a Referer.
 * - HTML gets the strict CSP: no network (`connect-src 'none'`), no forms, and
 *   only the app may frame it. Images get the sandboxing CSP, so an SVG opened
 *   on its own runs no script. Downloads are always octet-stream attachments.
 * - Nothing logs the request path or the token. A line names the route
 *   pattern, the status and the failure's codes (TASK-1044).
 * - Every refusal (bad, forged, expired token; missing artifact, version or
 *   bytes; wrong route for the token; a link that went off) is the same 404.
 */

export interface ServedArtifact {
  bytes: Uint8Array;
  mediaType: string;
  preview: ArtifactPreview;
  filename: string;
}

export interface ContentOriginOptions {
  host: string;
  port: number;
  /** What URLs are minted under. Defaults to `http://127.0.0.1:<bound port>` (tests). */
  publicOrigin?: string;
  /** The app origins allowed to frame HTML (`frame-ancestors`). */
  frameAncestors: string[];
  key: Uint8Array;
  serve: (c: ViewTokenClaims) => Promise<ServedArtifact | null>;
  /** Where a failed lookup's route + codes go. Defaults to stderr. */
  logger?: Logger;
}

export interface ContentOriginHandle {
  url: string;
  close(): Promise<void>;
}

const PLUGIN_NAME = '@ax/attachments';

const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const DOWNLOAD_CSP = "default-src 'none'; sandbox";

function htmlCsp(frameAncestors: readonly string[]): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline' 'self'",
    "img-src data: blob: 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors.join(' ')}`,
    // Ruling R8: a /v/ URL opened top-level (not in our iframe) still runs in
    // an opaque origin, so two artifacts never share storage on this origin.
    'sandbox allow-scripts allow-downloads',
  ].join('; ');
}

/** An origin, and nothing that could end the CSP directive or the header: no path, quote, `;`, `,` or space. */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

const NOT_FOUND_BODY = 'not found';

// Slowloris bounds, as @ax/http-server.
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

type Route = '/' | '/v/:token' | '/d/:token';

function routeOf(pathname: string): { route: Route; token: string } | null {
  if (pathname === '/') return { route: '/', token: '' };
  const m = /^\/([vd])\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  return { route: m[1] === 'v' ? '/v/:token' : '/d/:token', token: m[2] ?? '' };
}

/** Sent on every response, Node's own parse-error answers included. */
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
} as const;

/**
 * What a request Node could not parse gets (a malformed request line, headers
 * too large, a header timeout): one fixed 400 with the base headers, then the
 * socket is closed. Node's default answer would skip them.
 */
const CLIENT_ERROR_RESPONSE = [
  'HTTP/1.1 400 Bad Request',
  ...Object.entries(BASE_HEADERS).map(([k, v]) => `${k}: ${v}`),
  'content-type: text/plain; charset=utf-8',
  'content-length: 11',
  'connection: close',
  '',
  'bad request',
].join('\r\n');

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Uint8Array | string): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-length': String(buf.byteLength),
    ...headers,
  });
  res.end(buf);
}

function sendText(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  send(res, status, { 'content-type': 'text/plain; charset=utf-8', ...extra }, body);
}

function notFound(res: ServerResponse): void {
  sendText(res, 404, NOT_FOUND_BODY);
}

export async function startContentOrigin(o: ContentOriginOptions): Promise<ContentOriginHandle> {
  if (o.frameAncestors.length === 0 || !o.frameAncestors.every((a) => ORIGIN_RE.test(a))) {
    throw new Error('content origin: frameAncestors must be one or more bare origins (scheme://host[:port])');
  }
  if (o.publicOrigin !== undefined && !ORIGIN_RE.test(o.publicOrigin.replace(/\/$/, ''))) {
    throw new Error('content origin: publicOrigin must be a bare origin (scheme://host[:port])');
  }
  const csp = htmlCsp(o.frameAncestors);

  const logFailure = (route: Route | '*', status: number, err: unknown): void => {
    const fields = { route, status, ...faultLogFields(err) };
    if (o.logger !== undefined) o.logger.error('artifacts_content_origin_failed', fields);
    else process.stderr.write(`[ax/attachments] content origin ${route} ${status} ${JSON.stringify(fields)}\n`);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Read nothing else from the request: not its cookies, not its query.
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed', { allow: 'GET' });
      return;
    }
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    const matched = routeOf(pathname);
    if (matched === null) return notFound(res);
    if (matched.route === '/') return sendText(res, 200, 'ok');

    const claims = verifyViewToken(o.key, matched.token, Math.floor(Date.now() / 1000));
    const purpose = matched.route === '/v/:token' ? 'view' : 'download';
    if (claims === null || claims.purpose !== purpose) return notFound(res);

    let served: ServedArtifact | null;
    try {
      served = await o.serve(claims);
    } catch (err) {
      logFailure(matched.route, 500, err);
      sendText(res, 500, 'something went wrong');
      return;
    }
    if (served === null) return notFound(res);

    if (purpose === 'download') {
      const filename = sanitizeContentDispositionFilename(served.filename);
      send(
        res,
        200,
        {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${filename}"`,
          'content-security-policy': DOWNLOAD_CSP,
        },
        served.bytes,
      );
      return;
    }
    if (served.preview === 'html') {
      send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }, served.bytes);
      return;
    }
    if (served.preview === 'image') {
      send(res, 200, { 'content-type': served.mediaType, 'content-security-policy': IMAGE_CSP }, served.bytes);
      return;
    }
    // Anything else never renders inline.
    notFound(res);
  }

  const srv = createServer((req, res) => {
    req.on('error', () => {
      /* client went away */
    });
    handle(req, res).catch((err: unknown) => {
      logFailure('*', 500, err);
      try {
        if (!res.headersSent) sendText(res, 500, 'something went wrong');
        else res.destroy();
      } catch {
        /* socket already gone */
      }
    });
  });
  srv.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    // Nothing is logged: the error can quote the bytes the client sent.
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(CLIENT_ERROR_RESPONSE, () => socket.destroy());
  });
  srv.headersTimeout = HEADERS_TIMEOUT_MS;
  srv.requestTimeout = REQUEST_TIMEOUT_MS;
  srv.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(o.port, o.host, () => {
      srv.off('error', reject);
      resolve();
    });
  });
  srv.on('error', (err) => logFailure('*', 500, err));

  const bound = (srv.address() as AddressInfo).port;
  const url = (o.publicOrigin ?? `http://127.0.0.1:${bound}`).replace(/\/$/, '');

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      }),
  };
}

export interface ArtifactServeDeps {
  artifacts: ArtifactStore;
  bus: HookBus;
}

function sameBinding(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The lookup behind a verified token. Re-reads the head on every request, so
 * a deleted artifact, a pruned version, or (for a link holder's token) a link
 * turned off, rotated, or moved to another version stops serving at once.
 */
export function createArtifactServe(deps: ArtifactServeDeps): (c: ViewTokenClaims) => Promise<ServedArtifact | null> {
  const ctx = makeAgentContext({ sessionId: 'content-origin', agentId: PLUGIN_NAME, userId: 'system' });
  return async (c) => {
    const head = await deps.artifacts.getHead(c.artifactId);
    if (head === null) return null;
    if (c.linkBinding !== null) {
      if (head.shareCode === null) return null;
      if (!sameBinding(linkBindingFor(head.shareCode), c.linkBinding)) return null;
      if (c.version !== head.currentVersion) return null;
    }
    const version =
      c.version === head.currentVersion ? head.current : await deps.artifacts.getVersion(head.artifactId, c.version);
    if (version === null) return null;
    const got = await deps.bus.call<{ sha256: string }, { bytes: Uint8Array } | { found: false }>('blob:get', ctx, {
      sha256: version.sha256,
    });
    if (!('bytes' in got)) return null;
    const described = describeMediaType(version.mediaType);
    return {
      bytes: got.bytes,
      mediaType: version.mediaType,
      preview: described.preview,
      filename: downloadFilename(head.title, described.extension),
    };
  };
}

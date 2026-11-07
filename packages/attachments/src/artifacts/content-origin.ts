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
import { createHtmlPreparer, type HtmlPreparer, type PoolRefusal, type PrepareRefusal } from '@ax/frame-guard';
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
 * - HTML gets the strict CSP: no CSP-governed network (`connect-src 'none'`),
 *   no forms, and only the app may frame it. CSP does not govern WebRTC, so the HTML is also
 *   rewritten (@ax/frame-guard `prepareArtifactHtml`, on a worker thread, not
 *   this one): child frames and declarative shadow roots are cut and a guard
 *   script that locks WebRTC goes first in `<head>`. A page it cannot rewrite
 *   safely (or one over MAX_HTML_TRANSFORM_BYTES) is a 422 with one fixed line
 *   of text; HTML is never served untransformed. Images get the sandboxing CSP, so an SVG opened
 *   on its own runs no script. Downloads are always octet-stream attachments.
 *   Two residuals, stated plainly (artifacts-webrtc-hostile.browser.test.ts
 *   has the `known gap` tests): the guard is an enumeration of the routes we
 *   know about, so a browser API that makes a child frame or shadow root
 *   outside those entry points would get past it; and a page opened top-level
 *   on /v/ can navigate itself away (meta refresh, `location =`) to a document
 *   with no guard. Inside the app's frame the app's `frame-src` and the
 *   sandbox refuse that; a header cannot stop it, because it is the page's own
 *   navigation. The real fix is network-level (TASK-1065).
 * - Nothing logs the request path or the token. A line names the route
 *   pattern, the status and the failure's codes (TASK-1044).
 * - Every refusal to look something up (bad, forged, expired token; missing
 *   artifact, version or bytes; wrong route for the token; a link that went
 *   off) is the same 404. A page the origin FOUND but will not serve (HTML the
 *   transform refuses, or too big for it) is a 422 with one fixed line and the
 *   download CSP: the requester holds a valid token for it, so that tells them
 *   nothing they could not already see, and without it a page that rendered
 *   before would read as "not found". There are two lines, one for a page that is
 *   too big or too heavy to preview (which can be downloaded instead) and one for
 *   the rest, each the same whatever the cause within its kind. The reason goes to
 *   the log (warn, as a code) and nowhere else.
 */

export interface ServedArtifact {
  bytes: Uint8Array;
  mediaType: string;
  preview: ArtifactPreview;
  filename: string;
  /**
   * Names these exact bytes, for the prepared-HTML cache: the blob's content
   * hash. Optional; a serve without one (a test stub) is never cached.
   */
  contentKey?: string;
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
  /**
   * Bounds of the prepared-HTML cache. A knob for tests: a byte bound is only
   * visible with pages that add up to it, and the real one is 32 MiB.
   */
  htmlCache?: { maxEntries?: number; maxBytes?: number };
  /**
   * What prepares HTML pages. Default: a worker thread of its own, closed with
   * the origin, so a page that costs the transform seconds, or all of its memory,
   * costs them there and not on the thread that serves every request. A test can
   * pass its own (which it then closes itself).
   */
  htmlPreparer?: HtmlPreparer;
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

/**
 * The most HTML the transform is handed. An artifact can be up to 100 MiB
 * (`MAX_ARTIFACT_BYTES` in @ax/tool-artifact-publish, checked where the file is
 * read; the 25 MiB `DEFAULT_MAX_FILE_BYTES` is the attachments UPLOAD cap and
 * does not apply to artifacts). The transform runs off this thread and has limits
 * of its own (see prepareArtifactHtml), but an ordinary 4 MiB page still costs it
 * 0.3 to 0.4 s and 270 MB, so bigger HTML is refused, never served untransformed.
 */
export const MAX_HTML_TRANSFORM_BYTES = 4 * 1024 * 1024;

/** Prepared pages kept so a reload of the same bytes skips the transform: at most this many... */
const HTML_CACHE_MAX_ENTRIES = 16;
/** ...and at most this many bytes of prepared output in all (a page is at most 4x its input, 16 MiB). */
const HTML_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * What the viewer is told when a page is refused: one line, the same every time,
 * nothing of the page. 422, not 404: the requester's token is good, and the page
 * exists. There are two lines, by kind of refusal and no finer: this one for a
 * page that is not safe to show (or could not be shown: the origin was busy, the
 * worker failed), and `HTML_TOO_LARGE_BODY` for one that is too big or too heavy.
 */
export const HTML_REFUSED_BODY = "AX can't show this page safely.";

/**
 * The second line, for a page too big or too heavy to preview: it does not say
 * which limit, and a download of the same page is its bytes (a refusal is about
 * what renders), so it says where to go.
 */
export const HTML_TOO_LARGE_BODY = 'This page is too large to preview here. Download it instead.';

/** Why a page was not served as HTML. The origin's own cap, the transform's reasons, and the worker's. */
type RefusalCode = 'html_too_large' | PrepareRefusal | PoolRefusal;

/**
 * For each reason: which line the viewer is told, and whether the refusal is
 * remembered with the page. A record, so a reason added to @ax/frame-guard does
 * not compile until it has an answer here.
 *
 * A reason about the page is remembered (the same bytes are refused the same
 * way, and the transform running on them again is all a hostile page asks for);
 * that includes `too_slow` and the worker's `worker_timeout` and `worker_oom`,
 * which are measured on CPU time and on a heap that does not depend on what else
 * the machine is doing. `busy` and `worker_failed` are about the moment, not the
 * page, and the next view should try again.
 */
const REFUSALS: Record<RefusalCode, { line: 'too_large' | 'unsafe'; remembered: boolean }> = {
  html_too_large: { line: 'too_large', remembered: true },
  too_many_nodes: { line: 'too_large', remembered: true },
  too_much_work: { line: 'too_large', remembered: true },
  too_slow: { line: 'too_large', remembered: true },
  output_too_large: { line: 'too_large', remembered: true },
  worker_timeout: { line: 'too_large', remembered: true },
  worker_oom: { line: 'too_large', remembered: true },
  nul: { line: 'unsafe', remembered: true },
  cr_entity: { line: 'unsafe', remembered: true },
  too_deep: { line: 'unsafe', remembered: true },
  too_many_attrs: { line: 'unsafe', remembered: true },
  plaintext: { line: 'unsafe', remembered: true },
  quirks: { line: 'unsafe', remembered: true },
  no_fixpoint: { line: 'unsafe', remembered: true },
  parse_error: { line: 'unsafe', remembered: true },
  busy: { line: 'unsafe', remembered: false },
  worker_failed: { line: 'unsafe', remembered: false },
};

/** Why a page was refused. The code is fixed; the message says nothing about the page. */
class HtmlRefusal extends Error {
  constructor(readonly code: RefusalCode) {
    super('html refused');
    this.name = 'HtmlRefusal';
  }
}

type PreparedHtml = { html: Buffer } | { refusal: RefusalCode };

/**
 * The text of an HTML page's bytes, as a browser reads it for `charset=utf-8`:
 * UTF-8, except that a UTF-16 byte order mark outranks the header, so a page
 * that starts with one is UTF-16 to a browser (Windows PowerShell's `Out-File`
 * writes them). Both decoders drop the mark. Nothing else is sniffed.
 */
function decodePage(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder().decode(bytes);
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

  // A refusal of a page is the origin's answer, not a fault: a warning with the
  // reason code, never the error level an alert would page on. Route and a
  // fixed code only: nothing of the path, the token or the page.
  const logRefusal = (route: Route, refusal: HtmlRefusal): void => {
    const fields = { route, status: 422, ...faultLogFields(refusal) };
    if (o.logger !== undefined) o.logger.warn('artifacts_content_origin_refused', fields);
    else process.stderr.write(`[ax/attachments] content origin ${route} 422 ${JSON.stringify(fields)}\n`);
  };

  // A fault of the worker that prepares pages (it crashed, it could not start), not of a page: an error, with
  // the codes of the failure and nothing else. What the viewer gets for it is the refusal below.
  const logWorkerFault = (err: unknown): void => {
    const fields = { ...faultLogFields(err) };
    if (o.logger !== undefined) o.logger.error('artifacts_content_origin_worker_failed', fields);
    else process.stderr.write(`[ax/attachments] content origin html worker failed ${JSON.stringify(fields)}\n`);
  };
  const ownsPreparer = o.htmlPreparer === undefined;
  const preparer = o.htmlPreparer ?? createHtmlPreparer({ onFault: logWorkerFault });

  // Keyed by content hash: the same bytes always prepare the same way, so no
  // version or artifact id is needed (and none can be stale). A refusal is
  // remembered like a page (it costs nothing against the byte bound, and counts
  // as an entry), so a hostile page can't be retried to burn the worker's time,
  // whatever the size of the page it would have been or the reason: out of time,
  // out of memory, too deep. The two that are not remembered are about the moment
  // and not the page (REFUSALS). Map order is recency: a hit is re-inserted last,
  // the oldest goes first.
  const htmlCache = new Map<string, PreparedHtml>();
  let htmlCacheBytes = 0;
  const maxEntries = o.htmlCache?.maxEntries ?? HTML_CACHE_MAX_ENTRIES;
  const maxBytes = o.htmlCache?.maxBytes ?? HTML_CACHE_MAX_BYTES;
  const cost = (p: PreparedHtml): number => ('html' in p ? p.html.byteLength : 0);
  /** Pages being prepared now, by key: a view of the same bytes while one is going waits for it, and does not start another. */
  const preparing = new Map<string, Promise<PreparedHtml>>();

  function remember(key: string, out: PreparedHtml): void {
    if (('refusal' in out && !REFUSALS[out.refusal].remembered) || cost(out) > maxBytes) return;
    const before = htmlCache.get(key);
    if (before !== undefined) htmlCacheBytes -= cost(before);
    htmlCache.delete(key);
    htmlCache.set(key, out);
    htmlCacheBytes += cost(out);
    for (const [k, v] of htmlCache) {
      if (htmlCache.size <= maxEntries && htmlCacheBytes <= maxBytes) break;
      htmlCache.delete(k);
      htmlCacheBytes -= cost(v);
    }
  }

  async function prepareFresh(served: ServedArtifact): Promise<PreparedHtml> {
    if (served.bytes.byteLength > MAX_HTML_TRANSFORM_BYTES) return { refusal: 'html_too_large' };
    const prepared = await preparer.prepare(decodePage(served.bytes));
    if (!prepared.ok) return { refusal: prepared.reason };
    // The worker handed its buffer over: this is a view of it, not a copy.
    return { html: Buffer.from(prepared.bytes.buffer, prepared.bytes.byteOffset, prepared.bytes.byteLength) };
  }

  async function prepareHtml(served: ServedArtifact): Promise<PreparedHtml> {
    const key = served.contentKey;
    if (key === undefined) return prepareFresh(served);
    const hit = htmlCache.get(key);
    if (hit !== undefined) {
      htmlCache.delete(key);
      htmlCache.set(key, hit);
      return hit;
    }
    let pending = preparing.get(key);
    if (pending === undefined) {
      pending = prepareFresh(served)
        .then((out) => {
          remember(key, out);
          return out;
        })
        .finally(() => preparing.delete(key));
      preparing.set(key, pending);
    }
    return pending;
  }

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
      const prepared = await prepareHtml(served);
      if ('refusal' in prepared) {
        logRefusal(matched.route, new HtmlRefusal(prepared.refusal));
        // The download CSP (no script, sandboxed) though the body is plain text: belt and braces.
        const body = REFUSALS[prepared.refusal].line === 'too_large' ? HTML_TOO_LARGE_BODY : HTML_REFUSED_BODY;
        sendText(res, 422, body, { 'content-security-policy': DOWNLOAD_CSP });
        return;
      }
      send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }, prepared.html);
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
    close: async () => {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
      if (ownsPreparer) await preparer.close();
    },
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
 * A chat visual never serves here (U1): no hook mints a token for one, and
 * this re-check holds even if one were signed.
 */
export function createArtifactServe(deps: ArtifactServeDeps): (c: ViewTokenClaims) => Promise<ServedArtifact | null> {
  const ctx = makeAgentContext({ sessionId: 'content-origin', agentId: PLUGIN_NAME, userId: 'system' });
  return async (c) => {
    const head = await deps.artifacts.getHead(c.artifactId);
    if (head === null || head.visual) return null;
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
      contentKey: version.sha256,
    };
  };
}

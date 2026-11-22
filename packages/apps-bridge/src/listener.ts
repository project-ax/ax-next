/**
 * The bridge's own HTTP listener: the external apps platform's only way in.
 * It is a separate `node:http` server on its own port (default 9092) so the
 * chart can keep it off the public Ingress and admit only the platform
 * through a NetworkPolicy; `@ax/http-server`'s single listener couldn't be.
 *
 * It serves three routes and nothing else:
 *
 *   POST /api/apps-bridge/v1/links/claim
 *   POST /api/apps-bridge/v1/call
 *   GET  /api/apps-bridge/v1/apps/:appId/grants
 *
 * Each request, in order; the first refusal answers:
 *  1. route: an unknown path is 404 and a known path with another method is
 *     405 with `Allow`, both with no body, nothing logged and no CORS;
 *  2. the caller, from the headers alone: `Authorization: Bearer <token>`,
 *     at most MAX_TOKEN_CHARS, verified (keys-unavailable → unavailable, any
 *     other failure → unauthenticated). No body byte has been read yet, and a
 *     client that sent `Expect: 100-continue` has not been told to send it;
 *  3. the platform's window (rate_limited, Retry-After 60);
 *  4. POSTs: `/call` takes an in-flight slot (none → rate_limited,
 *     Retry-After 1; released in `finally`, client gone or not); the content
 *     type must be application/json; a declared length over the route's cap
 *     is refused unread; the body is read counting bytes and refused the
 *     moment it passes the cap; it must be UTF-8 JSON;
 *  5. the answer function (Task 7's answerClaim / answerCall / answerGrants).
 *
 * Every route answer is JSON with `cache-control: no-store` and
 * `x-content-type-options: nosniff`, plus `retry-after` when it has one. A
 * refusal made before the body was read closes the connection, so a client
 * can't make us drain a body it was refused for.
 *
 * Exactly one info line per route request (`apps_bridge_link_claim`,
 * `apps_bridge_call`, `apps_bridge_grants`): the platform id once the caller
 * is authenticated, then the answer's own log fields, or `{ outcome, reason }`
 * for a refusal made here. Never the path, a header, a token or the body.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { APPS_BRIDGE_V1_BASE_PATH, MAX_TOKEN_CHARS, REFUSAL_STATUS, type RefusalCode } from '@ax/apps-bridge-contract';
import type { Logger } from '@ax/core';
import type { BridgeAnswer, BridgeLog } from './bridge-call.js';
import type { BridgeLimiter } from './limits.js';
import { loggableCode } from './log-code.js';
import type { CallerVerdict } from './verify-token.js';

export const BRIDGE_LISTENER_LIMITS = {
  maxCallBodyBytes: 1_048_576,
  maxClaimBodyBytes: 16_384,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 90_000,
  keepAliveTimeoutMs: 5_000,
} as const;

/**
 * How long `close()` waits for requests already admitted before it cuts the
 * connections: just under the kernel's default per-plugin shutdown timeout
 * (10 s), so the cut happens inside the plugin's own shutdown.
 */
export const BRIDGE_SHUTDOWN_DRAIN_MS = 9_000;

export interface BridgeListenerOptions {
  host: string;
  port: number;
  platformId: string;
  verifyCaller: (token: string) => Promise<CallerVerdict>;
  limiter: BridgeLimiter;
  claim: (body: unknown) => Promise<BridgeAnswer>;
  call: (body: unknown) => Promise<BridgeAnswer>;
  grants: (appId: string) => Promise<BridgeAnswer>;
  logger: Logger;
  /** Test seam: `close()`'s wait for admitted requests. Default BRIDGE_SHUTDOWN_DRAIN_MS. */
  drainTimeoutMs?: number;
}

export interface BridgeListener {
  port(): number;
  /** Stops taking new connections and closes idle ones. Requests already admitted carry on. Idempotent. */
  stopAccepting(): Promise<void>;
  /** stopAccepting(), waits for admitted requests (up to the drain timeout), then cuts every connection. Idempotent. */
  close(): Promise<void>;
}

type RouteName = 'claim' | 'call' | 'grants';

const LOG_EVENT: Record<RouteName, string> = {
  claim: 'apps_bridge_link_claim',
  call: 'apps_bridge_call',
  grants: 'apps_bridge_grants',
};

const CLAIM_PATH = `${APPS_BRIDGE_V1_BASE_PATH}/links/claim`;
const CALL_PATH = `${APPS_BRIDGE_V1_BASE_PATH}/call`;
const GRANTS_PREFIX = `${APPS_BRIDGE_V1_BASE_PATH}/apps/`;
const GRANTS_SUFFIX = '/grants';

type Routed = { route: RouteName; allow: 'POST' | 'GET'; appId?: string };

function routeOf(pathname: string): Routed | null {
  if (pathname === CLAIM_PATH) return { route: 'claim', allow: 'POST' };
  if (pathname === CALL_PATH) return { route: 'call', allow: 'POST' };
  if (pathname.startsWith(GRANTS_PREFIX) && pathname.endsWith(GRANTS_SUFFIX)) {
    const appId = pathname.slice(GRANTS_PREFIX.length, pathname.length - GRANTS_SUFFIX.length);
    // One non-empty segment; answerGrants holds it to the app id grammar.
    if (appId.length > 0 && !appId.includes('/')) return { route: 'grants', allow: 'GET', appId };
  }
  return null;
}

/** Sent on every response, Node's own parse-error answer included. */
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

/**
 * What a request Node could not parse gets (a malformed request line, headers
 * too large, a header timeout): one fixed 400, then the socket is closed.
 */
const CLIENT_ERROR_BODY = JSON.stringify({ code: 'invalid_request' });
const CLIENT_ERROR_RESPONSE = [
  'HTTP/1.1 400 Bad Request',
  ...Object.entries(BASE_HEADERS).map(([k, v]) => `${k}: ${v}`),
  'content-type: application/json; charset=utf-8',
  `content-length: ${Buffer.byteLength(CLIENT_ERROR_BODY)}`,
  'connection: close',
  '',
  CLIENT_ERROR_BODY,
].join('\r\n');

/** Node's own test for `Expect: 100-continue` (its `continueExpression`), so a request it routes to checkContinue is continued. */
const CONTINUE_RE = /(?:^|\W)100-continue(?:$|\W)/i;

/** What a request with any other `Expect` gets, before routing or authentication. Not logged. */
const EXPECTATION_FAILED_RESPONSE_HEADERS = { ...BASE_HEADERS, 'content-length': '0', connection: 'close' } as const;

/** `Bearer <token>`: the scheme in any case, one or more spaces, one token with no whitespace. */
const BEARER_RE = /^Bearer +(\S+)$/i;

const RETRY_AFTER: Partial<Record<RefusalCode, number>> = { unavailable: 5 };

/** A refusal decided here, before or instead of an answer function. */
function refusal(code: RefusalCode, reason: string, retryAfterSeconds?: number): BridgeAnswer {
  const retry = retryAfterSeconds ?? RETRY_AFTER[code];
  return {
    status: REFUSAL_STATUS[code],
    body: { code } as BridgeAnswer['body'],
    ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
    log: { outcome: code, reason },
  };
}

/** Is the media type `application/json`, parameters allowed? */
function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const semi = contentType.indexOf(';');
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase() === 'application/json';
}

type BodyRead = { ok: true; bytes: Buffer } | { ok: false; reason: 'too-large' | 'aborted' };

/** The client is gone: the request or its socket is destroyed or aborted. */
function clientGone(req: IncomingMessage): boolean {
  return req.destroyed || req.readableAborted || req.socket.destroyed;
}

/**
 * Reads the body, counting bytes, and stops the moment it passes `cap`
 * (nothing past the cap is kept). Settles once: on the end, at the cap, or
 * when the client goes away, including before this was called (the request's
 * 'close' may have fired while the caller was still being authenticated, and
 * would never fire again).
 */
function readBody(req: IncomingMessage, cap: number): Promise<BodyRead> {
  if (clientGone(req)) return Promise.resolve({ ok: false, reason: 'aborted' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: BodyRead): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onClose);
      if (!r.ok) req.pause();
      resolve(r);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > cap) {
        chunks.length = 0;
        finish({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ ok: true, bytes: Buffer.concat(chunks, size) });
    // 'close' before 'end': the client hung up mid-body.
    const onClose = (): void => finish({ ok: false, reason: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('close', onClose);
  });
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(UTF8.decode(bytes)) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function startBridgeListener(o: BridgeListenerOptions): Promise<BridgeListener> {
  const drainTimeoutMs = o.drainTimeoutMs ?? BRIDGE_SHUTDOWN_DRAIN_MS;
  /** Every admitted route request until its handler is done and its response is closed. */
  const inFlight = new Set<Promise<void>>();
  let accepting = true;

  function sendEmpty(res: ServerResponse, status: 404 | 405, allow?: string): void {
    res.writeHead(status, {
      ...BASE_HEADERS,
      'content-length': '0',
      ...(allow !== undefined ? { allow } : {}),
      // The request's body (if any) is never read.
      connection: 'close',
    });
    res.end();
  }

  /** `endConnection`: close the connection after this answer whatever else holds. */
  function sendAnswer(req: IncomingMessage, res: ServerResponse, a: BridgeAnswer, bodyUnread: boolean, endConnection = false): void {
    if (res.headersSent || res.destroyed || res.writableEnded) return;
    const text = JSON.stringify(a.body);
    res.writeHead(a.status, {
      ...BASE_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text, 'utf8')),
      ...(a.retryAfterSeconds !== undefined ? { 'retry-after': String(a.retryAfterSeconds) } : {}),
      // A refusal made without reading a body that may still be on its way
      // ends the connection rather than drain what the client sends.
      ...((bodyUnread && !req.complete) || endConnection ? { connection: 'close' } : {}),
    });
    res.end(text);
  }

  function log(route: RouteName, authenticated: boolean, fields: BridgeLog): void {
    try {
      o.logger.info(LOG_EVENT[route], { ...(authenticated ? { platformId: o.platformId } : {}), ...fields });
    } catch {
      /* a broken logger must not break the answer */
    }
  }

  /** Steps 2-5 for one routed request. Resolves with the answer and whether the body went unread. */
  async function decide(req: IncomingMessage, res: ServerResponse, r: Routed): Promise<{ answer: BridgeAnswer; authenticated: boolean; bodyUnread: boolean }> {
    const unread = (answer: BridgeAnswer, authenticated: boolean) => ({ answer, authenticated, bodyUnread: true });

    // 2. The caller, from the headers alone.
    const header = req.headers.authorization;
    if (header === undefined || header === '') return unread(refusal('unauthenticated', 'missing'), false);
    const m = BEARER_RE.exec(header);
    const token = m?.[1];
    if (token === undefined) return unread(refusal('unauthenticated', 'not-bearer'), false);
    if (token.length > MAX_TOKEN_CHARS) return unread(refusal('unauthenticated', 'too-long'), false);
    let verdict: CallerVerdict;
    try {
      verdict = await o.verifyCaller(token);
    } catch {
      return unread(refusal('unavailable', 'verify-failed'), false);
    }
    if (!verdict.ok) {
      return unread(
        verdict.reason === 'keys-unavailable'
          ? refusal('unavailable', 'keys-unavailable')
          : refusal('unauthenticated', verdict.reason),
        false,
      );
    }

    // 3. The platform's window.
    if (!o.limiter.takePlatform(o.platformId)) return unread(refusal('rate_limited', 'platform', 60), true);

    // 5 (GET). The raw segment goes in as is; answerGrants checks it.
    // A GET has no body to read; one sent anyway is never read.
    if (r.route === 'grants') return { answer: await o.grants(r.appId ?? ''), authenticated: true, bodyUnread: true };

    // 4. POSTs.
    const release = r.route === 'call' ? o.limiter.acquire(o.platformId) : () => {};
    if (release === null) return unread(refusal('rate_limited', 'in-flight', 1), true);
    try {
      if (!isJson(req.headers['content-type'])) return unread(refusal('invalid_request', 'content-type'), true);
      const cap = r.route === 'call' ? BRIDGE_LISTENER_LIMITS.maxCallBodyBytes : BRIDGE_LISTENER_LIMITS.maxClaimBodyBytes;
      const declared = req.headers['content-length'];
      if (declared !== undefined && Number(declared) > cap) return unread(refusal('invalid_request', 'too-large'), true);

      // Only now is the client told to send its body, if it asked first.
      if (CONTINUE_RE.test(req.headers.expect ?? '')) res.writeContinue();
      const read = await readBody(req, cap);
      if (!read.ok) return unread(refusal('invalid_request', read.reason), true);
      const parsed = parseJson(read.bytes);
      if (!parsed.ok) return { answer: refusal('invalid_request', 'bad-json'), authenticated: true, bodyUnread: false };

      const answer = r.route === 'call' ? await o.call(parsed.value) : await o.claim(parsed.value);
      return { answer, authenticated: true, bodyUnread: false };
    } finally {
      release();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? '';
    const rawUrl = req.url ?? '';
    const q = rawUrl.indexOf('?');
    const r = routeOf(q === -1 ? rawUrl : rawUrl.slice(0, q));
    if (r === null) {
      sendEmpty(res, 404);
      return;
    }
    if (method !== r.allow) {
      sendEmpty(res, 405, r.allow);
      return;
    }

    // Stopped: a request still arriving on a connection opened before the
    // stop is turned away unauthenticated, and its connection ended.
    if (!accepting) {
      const answer = refusal('unavailable', 'shutting-down');
      log(r.route, false, answer.log);
      try {
        sendAnswer(req, res, answer, true, true);
      } catch {
        /* the client is gone */
      }
      return;
    }

    let outcome: { answer: BridgeAnswer; authenticated: boolean; bodyUnread: boolean };
    try {
      outcome = await decide(req, res, r);
    } catch (err) {
      // The answer functions answer every failure themselves; this is the
      // last guard. Only the error's loggable code is kept, never its message.
      const answer = refusal('unavailable', 'internal');
      const code = loggableCode(err);
      answer.log = { ...answer.log, unexpected: true, ...(code !== undefined ? { code } : {}) };
      outcome = { answer, authenticated: true, bodyUnread: !req.complete };
    }
    log(r.route, outcome.authenticated, outcome.answer.log);
    try {
      sendAnswer(req, res, outcome.answer, outcome.bodyUnread);
    } catch {
      /* the client is gone */
    }
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    req.on('error', () => {
      /* client went away */
    });
    res.on('error', () => {
      /* client went away */
    });
    const closed = new Promise<void>((resolve) => res.once('close', () => resolve()));
    // handle() guards its own steps; anything that still escapes ends the
    // connection rather than answer something unplanned.
    const done = handle(req, res).catch(() => {
      res.destroy();
    });
    const settled = Promise.all([done, closed]).then(() => undefined);
    inFlight.add(settled);
    void settled.finally(() => inFlight.delete(settled));
  }

  const srv = createServer(onRequest);
  // Node answers `Expect: 100-continue` itself unless told otherwise; the
  // handler sends it only after the caller is authenticated.
  srv.on('checkContinue', onRequest);
  // Node's default answer to any other expectation is a bare 417 without our headers.
  srv.on('checkExpectation', (req: IncomingMessage, res: ServerResponse) => {
    req.on('error', () => {});
    res.on('error', () => {});
    res.writeHead(417, EXPECTATION_FAILED_RESPONSE_HEADERS);
    res.end();
  });
  srv.on('clientError', (err: NodeJS.ErrnoException, socket: Socket) => {
    // Nothing is logged: the error can quote the bytes the client sent.
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(CLIENT_ERROR_RESPONSE, () => socket.destroy());
  });
  srv.headersTimeout = BRIDGE_LISTENER_LIMITS.headersTimeoutMs;
  srv.requestTimeout = BRIDGE_LISTENER_LIMITS.requestTimeoutMs;
  srv.keepAliveTimeout = BRIDGE_LISTENER_LIMITS.keepAliveTimeoutMs;

  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(o.port, o.host, () => {
      srv.off('error', reject);
      resolve();
    });
  });
  srv.on('error', (err: NodeJS.ErrnoException) => {
    // A code only: a listener error's message can carry addresses.
    o.logger.warn('apps_bridge_listener_error', typeof err.code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(err.code) ? { code: err.code } : {});
  });
  const bound = (srv.address() as AddressInfo).port;

  let serverClosed: Promise<void> | undefined;
  const stopAccepting = (): Promise<void> => {
    accepting = false;
    if (serverClosed === undefined) {
      serverClosed = new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
      srv.closeIdleConnections();
    }
    return Promise.resolve();
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await stopAccepting();
      if (inFlight.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, drainTimeoutMs);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
      srv.closeAllConnections();
      await serverClosed;
    })();
    return closing;
  };

  return { port: () => bound, stopAccepting, close };
}

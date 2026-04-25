import * as http from 'node:http';
import {
  PluginError,
  isRejection,
  makeChatContext,
  type Plugin,
  type HookBus,
  type ChatContext,
} from '@ax/core';
import { Router } from './router.js';
import {
  assertKeyLength,
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookieKey,
  signCookieValue,
  verifyCookieValue,
  type CookieEnv,
  type SignedCookieOptions,
} from './cookies.js';
import { createCsrfSubscriber } from './csrf.js';
import {
  MAX_BODY_BYTES,
  type ClearCookieOptions,
  type HttpMethod,
  type HttpRegisterRouteInput,
  type HttpRegisterRouteOutput,
  type HttpRequest,
  type HttpRequestEvent,
  type HttpResponse,
  type HttpResponseSentEvent,
} from './types.js';

const PLUGIN_NAME = '@ax/http-server';
const HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

// Slowloris / connection-exhaustion mitigations. This listener faces public
// traffic (admin UI, OIDC callback, future channel webhooks); pinning these
// at module scope keeps a misbehaving client from holding a socket open
// indefinitely.
const HEADERS_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

export interface CreateHttpServerPluginOptions {
  host: string;
  /** Pass 0 to let the OS assign a free port; readable via `boundPort()`. */
  port: number;
  /**
   * Exact-match Origin allow-list for CSRF on state-changing methods.
   * Empty array means only `X-Requested-With: ax-admin` callers can mutate
   * state — emits a stderr warn unless `AX_HTTP_ALLOW_NO_ORIGINS=1`.
   */
  allowedOrigins?: readonly string[];
  /**
   * Test seam for the cookie signing key. Production reads
   * `AX_HTTP_COOKIE_KEY` env at init (64 hex chars or 44 base64 chars).
   * If neither is set, init fails with `invalid-cookie-key`.
   */
  cookieKey?: Buffer;
}

export interface HttpServerPlugin extends Plugin {
  /** Returns the bound TCP port. Throws if called before `init()` resolves. */
  boundPort(): number;
}

export function createHttpServerPlugin(
  opts: CreateHttpServerPluginOptions,
): HttpServerPlugin {
  const router = new Router();
  let server: http.Server | null = null;
  let boundPort: number | null = null;

  const allowedOrigins = opts.allowedOrigins ?? [];
  const trustProxy = (): boolean => process.env.AX_TRUST_PROXY === '1';

  const fireRequest = async (
    bus: HookBus,
    ctx: ChatContext,
    payload: HttpRequestEvent,
  ): Promise<{ rejected: false; payload: HttpRequestEvent } | { rejected: true; reason: string }> => {
    const result = await bus.fire('http:request', ctx, payload);
    if (result.rejected) {
      return { rejected: true, reason: result.reason };
    }
    return { rejected: false, payload: result.payload };
  };

  const fireResponseSent = async (
    bus: HookBus,
    ctx: ChatContext,
    payload: HttpResponseSentEvent,
  ): Promise<void> => {
    // bus.fire isolates subscriber failures; this catch is defensive against
    // a future bus impl that lets them propagate.
    try {
      await bus.fire('http:response-sent', ctx, payload);
    } catch {
      // intentional swallow
    }
  };

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['http:register-route'],
      calls: [],
      // CSRF guard subscribes to http:request internally; subscribers
      // don't form bootstrap dependency edges, so they stay out of the
      // manifest (only `calls` does, per @ax/core/bootstrap).
      subscribes: [],
    },
    boundPort(): number {
      if (boundPort === null) {
        throw new PluginError({
          code: 'not-initialized',
          plugin: PLUGIN_NAME,
          message: 'http-server boundPort() called before init()',
        });
      }
      return boundPort;
    },
    async init({ bus }) {
      const cookieKey = resolveCookieKey(opts.cookieKey);

      if (allowedOrigins.length === 0 && process.env.AX_HTTP_ALLOW_NO_ORIGINS !== '1') {
        process.stderr.write(
          `[ax/http-server] WARNING: allowedOrigins is empty; only X-Requested-With: ax-admin callers can mutate state. Set AX_HTTP_ALLOW_NO_ORIGINS=1 to silence this warning.\n`,
        );
      }

      bus.subscribe(
        'http:request',
        `${PLUGIN_NAME}/csrf`,
        createCsrfSubscriber({ allowedOrigins }),
      );

      bus.registerService<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
        'http:register-route',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (!HTTP_METHODS.has(input.method)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: `unsupported method: ${input.method}`,
            });
          }
          if (typeof input.path !== 'string' || input.path.length === 0 || !input.path.startsWith('/')) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: `path must be a non-empty string starting with '/': got ${JSON.stringify(input.path)}`,
            });
          }
          if (typeof input.handler !== 'function') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'handler must be a function',
            });
          }
          let unregister: () => void;
          try {
            unregister = router.register(input.method, input.path, input.handler);
          } catch (err) {
            throw new PluginError({
              code: 'duplicate-route',
              plugin: PLUGIN_NAME,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          return { unregister };
        },
      );

      const srv = http.createServer((req, res) => {
        void handle(
          req,
          res,
          bus,
          router,
          cookieKey,
          trustProxy,
          fireRequest,
          fireResponseSent,
        ).catch((err: unknown) => {
          try {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'internal' }));
            } else {
              res.end();
            }
          } catch {
            // socket already dead
          }
          process.stderr.write(
            `[ax/http-server] unhandled handler error: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        });
      });

      // Slowloris mitigations — see HEADERS_TIMEOUT_MS comment above.
      srv.headersTimeout = HEADERS_TIMEOUT_MS;
      srv.requestTimeout = REQUEST_TIMEOUT_MS;
      srv.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

      srv.on('error', (err) => {
        process.stderr.write(
          `[ax/http-server] server error: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });

      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error): void => reject(e);
        srv.once('error', onErr);
        srv.listen(opts.port, opts.host, () => {
          srv.off('error', onErr);
          resolve();
        });
      });

      const addr = srv.address();
      boundPort = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      server = srv;

      process.stderr.write(
        `[ax/http-server] listening on http://${opts.host}:${boundPort}\n`,
      );
    },
    async shutdown() {
      if (server === null) return;
      const srv = server;
      server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    },
  };
}

function resolveCookieKey(opt: Buffer | undefined): Buffer {
  if (opt !== undefined) {
    assertKeyLength(opt);
    return opt;
  }
  const fromEnv = process.env.AX_HTTP_COOKIE_KEY;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return parseCookieKey(fromEnv);
  }
  throw new PluginError({
    code: 'invalid-cookie-key',
    plugin: PLUGIN_NAME,
    message:
      'cookie signing key required: pass cookieKey to createHttpServerPlugin or set AX_HTTP_COOKIE_KEY (32 bytes; 64 hex chars or 44 base64 chars)',
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bus: HookBus,
  router: Router,
  cookieKey: Buffer,
  trustProxy: () => boolean,
  fireRequest: (
    bus: HookBus,
    ctx: ChatContext,
    payload: HttpRequestEvent,
  ) => Promise<
    { rejected: false; payload: HttpRequestEvent } | { rejected: true; reason: string }
  >,
  fireResponseSent: (
    bus: HookBus,
    ctx: ChatContext,
    payload: HttpResponseSentEvent,
  ) => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  const rawMethod = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://http-server.local');
  const path = url.pathname;
  const headers = lowercaseHeaders(req.headers);
  const cookieEnv: CookieEnv = { isSecureRequest: deriveSecure(req, headers, trustProxy) };

  const ctx = makeChatContext({
    sessionId: 'http-server',
    agentId: 'http-server',
    userId: 'http-server',
  });

  const finish = async (status: number, body?: unknown, contentType?: string): Promise<void> => {
    if (!res.headersSent) {
      const ct = contentType ?? 'application/json; charset=utf-8';
      res.writeHead(status, { 'Content-Type': ct });
      if (body === undefined) res.end();
      else if (typeof body === 'string') res.end(body);
      else res.end(JSON.stringify(body));
    } else if (!res.writableEnded) {
      res.end();
    }
    await fireResponseSent(bus, ctx, {
      status,
      durationMs: Date.now() - startedAt,
    });
  };

  if (!HTTP_METHODS.has(rawMethod as HttpMethod)) {
    return finish(405, { error: 'method-not-allowed' });
  }
  const method = rawMethod as HttpMethod;

  // http:request is veto-only — subscriber payload mutations are NOT
  // honored (see HttpRequestEvent docstring); only `rejected` is read.
  const reqResult = await fireRequest(bus, ctx, { method, path, headers });
  if (reqResult.rejected) {
    const status = reqResult.reason.startsWith('csrf') ? 403 : 400;
    return finish(status, { error: reqResult.reason });
  }

  const handler = router.match(method, path);
  if (handler === undefined) {
    const otherMethods = router.methodsFor(path);
    if (otherMethods.size > 0) {
      const allow = [...otherMethods].sort().join(', ');
      res.setHeader('Allow', allow);
      return finish(405, { error: 'method-not-allowed' });
    }
    return finish(404, { error: 'not-found' });
  }

  let body: Buffer;
  try {
    body = await readBodyCapped(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return finish(413, { error: 'body-too-large' });
    }
    throw err;
  }

  const cookies = parseCookieHeader(headers['cookie']);
  // Project URL.searchParams into a plain object once; handlers reading
  // a missing key get `undefined` and don't have to defend against the
  // URLSearchParams API (which silently coerces missing → empty string).
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k.toLowerCase()] = v;
  const adapterReq: HttpRequest = {
    method,
    path,
    query,
    headers,
    body,
    cookies,
    signedCookie(name: string): string | null {
      const raw = cookies[name];
      if (raw === undefined) return null;
      return verifyCookieValue(cookieKey, raw);
    },
  };
  const writer = new ResponseWriter(res, cookieKey, cookieEnv);
  const adapterRes: HttpResponse = writer.adapter;

  let finalStatus = writer.statusCode;
  try {
    await handler(adapterReq, adapterRes);
    finalStatus = writer.statusCode;
  } catch (err) {
    if (isRejection(err)) {
      if (!writer.finished) {
        writer.adapter.status(400).json({ error: err.reason });
        finalStatus = 400;
      }
    } else {
      process.stderr.write(
        `[ax/http-server] handler error on ${method} ${path}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      if (!writer.finished) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'internal' }));
        } else {
          res.end();
        }
        writer.finished = true;
        finalStatus = 500;
      }
    }
  }

  if (!writer.finished) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'handler-did-not-respond' }));
    } else {
      res.end();
    }
    writer.finished = true;
    finalStatus = 500;
  }

  await fireResponseSent(bus, ctx, {
    status: finalStatus,
    durationMs: Date.now() - startedAt,
  });
}

function deriveSecure(
  req: http.IncomingMessage,
  headers: Record<string, string>,
  trustProxy: () => boolean,
): boolean {
  // Direct TLS termination (encrypted property is set by tls.Server). The
  // node:http server we use here doesn't speak TLS itself; this branch is
  // future-proofing for an https.Server reuse and the rarer dev case where
  // ax-next is fronted by nothing.
  const sock = (req.socket as { encrypted?: boolean } | null) ?? null;
  if (sock?.encrypted === true) return true;
  if (!trustProxy()) return false;
  const xfp = headers['x-forwarded-proto'];
  if (typeof xfp !== 'string') return false;
  // Comma-separated list when multiple proxies; first hop is closest to the client.
  const first = xfp.split(',')[0]?.trim().toLowerCase();
  return first === 'https';
}

class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const cl = req.headers['content-length'];
    if (typeof cl === 'string' && cl.length > 0) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > maxBytes) {
        // Drain via resume() (not destroy) so the 413 response can flush
        // before the connection closes — destroying mid-flight resets the
        // connection and the client never sees our error.
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Don't destroy the request mid-stream — that aborts the connection
        // before the 413 response can flush. Drop chunks and resume() to
        // drain the rest while the response writes cleanly.
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        settle(() => reject(new BodyTooLargeError()));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (e) => settle(() => reject(e)));
    req.on('end', () => {
      settle(() => resolve(Buffer.concat(chunks, total)));
    });
  });
}

class ResponseWriter {
  finished = false;
  statusCode = 200;
  private headers = new Map<string, string>();
  // Set-Cookie is a multi-value header; flatten to array so multiple
  // cookies in one response write distinct header lines.
  private setCookies: string[] = [];
  private res: http.ServerResponse;
  private cookieKey: Buffer;
  private cookieEnv: CookieEnv;

  readonly adapter: HttpResponse;

  constructor(res: http.ServerResponse, cookieKey: Buffer, cookieEnv: CookieEnv) {
    this.res = res;
    this.cookieKey = cookieKey;
    this.cookieEnv = cookieEnv;
    this.adapter = {
      status: (n: number) => {
        if (this.finished) {
          throw new Error('response already finished');
        }
        if (!Number.isInteger(n) || n < 100 || n > 599) {
          throw new Error(`invalid status code: ${n}`);
        }
        this.statusCode = n;
        return this.adapter;
      },
      header: (name: string, value: string) => {
        if (this.finished) {
          throw new Error('response already finished');
        }
        this.headers.set(name.toLowerCase(), value);
        return this.adapter;
      },
      text: (s: string) => {
        if (this.finished) throw new Error('response already finished');
        this.finished = true;
        this.flush('text/plain; charset=utf-8', s);
      },
      json: (v: unknown) => {
        if (this.finished) throw new Error('response already finished');
        // Serialize BEFORE marking finished — JSON.stringify can throw on
        // circular refs / BigInts, and a half-finished writer would let
        // the catch path try res.end() on a stream the caller still
        // thinks is open.
        const body = JSON.stringify(v);
        this.finished = true;
        this.flush('application/json; charset=utf-8', body);
      },
      end: () => {
        if (this.finished) throw new Error('response already finished');
        this.finished = true;
        this.flushEmpty();
      },
      redirect: (url: string, status?: number) => {
        if (this.finished) throw new Error('response already finished');
        const code = status ?? 302;
        if (!Number.isInteger(code) || code < 300 || code >= 400) {
          throw new Error(`redirect status must be 3xx: got ${code}`);
        }
        this.statusCode = code;
        this.headers.set('location', url);
        this.finished = true;
        this.flushEmpty();
      },
      setSignedCookie: (name: string, value: string, opts?: SignedCookieOptions) => {
        if (this.finished) throw new Error('response already finished');
        const wire = signCookieValue(this.cookieKey, value);
        const header = buildSetCookieHeader(name, wire, opts ?? {}, this.cookieEnv);
        this.setCookies.push(header);
      },
      clearCookie: (name: string, opts?: ClearCookieOptions) => {
        if (this.finished) throw new Error('response already finished');
        const header = buildClearCookieHeader(name, opts ?? {}, this.cookieEnv);
        this.setCookies.push(header);
      },
    };
  }

  private flush(contentType: string, body: string): void {
    if (!this.headers.has('content-type')) {
      this.headers.set('content-type', contentType);
    }
    this.writeHead();
    this.res.end(body);
  }

  private flushEmpty(): void {
    this.writeHead();
    this.res.end();
  }

  private writeHead(): void {
    const headersOut: Record<string, string | string[]> = {};
    for (const [k, v] of this.headers) headersOut[k] = v;
    if (this.setCookies.length > 0) {
      headersOut['set-cookie'] = this.setCookies;
    }
    this.res.writeHead(this.statusCode, headersOut);
  }
}

function lowercaseHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header.length === 0) return out;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name.length === 0) continue;
    // First occurrence wins on duplicate cookie names.
    if (!(name in out)) out[name] = value;
  }
  return out;
}

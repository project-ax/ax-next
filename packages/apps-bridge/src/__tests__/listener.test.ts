import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import type { Logger } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeAnswer } from '../bridge-call.js';
import { createBridgeLimiter, type BridgeLimits } from '../limits.js';
import { BRIDGE_LISTENER_LIMITS, startBridgeListener, type BridgeListener, type BridgeListenerOptions } from '../listener.js';
import type { CallerVerdict } from '../verify-token.js';

/*
  The bridge's own listener over real sockets on 127.0.0.1 (port 0), with
  fakes for the caller verifier and the three answers, and the real limiter.
  What it must hold: the caller is authenticated from headers before any body
  byte is read; bodies are capped and read only after that; every route
  answer is JSON, no-store and nosniff; one log line per route request,
  never carrying a token, a header, the path or the body.
*/

const BASE = '/api/apps-bridge/v1';
const CLAIM = `${BASE}/links/claim`;
const CALL = `${BASE}/call`;
const grantsPath = (appId: string) => `${BASE}/apps/${appId}/grants`;
const P = 'canopy';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.SECRET-TOKEN-BODY.signature';
const KEYS_DOWN = 'eyJhbGciOiJSUzI1NiJ9.KEYS-DOWN.signature';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_CT = { 'content-type': 'application/json' };

interface Line { level: string; msg: string; bindings: Record<string, unknown> | undefined }

function capturingLogger(lines: Line[]): Logger {
  const at = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    lines.push({ level, msg, bindings });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  return logger;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (body: BridgeAnswer['body'], log: BridgeAnswer['log']): BridgeAnswer => ({ status: 200, body, log });

const open: BridgeListener[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((l) => l.close()));
});

interface Opts {
  limits?: Partial<BridgeLimits>;
  claim?: BridgeListenerOptions['claim'];
  call?: BridgeListenerOptions['call'];
  grants?: BridgeListenerOptions['grants'];
  verifyCaller?: BridgeListenerOptions['verifyCaller'];
  drainTimeoutMs?: number;
}

async function start(o: Opts = {}) {
  const lines: Line[] = [];
  const verifyCaller = vi.fn(
    o.verifyCaller ??
      (async (token: string): Promise<CallerVerdict> => {
        if (token === TOKEN) return { ok: true };
        if (token === KEYS_DOWN) return { ok: false, reason: 'keys-unavailable' };
        return { ok: false, reason: 'bad-signature' };
      }),
  );
  const claim = vi.fn(o.claim ?? (async () => ok({ appId: 'app_1' }, { appId: 'app_1', outcome: 'linked' })));
  const call = vi.fn(
    o.call ??
      (async () =>
        ok({ outcome: 'succeeded', content: [] }, { appId: 'app_1', connectorId: 'linear', tool: 'list', mode: 'builder', outcome: 'succeeded' })),
  );
  const grants = vi.fn(o.grants ?? (async (appId: string) => ok({ grants: [] }, { appId, outcome: 'succeeded' })));
  const listener = await startBridgeListener({
    host: '127.0.0.1',
    port: 0,
    platformId: P,
    verifyCaller,
    limiter: createBridgeLimiter({ limits: o.limits }),
    claim,
    call,
    grants,
    logger: capturingLogger(lines),
    ...(o.drainTimeoutMs !== undefined ? { drainTimeoutMs: o.drainTimeoutMs } : {}),
  });
  open.push(listener);
  const routeLines = () => lines.filter((l) => l.msg.startsWith('apps_bridge_'));
  return { listener, lines, routeLines, verifyCaller, claim, call, grants };
}

interface Reply { status: number; headers: IncomingHttpHeaders; text: string; json: unknown }

interface Send {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Write the body but don't end the request: the reply must come without it. */
  noEnd?: boolean;
}

function send(port: number, s: Send): { req: ClientRequest; reply: Promise<Reply> } {
  const req = httpRequest({ host: '127.0.0.1', port, method: s.method ?? 'GET', path: s.path, headers: s.headers, agent: false });
  const reply = new Promise<Reply>((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try {
          json = text === '' ? undefined : JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
  });
  if (s.body !== undefined) req.write(s.body);
  // Node's client holds the headers back until a write or end; send them now.
  else if (s.noEnd) req.flushHeaders();
  if (!s.noEnd) req.end();
  return { req, reply };
}

const fetchIt = (port: number, s: Send) => send(port, s).reply;

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  return fetchIt(port, {
    method: 'POST',
    path,
    headers: { ...AUTH, ...JSON_CT, 'content-length': String(Buffer.byteLength(text)), ...headers },
    body: text,
  });
}

function expectJsonHeaders(r: Reply): void {
  expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
}

function expectRefusal(r: Reply, status: number, code: string, retryAfter?: string): void {
  expect(r.status).toBe(status);
  expect(r.json).toEqual({ code });
  expectJsonHeaders(r);
  expect(r.headers['retry-after']).toBe(retryAfter);
}

describe('bridge listener', () => {
  it('uses the constraint values', () => {
    expect(BRIDGE_LISTENER_LIMITS).toEqual({
      maxCallBodyBytes: 1_048_576,
      maxClaimBodyBytes: 16_384,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 90_000,
      keepAliveTimeoutMs: 5_000,
    });
  });

  it('no Authorization is 401 unauthenticated and the body is never read', async () => {
    const t = await start();
    const port = t.listener.port();
    // A declared 1 MiB body that is never sent: the answer can't have waited for it.
    const r = await send(port, {
      method: 'POST',
      path: CALL,
      headers: { ...JSON_CT, 'content-length': String(BRIDGE_LISTENER_LIMITS.maxCallBodyBytes) },
      body: '{"appId":',
      noEnd: true,
    }).reply;
    expectRefusal(r, 401, 'unauthenticated');
    expect(r.headers['connection']).toBe('close');
    expect(t.verifyCaller).not.toHaveBeenCalled();
    expect(t.call).not.toHaveBeenCalled();
    expect(t.routeLines()).toEqual([{ level: 'info', msg: 'apps_bridge_call', bindings: { outcome: 'unauthenticated', reason: 'missing' } }]);

    const g = await fetchIt(port, { path: grantsPath('app_1') });
    expectRefusal(g, 401, 'unauthenticated');
    expect(t.grants).not.toHaveBeenCalled();
  });

  it('an overlong or non-Bearer token is 401 without verifying', async () => {
    const t = await start();
    const port = t.listener.port();
    const long = 'a'.repeat(8193);
    for (const authorization of [`Bearer ${long}`, 'Basic x', 'Bearer', 'Bearer ', `Token ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
      const r = await fetchIt(port, { path: grantsPath('app_1'), headers: { authorization } });
      expectRefusal(r, 401, 'unauthenticated');
    }
    expect(t.verifyCaller).not.toHaveBeenCalled();
    expect(t.grants).not.toHaveBeenCalled();

    // The scheme is case-insensitive; 8192 characters is still a token.
    const max = 'b'.repeat(8192);
    await fetchIt(port, { path: grantsPath('app_1'), headers: { authorization: `bearer ${max}` } });
    await fetchIt(port, { path: grantsPath('app_1'), headers: { authorization: `BEARER ${TOKEN}` } });
    expect(t.verifyCaller.mock.calls.map((c) => c[0])).toEqual([max, TOKEN]);
    expect(t.grants).toHaveBeenCalledTimes(1);

    // A token the verifier refuses is 401 too, with the verifier's reason on the line.
    const bad = await fetchIt(port, { path: grantsPath('app_1'), headers: { authorization: 'Bearer forged' } });
    expectRefusal(bad, 401, 'unauthenticated');
    expect(t.routeLines().at(-1)).toEqual({ level: 'info', msg: 'apps_bridge_grants', bindings: { outcome: 'unauthenticated', reason: 'bad-signature' } });
  });

  it('keys-unavailable is 503 unavailable with Retry-After 5', async () => {
    const t = await start();
    const r = await fetchIt(t.listener.port(), { path: grantsPath('app_1'), headers: { authorization: `Bearer ${KEYS_DOWN}` } });
    expectRefusal(r, 503, 'unavailable', '5');
    expect(t.grants).not.toHaveBeenCalled();
    expect(t.routeLines()).toEqual([{ level: 'info', msg: 'apps_bridge_grants', bindings: { outcome: 'unavailable', reason: 'keys-unavailable' } }]);

    // A verifier that throws fails closed the same way.
    const u = await start({ verifyCaller: async () => { throw new Error('SECRET boom'); } });
    expectRefusal(await fetchIt(u.listener.port(), { path: grantsPath('app_1'), headers: AUTH }), 503, 'unavailable', '5');
    expect(JSON.stringify(u.lines)).not.toContain('SECRET');
  });

  it('a platform over its window is 429 with Retry-After 60', async () => {
    const t = await start({ limits: { perPlatformPerMinute: 2 } });
    const port = t.listener.port();
    expect((await fetchIt(port, { path: grantsPath('app_1'), headers: AUTH })).status).toBe(200);
    expect((await post(port, CLAIM, { any: 1 })).status).toBe(200);
    const r = await post(port, CALL, { any: 1 });
    expectRefusal(r, 429, 'rate_limited', '60');
    expect(t.call).not.toHaveBeenCalled();
    expect(t.routeLines().at(-1)).toEqual({ level: 'info', msg: 'apps_bridge_call', bindings: { platformId: P, outcome: 'rate_limited', reason: 'platform' } });
    // Every route spends from the same window; unauthenticated requests spend nothing.
    expectRefusal(await fetchIt(port, { path: grantsPath('app_1'), headers: AUTH }), 429, 'rate_limited', '60');
  });

  it('an unauthenticated flood spends nothing from the platform window', async () => {
    const t = await start({ limits: { perPlatformPerMinute: 1 } });
    const port = t.listener.port();
    for (let i = 0; i < 3; i++) expect((await fetchIt(port, { path: grantsPath('app_1') })).status).toBe(401);
    expect((await fetchIt(port, { path: grantsPath('app_1'), headers: AUTH })).status).toBe(200);
  });

  it('the in-flight cap is 429 with Retry-After 1, and a hung-up client still frees its slot', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    let n = 0;
    const t = await start({
      limits: { maxInFlightPerPlatform: 1 },
      call: async (body) => {
        n++;
        if (n === 1) {
          entered.resolve();
          await gate.promise;
        }
        const appId = (body as { appId: string }).appId;
        return ok({ outcome: 'succeeded', content: [] }, { appId, outcome: 'succeeded' });
      },
    });
    const port = t.listener.port();
    const bodyA = JSON.stringify({ appId: 'app_A' });
    const a = send(port, { method: 'POST', path: CALL, headers: { ...AUTH, ...JSON_CT, 'content-length': String(bodyA.length) }, body: bodyA });
    a.reply.catch(() => {});
    await entered.promise;

    // A is in flight: B is refused at the cap.
    const b = await post(port, CALL, { appId: 'app_B' });
    expectRefusal(b, 429, 'rate_limited', '1');

    // A hangs up mid-call; its call() is still running, so its slot is still held.
    a.req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expectRefusal(await post(port, CALL, { appId: 'app_B2' }), 429, 'rate_limited', '1');

    // A's call() ends: its slot frees and A logs exactly one line.
    gate.resolve();
    await vi.waitFor(() => expect(t.routeLines().filter((l) => l.bindings?.['appId'] === 'app_A')).toHaveLength(1));
    const c = await post(port, CALL, { appId: 'app_C' });
    expect(c.status).toBe(200);
    expect(t.call).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.routeLines().filter((l) => l.bindings?.['appId'] === 'app_A')).toEqual([
      { level: 'info', msg: 'apps_bridge_call', bindings: { platformId: P, appId: 'app_A', outcome: 'succeeded' } },
    ]);
    // B and B2 were the only refusals, each logged once with the cap's reason.
    expect(t.routeLines().filter((l) => l.bindings?.['outcome'] === 'rate_limited').map((l) => l.bindings)).toEqual([
      { platformId: P, outcome: 'rate_limited', reason: 'in-flight' },
      { platformId: P, outcome: 'rate_limited', reason: 'in-flight' },
    ]);
  });

  it('a client that hangs up while its body is still arriving frees its slot and logs one line', async () => {
    const t = await start({ limits: { maxInFlightPerPlatform: 1 } });
    const port = t.listener.port();
    const a = send(port, {
      method: 'POST',
      path: CALL,
      headers: { ...AUTH, ...JSON_CT, 'content-length': '1000' },
      body: '{"appId":"app_A"',
      noEnd: true,
    });
    a.reply.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    a.req.destroy();
    await vi.waitFor(() => expect(t.routeLines()).toHaveLength(1));
    expect(t.routeLines()[0]).toEqual({ level: 'info', msg: 'apps_bridge_call', bindings: { platformId: P, outcome: 'invalid_request', reason: 'aborted' } });
    expect(t.call).not.toHaveBeenCalled();
    expect((await post(port, CALL, { appId: 'app_B' })).status).toBe(200);
  });

  it('wrong content type, bad JSON, and a /call body over 1 MiB are 400 invalid_request, and call() never runs', async () => {
    const t = await start();
    const port = t.listener.port();
    const body = '{"appId":"app_1"}';
    const len = String(body.length);
    for (const ct of ['text/plain', 'application/jsonx', 'application/x-www-form-urlencoded', '']) {
      const headers: Record<string, string> = { ...AUTH, 'content-length': len };
      if (ct !== '') headers['content-type'] = ct;
      expectRefusal(await fetchIt(port, { method: 'POST', path: CALL, headers, body }), 400, 'invalid_request');
    }
    for (const bad of ['{"appId":', '', 'nul', '\uFEFF\uFEFF{}']) {
      expectRefusal(
        await fetchIt(port, { method: 'POST', path: CALL, headers: { ...AUTH, ...JSON_CT, 'content-length': String(Buffer.byteLength(bad)) }, body: bad }),
        400,
        'invalid_request',
      );
    }
    // Bytes that aren't UTF-8 are refused, not patched with U+FFFD.
    const notUtf8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    expectRefusal(
      await fetchIt(port, { method: 'POST', path: CALL, headers: { ...AUTH, ...JSON_CT, 'content-length': String(notUtf8.length) }, body: notUtf8 }),
      400,
      'invalid_request',
    );

    // Declared over the cap: refused from the header, before a byte is read.
    const declared = await send(port, {
      method: 'POST',
      path: CALL,
      headers: { ...AUTH, ...JSON_CT, 'content-length': String(BRIDGE_LISTENER_LIMITS.maxCallBodyBytes + 1) },
      body: '{',
      noEnd: true,
    }).reply;
    expectRefusal(declared, 400, 'invalid_request');
    expect(declared.headers['connection']).toBe('close');

    // Chunked, no length: the answer comes once the count passes the cap,
    // while the request is still open (it was never buffered whole).
    const chunked = send(port, { method: 'POST', path: CALL, headers: { ...AUTH, ...JSON_CT }, body: Buffer.alloc(BRIDGE_LISTENER_LIMITS.maxCallBodyBytes + 1, 0x20), noEnd: true });
    expectRefusal(await chunked.reply, 400, 'invalid_request');
    chunked.req.destroy();

    expect(t.call).not.toHaveBeenCalled();
    expect(t.routeLines().every((l) => l.bindings?.['outcome'] === 'invalid_request' && l.bindings['platformId'] === P)).toBe(true);
    expect(new Set(t.routeLines().map((l) => l.bindings?.['reason']))).toEqual(new Set(['content-type', 'bad-json', 'too-large']));

    // Exactly the cap is read and parsed. Content type parameters are allowed.
    const exact = Buffer.alloc(BRIDGE_LISTENER_LIMITS.maxCallBodyBytes, 0x20);
    exact.write('{"appId":"app_1"}', 0);
    const r = await fetchIt(port, {
      method: 'POST',
      path: CALL,
      headers: { ...AUTH, 'content-type': 'Application/JSON; charset=utf-8', 'content-length': String(exact.length) },
      body: exact,
    });
    expect(r.status).toBe(200);
    expect(t.call).toHaveBeenCalledWith({ appId: 'app_1' });
  });

  it('the claim route caps its body at 16 KiB, takes no in-flight slot, and never logs the code', async () => {
    const code = 'axl_abcdefghijklmnopqrstuvwxyz234567';
    const t = await start({ limits: { maxInFlightPerPlatform: 0 } });
    const port = t.listener.port();

    // The call route is at its cap (0); the claim still runs.
    expectRefusal(await post(port, CALL, { appId: 'app_1' }), 429, 'rate_limited', '1');
    const r = await post(port, CLAIM, { appId: 'app_1', appName: 'Desk', code });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ appId: 'app_1' });
    expectJsonHeaders(r);
    expect(t.claim).toHaveBeenCalledWith({ appId: 'app_1', appName: 'Desk', code });

    const over = await send(port, {
      method: 'POST',
      path: CLAIM,
      headers: { ...AUTH, ...JSON_CT, 'content-length': String(BRIDGE_LISTENER_LIMITS.maxClaimBodyBytes + 1) },
      noEnd: true,
    }).reply;
    expectRefusal(over, 400, 'invalid_request');
    const chunked = send(port, { method: 'POST', path: CLAIM, headers: { ...AUTH, ...JSON_CT }, body: Buffer.alloc(BRIDGE_LISTENER_LIMITS.maxClaimBodyBytes + 1, 0x20), noEnd: true });
    expectRefusal(await chunked.reply, 400, 'invalid_request');
    chunked.req.destroy();
    expect(t.claim).toHaveBeenCalledTimes(1);

    const claimLines = t.routeLines().filter((l) => l.msg === 'apps_bridge_link_claim');
    expect(claimLines.map((l) => l.bindings)).toEqual([
      { platformId: P, appId: 'app_1', outcome: 'linked' },
      { platformId: P, outcome: 'invalid_request', reason: 'too-large' },
      { platformId: P, outcome: 'invalid_request', reason: 'too-large' },
    ]);
    expect(JSON.stringify(t.lines)).not.toContain(code);
    expect(JSON.stringify(t.lines)).not.toContain('Desk');
  });

  it('GET grants passes the app id segment through', async () => {
    const t = await start();
    const port = t.listener.port();
    for (const raw of ['app_01JDZ8M5Q4X7RT3VKF0N2C9H6B', 'bad%2Fapp', '%00', 'a.b']) {
      const r = await fetchIt(port, { path: grantsPath(raw), headers: AUTH });
      expect(r.status).toBe(200);
    }
    // A query string is not part of the segment.
    await fetchIt(port, { path: `${grantsPath('app_q')}?x=1`, headers: AUTH });
    expect(t.grants.mock.calls.map((c) => c[0])).toEqual(['app_01JDZ8M5Q4X7RT3VKF0N2C9H6B', 'bad%2Fapp', '%00', 'a.b', 'app_q']);
  });

  it('unknown path 404; OPTIONS and wrong method 405 with Allow and no access-control-* headers', async () => {
    const t = await start();
    const port = t.listener.port();
    const origin = { origin: 'https://evil.test', 'access-control-request-method': 'POST' };
    for (const path of ['/', `${BASE}`, `${BASE}/`, `${CALL}/`, `${BASE}/apps//grants`, `${BASE}/apps/a/b/grants`, `/api/apps-bridge/v2/call`, `/x${CALL}`, '/healthz']) {
      const r = await fetchIt(port, { path, headers: { ...AUTH, ...origin } });
      expect(r.status, path).toBe(404);
      expect(r.text).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
    const cases: Array<[string, string, string]> = [
      ['GET', CALL, 'POST'],
      ['OPTIONS', CALL, 'POST'],
      ['PUT', CLAIM, 'POST'],
      ['OPTIONS', CLAIM, 'POST'],
      ['HEAD', CLAIM, 'POST'],
      ['POST', grantsPath('app_1'), 'GET'],
      ['HEAD', grantsPath('app_1'), 'GET'],
      ['OPTIONS', grantsPath('app_1'), 'GET'],
      ['DELETE', grantsPath('app_1'), 'GET'],
    ];
    for (const [method, path, allow] of cases) {
      const r = await fetchIt(port, { method, path, headers: { ...AUTH, ...origin } });
      expect(r.status, `${method} ${path}`).toBe(405);
      expect(r.headers['allow']).toBe(allow);
      expect(r.text).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
    // Neither is authenticated, routed or logged.
    expect(t.verifyCaller).not.toHaveBeenCalled();
    expect(t.lines).toEqual([]);
  });

  it('every answer is JSON, no-store and nosniff', async () => {
    const t = await start({
      call: async () => ({ status: 403, body: { code: 'not_granted' }, log: { outcome: 'not_granted' } }),
      grants: async () => ({ status: 503, body: { code: 'unavailable' }, retryAfterSeconds: 5, log: { outcome: 'unavailable' } }),
    });
    const port = t.listener.port();
    const g = await fetchIt(port, { path: grantsPath('app_1'), headers: AUTH });
    expectRefusal(g, 503, 'unavailable', '5');
    const c = await post(port, CALL, { appId: 'app_1' });
    expectRefusal(c, 403, 'not_granted');
    const ok200 = await post(port, CLAIM, {});
    expect(ok200.status).toBe(200);
    expectJsonHeaders(ok200);
    expectRefusal(await fetchIt(port, { path: grantsPath('app_1') }), 401, 'unauthenticated');

    // An answer function that throws is still a JSON 503, never a crash or a leak.
    const boom = await start({ grants: async () => { throw new Error('SECRET internal'); } });
    const b = await fetchIt(boom.listener.port(), { path: grantsPath('app_1'), headers: AUTH });
    expectRefusal(b, 503, 'unavailable', '5');
    expect(boom.routeLines()).toEqual([{ level: 'info', msg: 'apps_bridge_grants', bindings: { platformId: P, outcome: 'unavailable', reason: 'internal' } }]);
    expect(JSON.stringify(boom.lines)).not.toContain('SECRET');
  });

  it('one log line per request; the token never appears in it', async () => {
    const t = await start();
    const port = t.listener.port();
    await fetchIt(port, { path: grantsPath('app_1'), headers: AUTH });
    await post(port, CALL, { appId: 'app_1', input: { secret: 'SECRET-INPUT' } });
    await post(port, CLAIM, { appId: 'app_1' });
    await fetchIt(port, { path: grantsPath('app_1'), headers: { authorization: 'Bearer SECRET-FORGED.x.y' } });
    await fetchIt(port, { method: 'POST', path: CALL, headers: { ...AUTH, 'content-type': 'text/plain', 'content-length': '2' }, body: 'hi' });
    expect(t.lines.map((l) => [l.level, l.msg])).toEqual([
      ['info', 'apps_bridge_grants'],
      ['info', 'apps_bridge_call'],
      ['info', 'apps_bridge_link_claim'],
      ['info', 'apps_bridge_grants'],
      ['info', 'apps_bridge_call'],
    ]);
    const all = JSON.stringify(t.lines);
    for (const secret of [TOKEN, 'SECRET', 'Bearer', 'authorization', BASE, 'text/plain']) expect(all).not.toContain(secret);
  });

  it('an Expect: 100-continue client is answered from its headers before it is told to send the body', async () => {
    const t = await start();
    const port = t.listener.port();
    const unauth = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: CALL, agent: false, headers: { ...JSON_CT, 'content-length': '2', expect: '100-continue' } });
      req.on('continue', () => reject(new Error('told an unauthenticated client to send its body')));
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(unauth).toBe(401);

    const authed = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: CALL, agent: false, headers: { ...AUTH, ...JSON_CT, 'content-length': '2', expect: '100-continue' } });
      req.on('continue', () => req.end('{}'));
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(authed).toBe(200);
    expect(t.call).toHaveBeenCalledWith({});
  });

  it('a client that hangs up while it is still being authenticated frees its slot and logs one line (fix round 1)', async () => {
    // The request's 'close' fires while verifyCaller is pending, before the
    // body read starts listening: the read must still settle.
    for (const route of [CALL, CLAIM]) {
      for (const fullBody of [false, true]) {
        const gate = deferred<void>();
        const entered = deferred<void>();
        let first = true;
        const t = await start({
          limits: { maxInFlightPerPlatform: 1 },
          verifyCaller: async () => {
            if (first) {
              first = false;
              entered.resolve();
              await gate.promise;
            }
            return { ok: true };
          },
        });
        const port = t.listener.port();
        const body = '{"appId":"app_A"}';
        const a = send(port, {
          method: 'POST',
          path: route,
          headers: { ...AUTH, ...JSON_CT, 'content-length': String(fullBody ? body.length : 100) },
          body: fullBody ? body : '{"appId"',
          noEnd: !fullBody,
        });
        a.reply.catch(() => {});
        await entered.promise;
        a.req.destroy();
        await new Promise((r) => setTimeout(r, 50));
        gate.resolve();
        const label = `${route} fullBody=${fullBody}`;
        await vi.waitFor(() => expect(t.routeLines(), label).toHaveLength(1));
        expect(t.routeLines()[0]?.bindings, label).toEqual({ platformId: P, outcome: 'invalid_request', reason: 'aborted' });
        expect(t.call, label).not.toHaveBeenCalled();
        expect(t.claim, label).not.toHaveBeenCalled();
        // The slot came back: the next call runs.
        expect((await post(port, CALL, { appId: 'app_B' })).status, label).toBe(200);
        // And close() has nothing left to wait for.
        const started = Date.now();
        await t.listener.close();
        expect(Date.now() - started, label).toBeLessThan(1_000);
      }
    }
  });

  it('an Expect other than 100-continue gets a fixed 417 with the base headers, before any routing, and is not logged', async () => {
    const t = await start();
    const r = await fetchIt(t.listener.port(), { method: 'POST', path: CALL, headers: { ...AUTH, ...JSON_CT, expect: 'something-else', 'content-length': '2' }, body: '{}' });
    expect(r.status).toBe(417);
    expect(r.text).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['connection']).toBe('close');
    expect(t.verifyCaller).not.toHaveBeenCalled();
    expect(t.call).not.toHaveBeenCalled();
    expect(t.lines).toEqual([]);
  });

  it('Expect: 100-continue among other expectations is still honoured after authentication', async () => {
    const t = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: t.listener.port(),
        method: 'POST',
        path: CALL,
        agent: false,
        headers: { ...AUTH, ...JSON_CT, 'content-length': '2', expect: '100-Continue, foo' },
      });
      req.on('continue', () => req.end('{}'));
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(200);
    expect(t.call).toHaveBeenCalledWith({});
  });

  it('a request on a connection opened before stopAccepting() is 503 unavailable (shutting-down)', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const t = await start({
      call: async () => {
        entered.resolve();
        await gate.promise;
        return ok({ outcome: 'succeeded', content: [] }, { outcome: 'succeeded' });
      },
    });
    const { connect } = await import('node:net');
    const sock = connect(t.listener.port(), '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    let out = '';
    sock.on('data', (d: Buffer) => (out += d.toString('utf8')));
    // A call holds the kept-alive connection busy, so the stop doesn't close
    // it as idle; a second request then arrives on it, pipelined, after the stop.
    const callBody = '{"appId":"app_1"}';
    sock.write(
      `POST ${CALL} HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\ncontent-length: ${callBody.length}\r\n\r\n${callBody}`,
    );
    await entered.promise;
    await t.listener.stopAccepting();
    sock.write(`GET ${grantsPath('app_1')} HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${TOKEN}\r\n\r\n`);
    await vi.waitFor(() => expect(t.routeLines()).toHaveLength(1));
    expect(t.routeLines()[0]).toEqual({ level: 'info', msg: 'apps_bridge_grants', bindings: { outcome: 'unavailable', reason: 'shutting-down' } });
    expect(t.verifyCaller).toHaveBeenCalledTimes(1);
    expect(t.grants).not.toHaveBeenCalled();
    gate.resolve();
    // Both answers arrive, in order, and the connection is then closed.
    await new Promise<void>((r) => sock.once('close', () => r()));
    const responses = out.split('HTTP/1.1 ').slice(1);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.startsWith('200 ')).toBe(true);
    expect(responses[1]?.startsWith('503 ')).toBe(true);
    expect(responses[1]).toContain('retry-after: 5');
    expect(responses[1]).toContain('connection: close');
    expect(responses[1]).toContain('{"code":"unavailable"}');
  });

  it('close() lets an in-flight call answer, then closes; stopAccepting() refuses new connections', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const t = await start({
      call: async () => {
        entered.resolve();
        await gate.promise;
        return ok({ outcome: 'succeeded', content: [] }, { outcome: 'succeeded' });
      },
    });
    const port = t.listener.port();
    const inFlight = post(port, CALL, { appId: 'app_1' });
    await entered.promise;
    await t.listener.stopAccepting();
    await expect(fetchIt(port, { path: grantsPath('app_1'), headers: AUTH })).rejects.toThrow(/ECONNREFUSED/);
    const closing = t.listener.close();
    gate.resolve();
    expect((await inFlight).status).toBe(200);
    await closing;
    // Idempotent.
    await t.listener.close();
    await t.listener.stopAccepting();
  });

  it('close() waits only up to its drain timeout, then cuts the connections', async () => {
    const t = await start({ drainTimeoutMs: 100, call: () => new Promise<BridgeAnswer>(() => {}) });
    const port = t.listener.port();
    const hung = post(port, CALL, { appId: 'app_1' });
    await vi.waitFor(() => expect(t.call).toHaveBeenCalled());
    const started = Date.now();
    await t.listener.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(hung).rejects.toThrow();
  });

  it('a request Node cannot parse gets a fixed 400 and nothing is logged', async () => {
    const t = await start();
    const { connect } = await import('node:net');
    const text = await new Promise<string>((resolve, reject) => {
      const sock = connect(t.listener.port(), '127.0.0.1', () => sock.write('GARBAGE \u0001 SECRET-RAW\r\n\r\n'));
      let out = '';
      sock.on('data', (d) => (out += d.toString('utf8')));
      sock.on('end', () => resolve(out));
      sock.on('close', () => resolve(out));
      sock.on('error', reject);
    });
    expect(text.startsWith('HTTP/1.1 400 ')).toBe(true);
    expect(text).toContain('x-content-type-options: nosniff');
    expect(text).toContain('cache-control: no-store');
    expect(text).not.toContain('SECRET');
    expect(t.lines).toEqual([]);
  });
});

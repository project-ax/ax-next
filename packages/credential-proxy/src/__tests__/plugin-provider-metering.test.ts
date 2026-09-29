/**
 * TASK-715 at the plugin seam: `proxy:open-session` with a `metered` credential
 * turns the operator's model key into a metered, gated one, through the REAL
 * credential-proxy plugin and a stand-in for the usage ledger (the two service
 * hooks @ax/usage-limits registers). The listener-level behaviour is covered in
 * listener-provider-metering.test.ts; this file is about what the PLUGIN wires.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as net from 'node:net';
import { connect as tlsConnect, createServer as tlsCreate, type TLSSocket } from 'node:tls';
import { ProxyAgent } from 'undici';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type KernelHandle,
  type Plugin,
} from '@ax/core';
import { generateDomainCert, getOrCreateCA, type CAKeyPair } from '../ca.js';
import { createCredentialProxyPlugin } from '../plugin.js';
import { basicAuth, rawConnect } from './proxy-auth-helpers.js';

const REAL = 'sk-ant-REAL-operator-key';
const HOST = '127.0.0.1';
const INFERENCE = ['POST /v1/messages', 'POST /v1/messages/count_tokens'];

function ctxFor(userId: string) {
  return makeAgentContext({ sessionId: 'sess', agentId: 'a1', userId });
}

// ── stand-ins ────────────────────────────────────────────────────────

function memCredentialsPlugin(onGet?: (ref: string) => void): Plugin {
  const store = new Map<string, string>();
  return {
    manifest: {
      name: '@test/mem-credentials',
      version: '0.0.0',
      registers: ['credentials:get', 'credentials:set'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<{ ref: string; userId: string; value: string }, void>(
        'credentials:set',
        '@test/mem-credentials',
        async (_ctx, { ref, userId, value }) => {
          store.set(`${userId}:${ref}`, value);
        },
      );
      bus.registerService<{ ref: string; userId: string }, string>(
        'credentials:get',
        '@test/mem-credentials',
        async (_ctx, { ref, userId }) => {
          onGet?.(ref);
          const v = store.get(`${userId}:${ref}`);
          if (v === undefined) throw new Error(`no such credential ${userId}:${ref}`);
          return v;
        },
      );
    },
  };
}

interface LedgerCall {
  hook: 'status' | 'record';
  userId: string;
  payload?: unknown;
}

/** What @ax/usage-limits registers, scripted. Per-user verdicts. */
function usageLedgerPlugin() {
  const calls: LedgerCall[] = [];
  const blocked = new Map<string, string>(); // userId -> reason
  const verdictFor = (userId: string) => {
    const reason = blocked.get(userId);
    return reason === undefined ? { blocked: false } : { blocked: true, reason };
  };
  const plugin: Plugin = {
    manifest: {
      name: '@test/usage-ledger',
      version: '0.0.0',
      registers: ['usage:provider-status', 'usage:provider-record'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<Record<string, never>, unknown>(
        'usage:provider-status',
        '@test/usage-ledger',
        async (ctx) => {
          calls.push({ hook: 'status', userId: ctx.userId });
          return verdictFor(ctx.userId);
        },
      );
      bus.registerService<unknown, unknown>(
        'usage:provider-record',
        '@test/usage-ledger',
        async (ctx, payload) => {
          calls.push({ hook: 'record', userId: ctx.userId, payload });
          return verdictFor(ctx.userId);
        },
      );
    },
  };
  return {
    plugin,
    calls,
    of: (hook: 'status' | 'record') => calls.filter((c) => c.hook === hook),
    block: (userId: string, reason = 'usage-limit-daily') => blocked.set(userId, reason),
    unblock: (userId: string) => blocked.delete(userId),
  };
}

const MESSAGE_JSON = JSON.stringify({
  id: 'msg_1',
  model: 'claude-sonnet-4-5',
  content: [],
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
});

interface Upstream {
  port: number;
  requests: Array<{ line: string; headers: Record<string, string> }>;
  close: () => Promise<void>;
}

/** A keep-alive TLS upstream on 127.0.0.1 signed by the proxy's own CA; answers every request 200 + MESSAGE_JSON. */
async function startUpstream(ca: CAKeyPair): Promise<Upstream> {
  const leaf = generateDomainCert(HOST, ca);
  const requests: Upstream['requests'] = [];
  const sockets = new Set<net.Socket>();
  const server = tlsCreate({ key: leaf.key, cert: leaf.cert }, (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const lines = buf.slice(0, end).split('\r\n');
        const headers: Record<string, string> = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf(':');
          if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        }
        const len = parseInt(headers['content-length'] ?? '0', 10);
        if (buf.length - (end + 4) < len) return;
        buf = buf.slice(end + 4 + len);
        requests.push({ line: lines[0] ?? '', headers });
        sock.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${MESSAGE_JSON.length}\r\n\r\n${MESSAGE_JSON}`,
        );
      }
    });
    sock.on('error', () => undefined);
  });
  const port = await new Promise<number>((r) =>
    server.listen(0, HOST, () => r((server.address() as net.AddressInfo).port)),
  );
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Opened {
  envMap: Record<string, string>;
  proxyAuthToken: string;
  proxyEndpoint: string;
}

describe('@ax/credential-proxy plugin — the metered provider key (TASK-715)', () => {
  let caDir: string;
  let bus: HookBus;
  let kernel: KernelHandle | undefined;
  let ca: CAKeyPair;
  let upstream: Upstream;

  beforeEach(() => {
    caDir = mkdtempSync(join(tmpdir(), 'proxy-metering-'));
    bus = new HookBus();
    kernel = undefined;
  });

  afterEach(async () => {
    if (kernel) await kernel.shutdown();
    if (upstream) await upstream.close();
    rmSync(caDir, { recursive: true, force: true });
  });

  async function boot(extra: Plugin[], onGet?: (ref: string) => void): Promise<void> {
    ca = await getOrCreateCA(caDir);
    upstream = await startUpstream(ca);
    kernel = await bootstrap({
      bus,
      plugins: [
        memCredentialsPlugin(onGet),
        ...extra,
        createCredentialProxyPlugin({ listen: { kind: 'tcp', host: HOST, port: 0 }, caDir }),
      ],
      config: {},
    });
    for (const userId of ['alice', 'bob']) {
      await bus.call('credentials:set', ctxFor(userId), {
        ref: 'provider:anthropic',
        userId,
        value: REAL,
      });
    }
  }

  async function open(
    sessionId: string,
    userId: string,
    credential: Record<string, unknown> = {
      ref: 'provider:anthropic',
      kind: 'api-key',
      allowedHosts: [HOST],
      metered: { requests: INFERENCE },
    },
  ): Promise<Opened> {
    return bus.call<unknown, Opened>('proxy:open-session', ctxFor(userId), {
      sessionId,
      userId,
      agentId: 'a1',
      allowlist: [HOST],
      allowedIPs: [HOST],
      credentials: { ANTHROPIC_API_KEY: credential },
    });
  }

  function agent(o: Opened): ProxyAgent {
    return new ProxyAgent({
      uri: `http://${HOST}:${new URL(o.proxyEndpoint.replace('tcp://', 'http://')).port}`,
      token: basicAuth(o.proxyAuthToken),
      requestTls: { ca: ca.cert },
    });
  }

  async function post(o: Opened, path = '/v1/messages'): Promise<{ status: number; text: string }> {
    const d = agent(o);
    try {
      const res = await fetch(`https://${HOST}:${upstream.port}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': o.envMap.ANTHROPIC_API_KEY!, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [] }),
        dispatcher: d,
      } as RequestInit);
      return { status: res.status, text: await res.text() };
    } finally {
      await d.close();
    }
  }

  it('a runner-style call and a sandbox-style call are both counted, with the parsed usage, for the session owner', async () => {
    const ledger = usageLedgerPlugin();
    await boot([ledger.plugin]);
    const o = await open('s1', 'alice');

    // Seeded at open, before any call.
    expect(ledger.of('status')).toEqual([{ hook: 'status', userId: 'alice' }]);

    expect((await post(o)).status).toBe(200);
    expect((await post(o)).status).toBe(200); // "curl" from the same env: identical at the proxy

    await waitFor(() => ledger.of('record').length === 2, 'both calls to be recorded');
    expect(ledger.of('record')[0]).toEqual({
      hook: 'record',
      userId: 'alice',
      payload: {
        model: 'claude-sonnet-4-5',
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 7, cacheWriteTokens: 3 },
        requestBytes: expect.any(Number),
      },
    });
    expect(upstream.requests.every((r) => r.headers['x-api-key'] === REAL)).toBe(true);
  });

  it('once the ledger says blocked, that user is refused on every session; another user is not', async () => {
    const ledger = usageLedgerPlugin();
    await boot([ledger.plugin]);
    const a1 = await open('s1', 'alice');
    const a2 = await open('s2', 'alice');
    const b1 = await open('s3', 'bob');

    ledger.block('alice');
    expect((await post(a1)).status).toBe(200); // the call that gets counted returns the verdict
    await waitFor(() => ledger.of('record').length === 1, 'the record');

    const refused = await post(a1);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.text)).toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error' },
    });
    expect((await post(a2)).status).toBe(429); // a DIFFERENT session of the same user
    expect((await post(b1)).status).toBe(200); // another user is untouched
    // Nothing further reached the provider for alice.
    const sent = upstream.requests.length;
    await post(a1);
    expect(upstream.requests.length).toBe(sent);
  });

  it('a credential that is not marked metered is untouched: no ledger calls, no endpoint restriction', async () => {
    const ledger = usageLedgerPlugin();
    await boot([ledger.plugin]);
    const o = await open('s1', 'alice', {
      ref: 'provider:anthropic',
      kind: 'api-key',
      allowedHosts: [HOST],
    });
    expect(ledger.calls).toHaveLength(0);
    expect((await post(o, '/v1/files')).status).toBe(200);
    expect(upstream.requests[0]!.headers['x-api-key']).toBe(REAL);
    await new Promise((r) => setTimeout(r, 100));
    expect(ledger.calls).toHaveLength(0);
  });

  it('with no usage ledger loaded, the endpoint allowlist still holds (the key goes only to model calls)', async () => {
    await boot([]);
    const o = await open('s1', 'alice');
    expect((await post(o, '/v1/messages')).status).toBe(200);
    expect((await post(o, '/v1/messages/batches')).status).toBe(200);
    expect(upstream.requests[0]!.headers['x-api-key']).toBe(REAL);
    expect(upstream.requests[1]!.headers['x-api-key']).toBe(o.envMap.ANTHROPIC_API_KEY); // inert
  });

  it.each([
    ['metered is not an object', 'yes'],
    ['requests is missing', {}],
    ['requests is not an array', { requests: 'POST /v1/messages' }],
    ['an entry has no method', { requests: ['/v1/messages'] }],
    ['an entry is not GET or POST', { requests: ['DELETE /v1/files'] }],
    ['a wildcard in the middle', { requests: ['GET /v1/*/models'] }],
    ['an entry with a query', { requests: ['POST /v1/messages?x=1'] }],
    ['a non-string entry', { requests: [42] }],
  ])('a malformed metered marker (%s) fails before any secret is read', async (_name, metered) => {
    const gets: string[] = [];
    await boot([usageLedgerPlugin().plugin], (ref) => gets.push(ref));
    let caught: unknown;
    try {
      await open('s1', 'alice', {
        ref: 'provider:anthropic',
        kind: 'api-key',
        allowedHosts: [HOST],
        metered,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-credential-metering');
    expect(gets).toEqual([]);
  });

  it('an empty request list means the key is never spliced', async () => {
    await boot([usageLedgerPlugin().plugin]);
    const o = await open('s1', 'alice', {
      ref: 'provider:anthropic',
      kind: 'api-key',
      allowedHosts: [HOST],
      metered: { requests: [] },
    });
    await post(o);
    expect(upstream.requests[0]!.headers['x-api-key']).toBe(o.envMap.ANTHROPIC_API_KEY);
  });

  it('a ledger that answers with something that is not a verdict blocks (fail closed)', async () => {
    const weird: Plugin = {
      manifest: {
        name: '@test/weird-ledger',
        version: '0.0.0',
        registers: ['usage:provider-status', 'usage:provider-record'],
        calls: [],
        subscribes: [],
      },
      init({ bus: b }) {
        b.registerService('usage:provider-status', '@test/weird-ledger', async () => ({ ok: true }));
        b.registerService('usage:provider-record', '@test/weird-ledger', async () => 'fine');
      },
    };
    await boot([weird]);
    const o = await open('s1', 'alice');
    expect((await post(o)).status).toBe(429);
    expect(upstream.requests).toHaveLength(0);
  });

  it('proxy:close-session ends the meter: a tunnel that outlives its session is refused, not served', async () => {
    const ledger = usageLedgerPlugin();
    await boot([ledger.plugin]);
    const o = await open('s1', 'alice');

    // One keep-alive tunnel, opened while the session lives.
    const raw = net.connect(Number(new URL(o.proxyEndpoint.replace('tcp://', 'http://')).port), HOST);
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write(rawConnect(`${HOST}:${upstream.port}`, o.proxyAuthToken));
    await new Promise<void>((resolve, reject) => {
      let acc = '';
      raw.on('data', function onData(d: Buffer) {
        acc += d.toString('latin1');
        if (!acc.includes('\r\n\r\n')) return;
        raw.removeListener('data', onData);
        acc.startsWith('HTTP/1.1 200') ? resolve() : reject(new Error(acc));
      });
    });
    const inner: TLSSocket = tlsConnect({ socket: raw, servername: HOST, ca: ca.cert });
    inner.on('error', () => undefined);
    await new Promise<void>((r) => inner.once('secureConnect', () => r()));
    let got = '';
    inner.on('data', (d: Buffer) => {
      got += d.toString('latin1');
    });
    const req = `POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nx-api-key: ${o.envMap.ANTHROPIC_API_KEY}\r\nContent-Length: 2\r\n\r\n{}`;
    inner.write(req);
    await waitFor(() => got.includes('200 OK'), 'the first response');

    await bus.call('proxy:close-session', ctxFor('alice'), { sessionId: 's1' });
    inner.write(req);
    await waitFor(() => got.includes('429'), 'the refusal after close');
    expect(upstream.requests).toHaveLength(1);
    inner.destroy();
    raw.destroy();
  });
});

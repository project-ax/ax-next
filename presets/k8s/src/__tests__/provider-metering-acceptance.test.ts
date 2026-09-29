import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { connect as tlsConnect, createServer as tlsCreate, type TLSSocket } from 'node:tls';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import forge from 'node-forge';
import { sql, type Kysely } from 'kysely';

import { HookBus, PluginError, bootstrap, makeAgentContext, type Plugin } from '@ax/core';
import { createCredentialProxyPlugin } from '@ax/credential-proxy';
import { createUsageLimitsPlugin } from '@ax/usage-limits';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-715 — the operator's model key is metered and gated at the credential
// proxy (Invariant 3: no half-wired plugins).
//
// Two plugins that only mean something together:
//
//   @ax/credential-proxy  measures every model response that leaves a sandbox,
//                         and stops splicing the key in once told the user is over.
//   @ax/usage-limits      books what the proxy measured and answers "may the key
//                         stay unlocked?" (usage:provider-status / -record).
//
// Each has its own package suite against a stand-in for the other. This canary
// runs the REAL plugin on both sides, on a real postgres, through the real
// listener over real sockets, so the hook names, the payloads, the verdict
// shape and the ceiling arithmetic are checked against each other and against
// the preset that ships them.
//
// The "sandbox" is this test process holding what a sandbox holds: the
// placeholder from `proxy:open-session`'s envMap and the session's proxy token.
// A runner-shaped call and a `curl` are the same bytes at the proxy, which is the
// gap this card closes. The provider is a local TLS server on 127.0.0.1 whose
// certificate the proxy's own CA signed (the proxy trusts it for upstreams).
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const REAL_KEY = 'sk-ant-REAL-canary-operator-key';
const INFERENCE = ['POST /v1/messages'];

const USER_A = 'metering-user-a';
const USER_B = 'metering-user-b';
const USER_C = 'metering-user-c';
const USER_D = 'metering-user-d';

/** Opus, $15/M in + $75/M out: 60,000 output tokens = $4.50 a call. */
const OPUS_60K = { model: 'claude-opus-4-1', input: 0, output: 60_000 };
const OPUS_60K_MICROS = 60_000 * 75;
/** Sonnet, $3/M in + $15/M out. */
const SONNET_SMALL = { model: 'claude-sonnet-4-6', input: 1000, output: 500 };
const SONNET_SMALL_MICROS = 1000 * 3 + 500 * 15;

function createControlPlaneStubPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/metering-control-plane-stub';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['http:register-route', 'auth:require-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('http:register-route', name, async () => ({ unregister() {} }));
      bus.registerService('auth:require-user', name, async () => {
        throw new PluginError({ code: 'unauthenticated', plugin: name, message: 'no http plane' });
      });
    },
  };
}

/** `credentials:get` for the proxy: every user's provider key is the same operator key. */
function createCredentialsStubPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/metering-credentials-stub';
  return {
    manifest: { name, version: '0.0.0', registers: ['credentials:get'], calls: [], subscribes: [] },
    init({ bus }) {
      bus.registerService('credentials:get', name, async () => REAL_KEY);
    },
  };
}

interface Provider {
  port: number;
  requests: Array<{ line: string; apiKey: string | undefined }>;
  /** What the NEXT response reports. */
  next: { model: string; input: number; output: number };
  /** When set, the NEXT response is an event stream that stops before its final usage event. */
  cutStreamBytes?: number;
  close(): Promise<void>;
}

/** Mint a leaf for 127.0.0.1 signed by the proxy's CA (the proxy trusts it as an upstream). */
function leafSignedBy(ca: { key: string; cert: string }): { key: string; cert: string } {
  const caKey = forge.pki.privateKeyFromPem(ca.key);
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600_000);
  cert.setSubject([{ name: 'commonName', value: HOST }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 7, ip: HOST }] },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

async function startProvider(ca: { key: string; cert: string }): Promise<Provider> {
  const leaf = leafSignedBy(ca);
  const sockets = new Set<net.Socket>();
  const provider: Provider = {
    port: 0,
    requests: [],
    next: SONNET_SMALL,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
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
        provider.requests.push({
          line: lines[0] ?? '',
          apiKey: headers['x-api-key'] ?? headers.authorization?.replace(/^Bearer /, ''),
        });
        if ((lines[0] ?? '').includes('/api/v1/chat/completions')) {
          // OpenRouter, OpenAI-compatible: an event stream whose last chunk carries the counts
          // (the runner asks for them with stream_options.include_usage).
          const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
          const events =
            chunk({ id: 'gen_1', model: provider.next.model, choices: [{ delta: { content: 'hi' } }] }) +
            chunk({
              id: 'gen_1',
              model: provider.next.model,
              choices: [],
              usage: {
                prompt_tokens: provider.next.input,
                completion_tokens: provider.next.output,
                total_tokens: provider.next.input + provider.next.output,
              },
            }) +
            'data: [DONE]\n\n';
          sock.write(
            'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n' +
              `${Buffer.byteLength(events).toString(16)}\r\n${events}\r\n0\r\n\r\n`,
          );
          continue;
        }
        if (provider.cutStreamBytes !== undefined) {
          // Every token delivered, then the upstream hangs up: `message_delta`, which carries the
          // real output_tokens, never arrives. message_start says output_tokens: 1.
          const ev = (name: string, data: unknown): string =>
            `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
          let events = ev('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_cut',
              model: provider.next.model,
              usage: { input_tokens: provider.next.input, output_tokens: 1 },
            },
          });
          const text = 'x'.repeat(350);
          while (Buffer.byteLength(events) < provider.cutStreamBytes) {
            events += ev('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            });
          }
          provider.cutStreamBytes = undefined;
          sock.write(
            'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n' +
              `${Buffer.byteLength(events).toString(16)}\r\n${events}\r\n`,
          );
          setTimeout(() => sock.destroy(), 50);
          return;
        }
        const body = JSON.stringify({
          id: 'msg_canary',
          model: provider.next.model,
          content: [],
          usage: { input_tokens: provider.next.input, output_tokens: provider.next.output },
        });
        sock.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      }
    });
    sock.on('error', () => undefined);
  });
  provider.port = await new Promise<number>((r) =>
    server.listen(0, HOST, () => r((server.address() as net.AddressInfo).port)),
  );
  return provider;
}

interface Session {
  envMap: Record<string, string>;
  proxyAuthToken: string;
  proxyPort: number;
}

interface Kernel {
  bus: HookBus;
  shutdown(): Promise<void>;
  ca: { key: string; cert: string };
}

const noRows = { provider: 0, runner: 0, helper: 0 };

/** True once `raw` holds a whole Content-Length-framed HTTP response. */
function responseComplete(raw: string): boolean {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) return false;
  const len = /content-length:\s*(\d+)/i.exec(raw.slice(0, end));
  return len !== null && raw.length - (end + 4) >= Number(len[1]);
}

describe('@ax/preset-k8s provider metering canary (real credential-proxy + usage-limits + postgres)', () => {
  let pg: StartedPostgreSqlContainer | null = null;
  let connectionString = '';
  let tmp = '';
  let caDir = '';
  let originalCredKey: string | undefined;
  let kernel: Kernel | null = null;
  let provider: Provider | null = null;
  let sessionSeq = 0;

  function presetConfig(): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      workspace: { backend: 'local', repoRoot: path.join(tmp, 'repo-stub') },
      blob: { backend: 'fs', root: path.join(tmp, 'blobs') },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    };
  }

  async function bootKernel(): Promise<Kernel> {
    const preset = createK8sPlugins(presetConfig());
    const presetUsage = preset.find((p) => p.manifest.name === '@ax/usage-limits');
    const presetProxy = preset.find((p) => p.manifest.name === '@ax/credential-proxy');
    // Both halves ship in the production preset (the reason this canary exists)…
    expect(presetUsage, 'createK8sPlugins must load @ax/usage-limits').toBeDefined();
    expect(presetProxy, 'createK8sPlugins must load @ax/credential-proxy').toBeDefined();
    const usage = createUsageLimitsPlugin();
    const proxy = createCredentialProxyPlugin({
      listen: { kind: 'tcp', host: HOST, port: 0 },
      caDir,
    });
    // …and what boots here is the same plugin, not a look-alike.
    expect(usage.manifest).toEqual(presetUsage!.manifest);
    expect(proxy.manifest).toEqual(presetProxy!.manifest);
    // The hooks one calls are exactly the hooks the other registers.
    expect(usage.manifest.registers).toEqual(
      expect.arrayContaining(['usage:provider-status', 'usage:provider-record']),
    );
    expect((proxy.manifest.optionalCalls ?? []).map((c) => c.hook).sort()).toEqual([
      'usage:provider-record',
      'usage:provider-status',
    ]);

    const kept = preset.filter((p) =>
      ['@ax/database-postgres', '@ax/storage-postgres'].includes(p.manifest.name),
    );
    expect(kept.map((p) => p.manifest.name).sort()).toEqual([
      '@ax/database-postgres',
      '@ax/storage-postgres',
    ]);
    const bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [...kept, usage, proxy, createCredentialsStubPlugin(), createControlPlaneStubPlugin()],
      config: {},
    });
    const ca = {
      key: await fs.readFile(path.join(caDir, 'ca.key'), 'utf8'),
      cert: await fs.readFile(path.join(caDir, 'ca.crt'), 'utf8'),
    };
    return { bus, shutdown: () => handle.shutdown(), ca };
  }

  const live = (): Kernel => {
    if (kernel === null) throw new Error('kernel not booted');
    return kernel;
  };
  const ctxFor = (userId: string) =>
    makeAgentContext({ sessionId: 'canary', agentId: 'canary', userId });

  async function db(): Promise<Kysely<unknown>> {
    const { db: handle } = await live().bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctxFor('system'),
      {},
    );
    return handle;
  }

  async function ledgerFor(userId: string): Promise<{ provider: number; runner: number; helper: number }> {
    const res = await sql<{ p: string | null; r: string | null; h: string | null }>`
      SELECT SUM(provider_cost_micros) AS p, SUM(cost_micros) AS r, SUM(helper_cost_micros) AS h
      FROM usage_limits_v1_buckets WHERE user_id = ${userId}
    `.execute(await db());
    const n = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
    const row = res.rows[0];
    return { provider: n(row?.p), runner: n(row?.r), helper: n(row?.h) };
  }

  async function waitForProviderCost(userId: string, micros: number): Promise<void> {
    await vi.waitFor(async () => expect((await ledgerFor(userId)).provider).toBe(micros), {
      timeout: 10_000,
      interval: 50,
    });
  }

  async function setLimits(limits: {
    dailySpendUsd: number;
    turnsPerHour: number;
    assumedTurnCostUsd: number;
  }): Promise<void> {
    await live().bus.call('storage:set', ctxFor('system'), {
      key: 'settings:usage-limits',
      value: new TextEncoder().encode(JSON.stringify(limits)),
    });
  }

  /** What the orchestrator does at spawn: open a proxy session with the provider key marked metered. */
  async function openSession(userId: string, requests: string[] = INFERENCE): Promise<Session> {
    sessionSeq += 1;
    const opened = await live().bus.call<
      unknown,
      { proxyEndpoint: string; envMap: Record<string, string>; proxyAuthToken: string }
    >('proxy:open-session', ctxFor(userId), {
      sessionId: `metering-${userId}-${sessionSeq}`,
      userId,
      agentId: 'canary-agent',
      allowlist: [HOST],
      allowedIPs: [HOST],
      credentials: {
        ANTHROPIC_API_KEY: {
          ref: 'provider:anthropic',
          kind: 'api-key',
          allowedHosts: [HOST],
          metered: { requests },
        },
      },
    });
    return {
      envMap: opened.envMap,
      proxyAuthToken: opened.proxyAuthToken,
      proxyPort: Number(new URL(opened.proxyEndpoint.replace('tcp://', 'http://')).port),
    };
  }

  /** One request the way the sandbox's env lets ANY process make it: the placeholder, through the proxy. */
  async function callFromSandbox(
    s: Session,
    usage = SONNET_SMALL,
    requestPath = '/v1/messages',
  ): Promise<{ status: number; body: string }> {
    provider!.next = usage;
    const raw = net.connect(s.proxyPort, HOST);
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write(
      `CONNECT ${HOST}:${provider!.port} HTTP/1.1\r\nHost: ${HOST}:${provider!.port}\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from(`ax:${s.proxyAuthToken}`).toString('base64')}\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      let acc = '';
      raw.on('data', function onData(d: Buffer) {
        acc += d.toString('latin1');
        if (!acc.includes('\r\n\r\n')) return;
        raw.removeListener('data', onData);
        if (acc.startsWith('HTTP/1.1 200')) resolve();
        else reject(new Error(`CONNECT refused: ${acc}`));
      });
    });
    const inner: TLSSocket = tlsConnect({ socket: raw, servername: HOST, ca: live().ca.cert });
    inner.on('error', () => undefined);
    await new Promise<void>((r) => inner.once('secureConnect', () => r()));
    let got = '';
    inner.on('data', (d: Buffer) => {
      got += d.toString('latin1');
    });
    const body = JSON.stringify({ model: usage.model, max_tokens: usage.output, messages: [] });
    inner.write(
      `POST ${requestPath} HTTP/1.1\r\nHost: ${HOST}\r\nx-api-key: ${s.envMap.ANTHROPIC_API_KEY}\r\n` +
        `content-type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await vi.waitFor(() => expect(responseComplete(got) || got.endsWith('0\r\n\r\n')).toBe(true), {
      timeout: 10_000,
    });
    inner.destroy();
    raw.destroy();
    return { status: parseInt(got.split(' ')[1] ?? '0', 10), body: got.slice(got.indexOf('\r\n\r\n') + 4) };
  }

  /** Like callFromSandbox, but the response is a stream that the upstream cuts off; resolves when the tunnel closes. */
  async function streamCutFromSandbox(s: Session, bytes: number, usage = OPUS_60K): Promise<void> {
    provider!.next = usage;
    provider!.cutStreamBytes = bytes;
    const raw = net.connect(s.proxyPort, HOST);
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write(
      `CONNECT ${HOST}:${provider!.port} HTTP/1.1\r\nHost: ${HOST}:${provider!.port}\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from(`ax:${s.proxyAuthToken}`).toString('base64')}\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      let acc = '';
      raw.on('data', function onData(d: Buffer) {
        acc += d.toString('latin1');
        if (!acc.includes('\r\n\r\n')) return;
        raw.removeListener('data', onData);
        if (acc.startsWith('HTTP/1.1 200')) resolve();
        else reject(new Error(`CONNECT refused: ${acc}`));
      });
    });
    const inner: TLSSocket = tlsConnect({ socket: raw, servername: HOST, ca: live().ca.cert });
    inner.on('error', () => undefined);
    await new Promise<void>((r) => inner.once('secureConnect', () => r()));
    const closed = new Promise<void>((r) => inner.once('close', () => r()));
    inner.on('data', () => undefined);
    const body = JSON.stringify({ model: usage.model, max_tokens: usage.output, stream: true, messages: [] });
    inner.write(
      `POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nx-api-key: ${s.envMap.ANTHROPIC_API_KEY}\r\n` +
        `content-type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await closed;
    raw.destroy();
  }

  const chatStart = (userId: string) =>
    live().bus.fire('chat:start', ctxFor(userId), { message: 'hello' });

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-metering-canary-')));
    caDir = path.join(tmp, 'proxy-ca');
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
    pg = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = pg.getConnectionUri();
    kernel = await bootKernel();
    provider = await startProvider(kernel.ca);
  });

  beforeEach(async () => {
    provider!.requests.length = 0;
    await sql`TRUNCATE usage_limits_v1_buckets, usage_limits_v1_suspensions`.execute(await db());
    await setLimits({ dailySpendUsd: 5, turnsPerHour: 60, assumedTurnCostUsd: 0.25 });
  });

  afterAll(async () => {
    if (provider !== null) await provider.close();
    if (kernel !== null) await kernel.shutdown();
    kernel = null;
    await stopPostgresContainer(pg ?? undefined);
    pg = null;
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('(a) a call from the sandbox reaches the provider with the real key and is COUNTED in the ledger', async () => {
    const s = await openSession(USER_A);
    const res = await callFromSandbox(s);
    expect(res.status).toBe(200);
    expect(provider!.requests).toHaveLength(1);
    expect(provider!.requests[0]!.apiKey).toBe(REAL_KEY);

    // Before this card the row would never exist: nothing measured this call.
    await waitForProviderCost(USER_A, SONNET_SMALL_MICROS);
    expect(await ledgerFor(USER_A)).toEqual({ provider: SONNET_SMALL_MICROS, runner: 0, helper: 0 });
  });

  it('(b) a loop of direct calls is cut off at 2x the daily limit; the key is not spliced past it', async () => {
    const s = await openSession(USER_B);
    // $5 limit -> the key stays unlocked until $10. Each call is $4.50.
    for (let i = 1; i <= 3; i++) {
      const res = await callFromSandbox(s, OPUS_60K);
      expect(res.status, `call ${i}`).toBe(200);
      await waitForProviderCost(USER_B, i * OPUS_60K_MICROS);
    }
    // The third call took the user to $13.50, past the $10 ceiling. The verdict reaches the
    // proxy a moment after the row is written (that latency, and the calls already in flight
    // when it lands, are the documented overshoot). The proxy stops here…
    await new Promise((r) => setTimeout(r, 300));
    const refused = await callFromSandbox(s, OPUS_60K);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
    // …and the provider never saw a fourth request (nor the real key on it).
    expect(provider!.requests).toHaveLength(3);
    expect((await ledgerFor(USER_B)).provider).toBe(3 * OPUS_60K_MICROS);

    // The turn gate now agrees: spend only the proxy ever saw refuses a new turn.
    expect(await chatStart(USER_B)).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
    // A different user is unaffected by all of it.
    expect((await chatStart(USER_A)).rejected).toBe(false);
    const other = await openSession(USER_A);
    expect((await callFromSandbox(other)).status).toBe(200);
  });

  it('(c) the runner\'s own report and the proxy\'s measurement of the SAME turn are one spend, not two', async () => {
    // $1 limit. One Sonnet-small call is $0.0105; the runner reports the same turn.
    await setLimits({ dailySpendUsd: 0.0158, turnsPerHour: 60, assumedTurnCostUsd: 0.25 });
    const s = await openSession(USER_C);
    expect((await callFromSandbox(s)).status).toBe(200);
    await waitForProviderCost(USER_C, SONNET_SMALL_MICROS);
    await live().bus.fire('chat:turn-end', ctxFor(USER_C), {
      role: 'assistant',
      reason: 'complete',
      usage: {
        model: SONNET_SMALL.model,
        inputTokens: SONNET_SMALL.input,
        outputTokens: SONNET_SMALL.output,
      },
    });
    await vi.waitFor(async () => expect((await ledgerFor(USER_C)).runner).toBe(SONNET_SMALL_MICROS));
    expect(await ledgerFor(USER_C)).toEqual({
      provider: SONNET_SMALL_MICROS,
      runner: SONNET_SMALL_MICROS,
      helper: 0,
    });
    // $0.0105 is under the $0.0158 limit. Added together ($0.0210) it would be over,
    // and this honest user would be refused for a turn that was billed once.
    expect((await chatStart(USER_C)).rejected).toBe(false);
  });

  it('(d) a suspended user\'s next call is refused; an already-blocked user starts blocked; both survive a restart', async () => {
    // Suspend D while a session is open: the next call is still served (it is what brings the
    // news back), and the one after it is refused.
    const s = await openSession(USER_D);
    await sql`
      INSERT INTO usage_limits_v1_suspensions (user_id, suspended_at, suspended_by, note)
      VALUES (${USER_D}, now(), 'metering-canary-admin', 'canary')
    `.execute(await db());
    expect((await callFromSandbox(s)).status).toBe(200);
    await waitForProviderCost(USER_D, SONNET_SMALL_MICROS);
    expect((await callFromSandbox(s)).status).toBe(429);
    expect(provider!.requests).toHaveLength(1);

    // Tear the whole host down. Nothing held in memory survives; the database does.
    await live().shutdown();
    kernel = null;
    kernel = await bootKernel();
    provider!.requests.length = 0;

    // A brand-new session for the same user: the status check at open says blocked, so the
    // very first call is refused. No warm-up call, no free round trip.
    const fresh = await openSession(USER_D);
    expect((await callFromSandbox(fresh)).status).toBe(429);
    expect(provider!.requests).toHaveLength(0);

    // Lifting the suspension frees the key again for a new session.
    await sql`DELETE FROM usage_limits_v1_suspensions WHERE user_id = ${USER_D}`.execute(await db());
    const lifted = await openSession(USER_D);
    expect((await callFromSandbox(lifted)).status).toBe(200);
  });

  it('(f) reading every token of a stream and hanging up before the final usage event is charged for the tokens read', async () => {
    const s = await openSession(USER_C);
    // ~480 KB of text deltas: at the stream floor of 8 bytes a token that is >= 60,000 output
    // tokens, i.e. >= $4.50 on Opus. Counting only what the stream REPORTED (output_tokens: 1)
    // would book about a cent, and the whole answer would have been free.
    await streamCutFromSandbox(s, 480_000);
    await vi.waitFor(async () => expect((await ledgerFor(USER_C)).provider).toBeGreaterThanOrEqual(OPUS_60K_MICROS), {
      timeout: 10_000,
      interval: 50,
    });
    // …and stays a plausible over-count rather than a runaway one (well under 2x the ceiling here).
    expect((await ledgerFor(USER_C)).provider).toBeLessThan(2 * OPUS_60K_MICROS);
  });

  it('(g) OpenRouter\'s wire: a streamed chat completion with usage in the last chunk is booked (unknown models at the top price)', async () => {
    const s = await openSession(USER_D, ['POST /api/v1/chat/completions']);
    const res = await callFromSandbox(
      s,
      { model: 'x-ai/grok-4.6', input: 1000, output: 500 },
      '/api/v1/chat/completions',
    );
    expect(res.status).toBe(200);
    // Not a Claude model, so priced at the top tier: 1000 x $15/M + 500 x $75/M.
    await waitForProviderCost(USER_D, 1000 * 15 + 500 * 75);
    // A request to the ANTHROPIC path on this session's key is not a model call here: inert.
    provider!.requests.length = 0;
    await callFromSandbox(s, SONNET_SMALL, '/v1/messages');
    expect(provider!.requests[0]!.apiKey).toBe(s.envMap.ANTHROPIC_API_KEY);
  });

  it('(e) a request that is not a model call never gets the key, even from a session that has it', async () => {
    const s = await openSession(USER_A);
    provider!.next = SONNET_SMALL;
    const raw = net.connect(s.proxyPort, HOST);
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write(
      `CONNECT ${HOST}:${provider!.port} HTTP/1.1\r\nHost: ${HOST}\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from(`ax:${s.proxyAuthToken}`).toString('base64')}\r\n\r\n`,
    );
    await new Promise<void>((resolve) => {
      let acc = '';
      raw.on('data', function onData(d: Buffer) {
        acc += d.toString('latin1');
        if (!acc.includes('\r\n\r\n')) return;
        raw.removeListener('data', onData);
        resolve();
      });
    });
    const inner: TLSSocket = tlsConnect({ socket: raw, servername: HOST, ca: live().ca.cert });
    inner.on('error', () => undefined);
    await new Promise<void>((r) => inner.once('secureConnect', () => r()));
    let got = '';
    inner.on('data', (d: Buffer) => {
      got += d.toString('latin1');
    });
    // A batch job: one call, up to 100k billed requests. The placeholder goes through inert.
    inner.write(
      `POST /v1/messages/batches HTTP/1.1\r\nHost: ${HOST}\r\nx-api-key: ${s.envMap.ANTHROPIC_API_KEY}\r\nContent-Length: 2\r\n\r\n{}`,
    );
    await vi.waitFor(() => expect(provider!.requests).toHaveLength(1));
    expect(provider!.requests[0]!.apiKey).toBe(s.envMap.ANTHROPIC_API_KEY);
    expect(provider!.requests[0]!.apiKey).not.toBe(REAL_KEY);
    await vi.waitFor(() => expect(got).toContain('200 OK'));
    inner.destroy();
    raw.destroy();
    // Not a model call: nothing booked.
    expect(await ledgerFor(USER_A)).toEqual(noRows);
  });
});

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { createProxyFetch, readProxyCaPem, resolveModel } from '../provider.js';

const PLACEHOLDER = 'ax-cred:0123456789abcdef0123456789abcdef';
const PROXY_TOKEN = 'facefeedfacefeedfacefeedfacefeed';

function env(over: Record<string, string> = {}): Record<string, string> {
  return { ANTHROPIC_API_KEY: PLACEHOLDER, ...over };
}

/**
 * Minimal non-streaming Anthropic `/v1/messages` response. Enough for
 * `generateText` to complete so the assertions can be about the REQUEST.
 */
const CANNED_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A `fetch` that never touches the network: it records what would have gone on
 * the wire and answers with the canned response. Every "no auth discovery"
 * assertion in this file reads from `captured`, not from what we passed in —
 * asserting on the input would prove nothing about the outgoing header.
 */
function capturingFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url: string }).url);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) headers[String(k).toLowerCase()] = String(v);
    } else if (raw !== undefined && raw !== null) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        if (v !== undefined) headers[k.toLowerCase()] = String(v);
      }
    }
    captured.push({
      url,
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(CANNED_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

interface FakeProxy {
  port: number;
  /** One entry per CONNECT the dispatcher issued. */
  connects: Array<{ target: string; auth: string | undefined }>;
  /** One entry per request that came through the tunnel. */
  tunnelled: Array<{ url: string; host: string | undefined }>;
  close(): Promise<void>;
}

/**
 * A loopback CONNECT proxy. undici's `ProxyAgent` tunnels by default
 * (`proxyTunnel: true`) even for an `http:` origin, so a plain request-
 * forwarding server would never answer — the assertions have to be about the
 * CONNECT, which is also where `Proxy-Authorization` travels.
 */
async function startTunnelProxy(): Promise<FakeProxy> {
  const connects: FakeProxy['connects'] = [];
  const tunnelled: FakeProxy['tunnelled'] = [];

  // The origin the tunnel lands on. Handing the raw socket to a real
  // http.Server beats hand-rolling an HTTP response on the wire.
  const inner = http.createServer((req, res) => {
    tunnelled.push({ url: req.url ?? '', host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('through-the-proxy');
  });

  const proxy = http.createServer((_req, res) => {
    res.writeHead(400).end();
  });
  proxy.on('connect', (req, socket) => {
    connects.push({
      target: req.url ?? '',
      auth: req.headers['proxy-authorization'],
    });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    inner.emit('connection', socket);
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  return {
    port: (proxy.address() as { port: number }).port,
    connects,
    tunnelled,
    close: async () => {
      // undici keeps the tunnel alive; drop it explicitly or close() hangs.
      proxy.closeAllConnections();
      inner.closeAllConnections();
      proxy.close();
      inner.close();
    },
  };
}

describe('resolveModel — credential placeholder validation', () => {
  it('accepts the ax-cred:<32-hex> placeholder', () => {
    expect(() =>
      resolveModel({ modelRef: 'anthropic/claude-sonnet-4-6', providerEnv: env() }),
    ).not.toThrow();
  });

  it('rejects a real-looking Anthropic key (a capability leak, not a convenience)', () => {
    expect(() =>
      resolveModel({
        modelRef: 'anthropic/claude-sonnet-4-6',
        providerEnv: env({ ANTHROPIC_API_KEY: 'sk-ant-api03-totally-real-key' }),
      }),
    ).toThrowError(/ax-cred:<32-hex>/);
  });

  it('rejects a missing placeholder', () => {
    expect(() =>
      resolveModel({ modelRef: 'anthropic/claude-sonnet-4-6', providerEnv: {} }),
    ).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it('rejects an empty placeholder', () => {
    expect(() =>
      resolveModel({
        modelRef: 'anthropic/claude-sonnet-4-6',
        providerEnv: env({ ANTHROPIC_API_KEY: '' }),
      }),
    ).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it('rejects a placeholder with the wrong hex length', () => {
    expect(() =>
      resolveModel({
        modelRef: 'anthropic/claude-sonnet-4-6',
        providerEnv: env({ ANTHROPIC_API_KEY: 'ax-cred:0123456789abcdef' }),
      }),
    ).toThrowError(/ax-cred:<32-hex>/);
  });
});

describe('resolveModel — provider gating', () => {
  it('rejects a non-anthropic ref by name and points at the PR that adds it', () => {
    let message = '';
    try {
      resolveModel({ modelRef: 'openrouter/x-ai/grok-4.6', providerEnv: env() });
      throw new Error('expected resolveModel to throw');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('openrouter');
    expect(message).toContain('PR 4');
    expect(message).toContain('PR 5');
    // The whole point of the guard: it must NOT quietly become an Anthropic call.
    expect(message).not.toMatch(/falling back|defaulting/i);
  });

  it('rejects a vertex ref too (the guard is an allow-list, not a deny-list)', () => {
    expect(() =>
      resolveModel({ modelRef: 'vertex/gemini-3-pro', providerEnv: env() }),
    ).toThrowError(/vertex/);
  });

  it('rejects a bare model id with no provider prefix (no implicit anthropic)', () => {
    expect(() =>
      resolveModel({ modelRef: 'claude-sonnet-4-6', providerEnv: env() }),
    ).toThrowError();
  });
});

describe('resolveModel — what actually reaches the wire', () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorBaseUrl = process.env.ANTHROPIC_BASE_URL;

  beforeEach(() => {
    // The decoy. `createAnthropic` defaults `apiKey` to this env var when the
    // option is omitted — exactly the auth discovery §6 forbids. If provider.ts
    // ever stops passing `apiKey` explicitly, this value goes on the wire and
    // the assertion below goes red.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-decoy-from-process-env';
    process.env.ANTHROPIC_BASE_URL = 'https://decoy.invalid/v1';
  });

  afterEach(() => {
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
    if (priorBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = priorBaseUrl;
  });

  it('sends the placeholder from providerEnv, never the one in process.env', async () => {
    const captured: CapturedRequest[] = [];
    const model = resolveModel({
      modelRef: 'anthropic/claude-sonnet-4-6',
      providerEnv: env(),
      fetchImpl: capturingFetch(captured),
    });

    await generateText({ model, prompt: 'hi' });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.headers['x-api-key']).toBe(PLACEHOLDER);
    expect(req.headers['x-api-key']).not.toBe('sk-ant-decoy-from-process-env');
    // The placeholder must be the ONLY credential-shaped header we emit.
    expect(req.headers.authorization).toBeUndefined();
  });

  it('sends the raw model id with the provider prefix stripped', async () => {
    const captured: CapturedRequest[] = [];
    const model = resolveModel({
      modelRef: 'anthropic/claude-sonnet-4-6',
      providerEnv: env(),
      fetchImpl: capturingFetch(captured),
    });

    await generateText({ model, prompt: 'hi' });

    expect(captured[0]!.body.model).toBe('claude-sonnet-4-6');
  });

  it('pins the base URL to api.anthropic.com, ignoring ANTHROPIC_BASE_URL', async () => {
    const captured: CapturedRequest[] = [];
    const model = resolveModel({
      modelRef: 'anthropic/claude-sonnet-4-6',
      providerEnv: env(),
      fetchImpl: capturingFetch(captured),
    });

    await generateText({ model, prompt: 'hi' });

    expect(captured[0]!.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('createProxyFetch', () => {
  it('returns undefined when no proxy is configured', () => {
    expect(createProxyFetch(env())).toBeUndefined();
  });

  it('returns a fetch when HTTPS_PROXY is set', () => {
    const f = createProxyFetch(env({ HTTPS_PROXY: 'http://127.0.0.1:9/' }));
    expect(typeof f).toBe('function');
  });

  it('throws on a malformed proxy URL rather than silently bypassing the proxy', () => {
    expect(() => createProxyFetch(env({ HTTPS_PROXY: 'not a url' }))).toThrowError(
      /HTTPS_PROXY/,
    );
  });

  it('routes the request through the proxy and carries the Basic session token', async () => {
    const proxy = await startTunnelProxy();
    try {
      const proxyFetch = createProxyFetch(
        env({ HTTPS_PROXY: `http://ax:${PROXY_TOKEN}@127.0.0.1:${proxy.port}` }),
      );
      expect(proxyFetch).toBeDefined();

      // `.invalid` never resolves (RFC 2606). If the dispatcher were dropped,
      // this would attempt a real DNS lookup and fail instead of tunnelling
      // through the loopback proxy above.
      const res = await proxyFetch!('http://model-host.invalid/v1/messages');
      expect(await res.text()).toBe('through-the-proxy');

      expect(proxy.connects).toEqual([
        {
          target: 'model-host.invalid:80',
          auth: `Basic ${Buffer.from(`ax:${PROXY_TOKEN}`).toString('base64')}`,
        },
      ]);
      expect(proxy.tunnelled).toEqual([
        { url: '/v1/messages', host: 'model-host.invalid' },
      ]);
    } finally {
      await proxy.close();
    }
  });

  it('does not send Proxy-Authorization when the proxy URL carries no token', async () => {
    const proxy = await startTunnelProxy();
    try {
      const proxyFetch = createProxyFetch(
        env({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }),
      );
      await proxyFetch!('http://model-host.invalid/v1/messages');
      expect(proxy.connects.map((c) => c.auth)).toEqual([undefined]);
    } finally {
      await proxy.close();
    }
  });
});

describe('readProxyCaPem', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-provider-ca-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when neither CA var is set', () => {
    expect(readProxyCaPem(env())).toBeUndefined();
  });

  it('reads NODE_EXTRA_CA_CERTS', () => {
    const pem = path.join(dir, 'ca.pem');
    fs.writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nzz\n-----END CERTIFICATE-----\n');
    expect(readProxyCaPem(env({ NODE_EXTRA_CA_CERTS: pem }))).toContain(
      'BEGIN CERTIFICATE',
    );
  });

  it('falls back to SSL_CERT_FILE', () => {
    const pem = path.join(dir, 'ssl.pem');
    fs.writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nyy\n-----END CERTIFICATE-----\n');
    expect(readProxyCaPem(env({ SSL_CERT_FILE: pem }))).toContain('BEGIN CERTIFICATE');
  });

  it('warns and proceeds when the CA file is unreadable (delivery differs per sandbox)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        readProxyCaPem(env({ NODE_EXTRA_CA_CERTS: path.join(dir, 'nope.pem') })),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('nope.pem');
    } finally {
      warn.mockRestore();
    }
  });

  it('a missing CA file does not stop createProxyFetch from returning a fetch', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const f = createProxyFetch(
        env({
          HTTPS_PROXY: 'http://127.0.0.1:9/',
          NODE_EXTRA_CA_CERTS: path.join(dir, 'absent.pem'),
        }),
      );
      expect(typeof f).toBe('function');
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The gateway-bypass property.
//
// `ai@7`'s `LanguageModel` type is `string | LanguageModelV4 | …`. Hand
// `ToolLoopAgent` a STRING and it resolves the model through the AI SDK's
// DEFAULT GATEWAY provider, which performs its own credential discovery
// (`AI_GATEWAY_API_KEY`, then Vercel OIDC). That is exactly the auth discovery
// design §6 forbids — and it is the kind of change that still "works" on a
// developer's machine with a gateway key set, so it would not be caught by
// anything except this assertion.
//
// Returning a constructed provider model object is what keeps the gateway out
// of the path entirely.
// ---------------------------------------------------------------------------
describe('no gateway, no auth discovery', () => {
  it('resolves to a provider model OBJECT, never a bare model-id string', () => {
    const model = resolveModel({
      modelRef: 'anthropic/claude-sonnet-4-6',
      providerEnv: env({}),
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });

    expect(typeof model).not.toBe('string');
    expect(model).toMatchObject({
      specificationVersion: expect.stringMatching(/^v\d+$/),
      modelId: 'claude-sonnet-4-6',
    });
    // And it is the Anthropic provider, not the gateway.
    expect(String((model as { provider?: unknown }).provider)).toMatch(/anthropic/i);
  });
});

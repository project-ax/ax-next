import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HookBus, makeChatContext } from '@ax/core';
import type { ChatContext, ServiceHandler } from '@ax/core';
import type { LlmCallRequest, LlmCallResponse } from '@ax/ipc-protocol';
import { createProxyListener, type ProxyListener } from '../listener.js';

// ---------------------------------------------------------------------------
// Listener tests
//
// Fires real HTTP requests against the bound 127.0.0.1:<ephemeral> listener.
// Uses a plain HookBus with stubbed `session:resolve-token` and `llm:call`
// services — no real session/LLM plugin required.
// ---------------------------------------------------------------------------

interface HarnessOpts {
  sessionId?: string;
  resolveToken?: ServiceHandler<{ token: string }, unknown>;
  llmCall?: ServiceHandler<LlmCallRequest, LlmCallResponse>;
}

interface Harness {
  listener: ProxyListener;
  sessionId: string;
  bus: HookBus;
  ctx: ChatContext;
  cleanup: () => Promise<void>;
}

const GOOD_TOKEN = 'good-token';

async function makeHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const bus = new HookBus();
  const sessionId = opts.sessionId ?? 'test-session';

  const resolveToken: ServiceHandler<{ token: string }, unknown> =
    opts.resolveToken ??
    (async (_ctx, input) => {
      if (input.token === GOOD_TOKEN) {
        return { sessionId, workspaceRoot: '/tmp/ws' };
      }
      return null;
    });

  const llmCall: ServiceHandler<LlmCallRequest, LlmCallResponse> =
    opts.llmCall ??
    (async () => ({
      assistantMessage: { role: 'assistant', content: 'hello from mock' },
      toolCalls: [],
    }));

  bus.registerService('session:resolve-token', 'mock', resolveToken);
  bus.registerService('llm:call', 'mock', llmCall as ServiceHandler);

  const listener = await createProxyListener({ bus, sessionId });
  const ctx = makeChatContext({
    sessionId,
    agentId: 'test',
    userId: 'test',
    workspace: { rootPath: '/tmp/ws' },
  });

  return {
    listener,
    sessionId,
    bus,
    ctx,
    cleanup: async () => {
      await listener.close();
    },
  };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequest(
  url: string,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<RawResponse> {
  const u = new URL(url);
  return new Promise<RawResponse>((resolve, reject) => {
    const body =
      opts.body === undefined
        ? undefined
        : Buffer.isBuffer(opts.body)
          ? opts.body
          : Buffer.from(opts.body, 'utf8');
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (body !== undefined && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = String(body.length);
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path: opts.path,
        method: opts.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });
}

describe('createProxyListener', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const h of harnesses) await h.cleanup();
    harnesses.length = 0;
  });

  it('binds to 127.0.0.1:<ephemeral> and exposes url', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    expect(h.listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(h.listener.port).toBeGreaterThan(0);
  });

  it('GET /_healthz returns 200 ok', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, { method: 'GET', path: '/_healthz' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok\n');
  });

  it('POST /v1/messages non-streaming: returns 200 JSON with round-tripped text', async () => {
    const h = await makeHarness({
      llmCall: async () => ({
        assistantMessage: { role: 'assistant', content: 'round-trip ok' },
        toolCalls: [],
      }),
    });
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GOOD_TOKEN}`,
      },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('message');
    expect(parsed.role).toBe('assistant');
    expect(parsed.model).toBe('claude-sonnet-4-6');
    expect(parsed.content[0]).toEqual({ type: 'text', text: 'round-trip ok' });
  });

  it('POST /v1/messages with stream: true returns SSE frames', async () => {
    const h = await makeHarness({
      llmCall: async () => ({
        assistantMessage: { role: 'assistant', content: 'streamy' },
        toolCalls: [],
      }),
    });
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GOOD_TOKEN}`,
      },
      body: validBody({ stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.body).toContain('event: message_start');
    expect(res.body).toContain('event: content_block_start');
    expect(res.body).toContain('event: content_block_delta');
    expect(res.body).toContain('event: content_block_stop');
    expect(res.body).toContain('event: message_delta');
    expect(res.body).toContain('event: message_stop');
    expect(res.body).toContain('streamy');
  });

  it('rejects missing Authorization with 401 authentication_error', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.message).toBe('missing bearer token');
  });

  it('rejects invalid token (resolver returns null) with 401; token not echoed', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const badToken = 'nope-nope-nope';
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${badToken}`,
      },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('authentication_error');
    expect(res.body).not.toContain(badToken);
  });

  it('rejects invalid token (resolver throws) with 401; token not echoed', async () => {
    const h = await makeHarness({
      resolveToken: async () => {
        throw new Error('nope');
      },
    });
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer explode-me`,
      },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('explode-me');
  });

  it('rejects token bound to a different sessionId with 403', async () => {
    const h = await makeHarness({
      sessionId: 'session-A',
      resolveToken: async () => ({ sessionId: 'session-B', workspaceRoot: '/tmp/ws' }),
    });
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GOOD_TOKEN}`,
      },
      body: validBody(),
    });
    expect(res.status).toBe(403);
  });

  it('rejects Content-Length > 4 MiB with 413', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GOOD_TOKEN}`,
        'Content-Length': String(5 * 1024 * 1024),
      },
    });
    expect(res.status).toBe(413);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.message).toBe('body too large');
  });

  it('rejects malformed JSON with 400 invalid_request_error', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GOOD_TOKEN}`,
      },
      body: '{"a":',
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.message).toMatch(/^invalid json:/);
  });

  it('rejects schema violation (missing messages) with 400', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GOOD_TOKEN}`,
      },
      body: JSON.stringify({ model: 'x', max_tokens: 1 }),
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.message).toMatch(/did not match Anthropic messages schema/);
    // Must not leak the token or env var names in the schema error.
    expect(res.body).not.toContain(GOOD_TOKEN);
  });

  it('propagates llm:call throwing as 502 api_error', async () => {
    const h = await makeHarness({
      llmCall: async () => {
        throw new Error('upstream exploded');
      },
    });
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GOOD_TOKEN}`,
      },
      body: validBody(),
    });
    expect(res.status).toBe(502);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('api_error');
    expect(parsed.error.message).toContain('upstream exploded');
  });

  it('GET /v1/messages returns 405 method not allowed', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, { method: 'GET', path: '/v1/messages' });
    expect(res.status).toBe(405);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('invalid_request_error');
  });

  it('GET /v1/not-messages returns 404', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await httpRequest(h.listener.url, { method: 'GET', path: '/v1/not-messages' });
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('not_found_error');
  });

  it('close() releases the port (re-bind on same port succeeds)', async () => {
    const h = await makeHarness();
    const firstPort = h.listener.port;
    await h.listener.close();

    // Bind a raw server on the same port to prove it was freed.
    const reclaim = http.createServer();
    await new Promise<void>((resolve, reject) => {
      reclaim.once('error', reject);
      reclaim.listen(firstPort, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => reclaim.close(() => resolve()));
  });

  it('does not echo the bearer token in any response body', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    // Send many request categories with the same token; none of them
    // should include the token in their body.
    const secretToken = 'supersecret-123';
    const bodies: string[] = [];
    const paths: Array<{ method: string; path: string; body?: string }> = [
      { method: 'POST', path: '/v1/messages', body: '{"not":"valid"}' },
      { method: 'POST', path: '/v1/messages', body: '{"a":' },
      { method: 'GET', path: '/v1/not-messages' },
    ];
    for (const p of paths) {
      const res = await httpRequest(h.listener.url, {
        method: p.method,
        path: p.path,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretToken}`,
        },
        ...(p.body !== undefined ? { body: p.body } : {}),
      });
      bodies.push(res.body);
    }
    for (const b of bodies) {
      expect(b).not.toContain(secretToken);
    }
  });
});

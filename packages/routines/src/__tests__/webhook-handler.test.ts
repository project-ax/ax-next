import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { makeWebhookHandler } from '../webhook-handler.js';
import { HookBus } from '@ax/core';
import type { RoutineRow } from '../types.js';
import type { HttpRequest, HttpResponse } from '@ax/http-server';

function makeRow(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
    name: 'r', description: 'd', specHash: 'h',
    trigger: { kind: 'webhook', path: '/r' },
    activeHours: null, silenceToken: null, silenceMaxChars: 300,
    conversation: 'per-fire', promptBody: 'PR {{payload.pr.title}}',
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null,
    ...over,
  };
}

function makeReq(over: Partial<{ headers: Record<string, string>; body: Buffer }> = {}): HttpRequest {
  return {
    method: 'POST',
    path: '/webhooks/tok/slug',
    query: {}, params: {},
    headers: { 'content-type': 'application/json', ...(over.headers ?? {}) },
    body: over.body ?? Buffer.from('{}'),
    cookies: {},
    signedCookie: () => null,
  } as HttpRequest;
}

function makeRes() {
  const calls: { status?: number; ended?: boolean } = {};
  const res: any = {
    status(n: number) { calls.status = n; return res; },
    header() { return res; },
    text() { calls.ended = true; },
    json() { calls.ended = true; },
    body() { calls.ended = true; },
    end() { calls.ended = true; },
    redirect() { calls.ended = true; },
    setSignedCookie() {}, clearCookie() {},
    stream() { throw new Error('not used'); },
    _calls: calls,
  };
  return res as HttpResponse & { _calls: typeof calls };
}

function makeBus(credentialsGet?: (ref: string) => Promise<string>): HookBus {
  const bus = new HookBus();
  if (credentialsGet) {
    bus.registerService('credentials:get', 'test', async (_ctx, input: any) =>
      credentialsGet(input.ref));
  }
  return bus;
}

describe('makeWebhookHandler', () => {
  it('responds 202 and fires the routine on a valid POST', async () => {
    const fired: Array<{ source: string; payload: unknown }> = [];
    const row = makeRow();
    const fire = vi.fn().mockImplementation(async (_r, source, payload) => {
      fired.push({ source, payload });
      return { status: 'ok', conversationId: 'c1', error: null };
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({ body: Buffer.from('{"pr":{"title":"x"}}') }), res);
    // Fire is fire-and-forget — the void-and-202 happens before fire resolves.
    // Flush microtasks so the synchronous .then chain settles.
    await new Promise(r => setImmediate(r));
    expect(res._calls.status).toBe(202);
    expect(fired).toEqual([{ source: 'webhook', payload: { pr: { title: 'x' } } }]);
  });

  it('returns 404 when the row is missing (race between unregister and request)', async () => {
    const fire = vi.fn();
    const store = { findOne: async () => null };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: '.ax/routines/r.md', fire,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._calls.status).toBe(404);
    expect(fire).not.toHaveBeenCalled();
  });

  it('returns 404 when the row exists but trigger.kind is not webhook', async () => {
    const fire = vi.fn();
    const row = makeRow({ trigger: { kind: 'interval', every: '60s' } });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._calls.status).toBe(404);
    expect(fire).not.toHaveBeenCalled();
  });

  it('returns 401 on HMAC mismatch', async () => {
    const fire = vi.fn();
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256' } },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(async () => 'shhh'), store: store as any,
      agentId: 'agt_a', routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': 'deadbeef' },
      body: Buffer.from('{"x":1}'),
    }), res);
    expect(res._calls.status).toBe(401);
    expect(fire).not.toHaveBeenCalled();
  });

  it('returns 401 when HMAC header is missing', async () => {
    const fire = vi.fn();
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256' } },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(async () => 'shhh'), store: store as any,
      agentId: 'agt_a', routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({ body: Buffer.from('{}') }), res);
    expect(res._calls.status).toBe(401);
    expect(fire).not.toHaveBeenCalled();
  });

  it('returns 401 when credentials:get rejects (missing secret)', async () => {
    const fire = vi.fn();
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256' } },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(async () => { throw new Error('no'); }),
      store: store as any, agentId: 'agt_a', routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': 'whatever' },
      body: Buffer.from('{}'),
    }), res);
    expect(res._calls.status).toBe(401);
    expect(fire).not.toHaveBeenCalled();
  });

  it('accepts a valid HMAC over the raw body and fires', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'ok', conversationId: 'c1', error: null });
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256', prefix: 'sha256=' } },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(async () => 'shhh'), store: store as any,
      agentId: 'agt_a', routinePath: row.path, fire,
    });
    const body = Buffer.from('{"x":1}');
    const sig = 'sha256=' + createHmac('sha256', 'shhh').update(body).digest('hex');
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': sig },
      body,
    }), res);
    await new Promise(r => setImmediate(r));
    expect(res._calls.status).toBe(202);
    expect(fire).toHaveBeenCalled();
  });

  it('verifies sha1 HMAC when algorithm: sha1', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'ok', conversationId: 'c1', error: null });
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha1' } },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(async () => 'shhh'), store: store as any,
      agentId: 'agt_a', routinePath: row.path, fire,
    });
    const body = Buffer.from('{}');
    const sig = createHmac('sha1', 'shhh').update(body).digest('hex');
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': sig },
      body,
    }), res);
    await new Promise(r => setImmediate(r));
    expect(res._calls.status).toBe(202);
  });

  it('returns 400 on malformed JSON', async () => {
    const fire = vi.fn();
    const row = makeRow();
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({ body: Buffer.from('not json{') }), res);
    expect(res._calls.status).toBe(400);
    expect(fire).not.toHaveBeenCalled();
  });

  it('returns 415 on unsupported Content-Type', async () => {
    const fire = vi.fn();
    const row = makeRow();
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'text/plain' }, body: Buffer.from('hi'),
    }), res);
    expect(res._calls.status).toBe(415);
    expect(fire).not.toHaveBeenCalled();
  });

  it('parses application/x-www-form-urlencoded body', async () => {
    let captured: unknown;
    const fire = vi.fn().mockImplementation(async (_r, _s, p) => {
      captured = p;
      return { status: 'ok', conversationId: 'c1', error: null };
    });
    const row = makeRow();
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.from('foo=bar&n=1'),
    }), res);
    await new Promise(r => setImmediate(r));
    expect(res._calls.status).toBe(202);
    expect(captured).toEqual({ foo: 'bar', n: '1' });
  });

  it('returns 204 when events filter mismatches X-GitHub-Event', async () => {
    const fire = vi.fn();
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r', events: ['pull_request'] },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: Buffer.from('{}'),
    }), res);
    expect(res._calls.status).toBe(204);
    expect(fire).not.toHaveBeenCalled();
  });

  it('ignores events filter when X-GitHub-Event header is absent', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'ok', conversationId: 'c1', error: null });
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r', events: ['pull_request'] },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(), store: store as any, agentId: 'agt_a',
      routinePath: row.path, fire,
    });
    const res = makeRes();
    await handler(makeReq({ body: Buffer.from('{}') }), res);
    await new Promise(r => setImmediate(r));
    expect(res._calls.status).toBe(202);
  });

  it('matches HMAC when prefix is omitted (header is bare hex)', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'ok', conversationId: 'c1', error: null });
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256' } },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({
      bus: makeBus(async () => 'shhh'), store: store as any,
      agentId: 'agt_a', routinePath: row.path, fire,
    });
    const body = Buffer.from('{}');
    const sig = createHmac('sha256', 'shhh').update(body).digest('hex');
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': sig },
      body,
    }), res);
    await new Promise(r => setImmediate(r));
    expect(res._calls.status).toBe(202);
  });
});

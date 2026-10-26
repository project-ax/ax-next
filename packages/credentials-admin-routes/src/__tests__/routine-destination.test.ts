import { describe, expect, it } from 'vitest';
import { HookBus, SafeToolError } from '@ax/core';
import { createDestinationHandlers } from '../destination-routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';
const destination = {
  kind: 'routine-hmac',
  agentId: 'a',
  routineId: 'rtn_opaque',
};
const base = {
  destination,
  scope: 'agent',
  ownerId: 'a',
  expectedRevision: 'rev1',
};
function req(body: unknown): RouteRequest {
  return {
    headers: {},
    cookies: {},
    query: {},
    params: { destinationKind: 'routine-hmac' },
    signedCookie: () => null,
    body: Buffer.from(JSON.stringify(body)),
  };
}
function response() {
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(n) {
      status = n;
      return res;
    },
    json(v) {
      body = v;
    },
    text(v) {
      body = v;
    },
    end() {},
  };
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}
function setup(admin = true, failure?: Error, acknowledgment?: { value: unknown }) {
  const bus = new HookBus();
  const calls: unknown[] = [];
  bus.registerService('auth:require-user', 'test', async () => ({
    user: { id: 'human', isAdmin: admin },
  }));
  bus.registerService(
    'routines:set-webhook-secret',
    'test',
    async (ctx, input) => {
      calls.push({ ctx: { agentId: ctx.agentId, userId: ctx.userId }, input });
      if (failure) throw failure;
      return acknowledgment ? acknowledgment.value : { saved: true };
    },
  );
  for (const hook of ['credentials:set', 'credentials:delete'])
    bus.registerService(hook, 'test', async () => {
      throw new Error('routine vault bypass');
    });
  return { h: createDestinationHandlers({ bus }), calls };
}
describe('human routine secret destinations', () => {
  it('routes set and delete through revision-fenced service with real identity', async () => {
    const { h, calls } = setup();
    const set = response();
    await h.create(
      req({ ...base, kind: 'api-key', payloadB64: 'c2VjcmV0' }),
      set.res,
    );
    expect(set.status).toBe(204);
    const del = response();
    await h.destroy(req(base), del.res);
    expect(del.status).toBe(204);
    expect(calls).toEqual([
      {
        ctx: { agentId: 'a', userId: 'human' },
        input: {
          agentId: 'a',
          routineId: 'rtn_opaque',
          expectedRevision: 'rev1',
          operation: 'set',
          secret: new Uint8Array(Buffer.from('secret')),
        },
      },
      {
        ctx: { agentId: 'a', userId: 'human' },
        input: {
          agentId: 'a',
          routineId: 'rtn_opaque',
          expectedRevision: 'rev1',
          operation: 'delete',
        },
      },
    ]);
  });
  it.each(['set', 'delete'] as const)(
    'rejects malformed %s acknowledgments without reflecting provider output',
    async (operation) => {
      for (const value of [
        undefined,
        {},
        { saved: false },
        { saved: 'SECRET' },
        { saved: true, extra: 'SECRET' },
        { saved: true, revision: 'SECRET' },
      ]) {
        const { h, calls } = setup(true, undefined, { value });
        const r = response();
        if (operation === 'set')
          await h.create(req({ ...base, kind: 'api-key', payloadB64: 'YQ==' }), r.res);
        else await h.destroy(req(base), r.res);
        expect(calls).toHaveLength(1);
        expect(r.status).toBe(503);
        expect(r.body).toEqual({
          code: 'unavailable',
          error: 'Routine management is temporarily unavailable.',
        });
        expect(JSON.stringify(r.body)).not.toContain('SECRET');
      }
    },
  );

  it('retains the admin gate while forwarding authenticated settings writes to routine authority', async () => {
    const { h, calls } = setup(false);
    const r = response();
    await h.create(
      req({ ...base, kind: 'api-key', payloadB64: 'YQ==' }),
      r.res,
    );
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
    const settings = response();
    await h.createSettings(
      req({ ...base, kind: 'api-key', payloadB64: 'YQ==' }),
      settings.res,
    );
    expect(settings.status).toBe(204);
    expect(calls).toEqual([{ ctx: { agentId: 'a', userId: 'human' }, input: {
      agentId: 'a', routineId: 'rtn_opaque', expectedRevision: 'rev1', operation: 'set', secret: new Uint8Array(Buffer.from('a')),
    } }]);
  });
  it('rejects scope, owner, ref, colon and legacy path forgery before any secret call', async () => {
    for (const extra of [
      { scope: 'global', ownerId: null },
      { scope: 'user', ownerId: 'human' },
      { ownerId: 'other' },
      { ref: 'provider:anthropic' },
      { destination: { ...destination, routineId: 'rtn:a' } },
      { destination: { ...destination, agentId: 'a:b' } },
      {
        destination: {
          kind: 'routine-hmac',
          agentId: 'a',
          routinePath: '.ax/routines/a.md',
        },
      },
      { expectedRevision: undefined },
    ]) {
      const { h, calls } = setup();
      const r = response();
      await h.create(
        req({ ...base, kind: 'api-key', payloadB64: 'YQ==', ...extra }),
        r.res,
      );
      expect(r.status).toBe(400);
      expect(calls).toEqual([]);
    }
  });
  it('accepts the bounded maximum decoded secret without returning its bytes', async () => {
    const {h,calls}=setup(); const r=response(); await h.create(req({...base,kind:'api-key',payloadB64:Buffer.alloc(65536,65).toString('base64')}),r.res);
    expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect((calls[0] as {input:{secret:Uint8Array}}).input.secret.byteLength).toBe(65536);
  });

  it('maps stale/deleted/cleanup-pending forms without leaking secret-bearing exception text', async () => {
    for (const [code, status] of [
      ['revision-conflict', 409],
      ['not-found', 404],
      ['cleanup-pending', 409],
    ] as const) {
      const error = new SafeToolError(code, 'expectedRevision');
      error.message = 'SECRET';
      const { h } = setup(true, error);
      for (const handler of [h.create, h.destroy]) {
        const r = response();
        await handler(
          req({
            ...base,
            ...(handler === h.create
              ? { kind: 'api-key', payloadB64: 'YQ==' }
              : {}),
          }),
          r.res,
        );
        expect(r.status).toBe(status);
        expect(r.body).toMatchObject({ code, field: 'expectedRevision' });
        expect(JSON.stringify(r.body)).not.toContain('SECRET');
      }
    }
  });
  it('bounds decoded routine secret bytes and never accepts expectedRevision for another family', async () => {
    const { h, calls } = setup();
    const r = response();
    await h.create(
      req({
        ...base,
        kind: 'api-key',
        payloadB64: Buffer.alloc(65537).toString('base64'),
      }),
      r.res,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
    const foreign = response();
    await h.create(
      {
        ...req({
          ...base,
          destination: { kind: 'skill-slot', skillId: 's', slot: 'S' },
          kind: 'api-key',
          payloadB64: 'YQ==',
        }),
        params: { destinationKind: 'skill-slot' },
      },
      foreign.res,
    );
    expect(foreign.status).toBe(400);
  });
  it('does not reflect unrecognized secret-bearing field names', async () => {
    const { h } = setup();
    const r = response();
    await h.create(
      req({ ...base, kind: 'api-key', payloadB64: 'YQ==', SECRET_FIELD: true }),
      r.res,
    );
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
  });
});

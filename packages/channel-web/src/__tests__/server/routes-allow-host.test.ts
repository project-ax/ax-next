import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { makeAllowHostHandler } from '../../server/routes-allow-host.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import { expectLoggedRequireUserFault, faultInitCtx, storeFault } from './require-user-fault.js';

// --- minimal fakes -------------------------------------------------------

function fakeReq(opts: { body?: Buffer } = {}): RouteRequest {
  return {
    headers: {},
    body: opts.body ?? Buffer.alloc(0),
    cookies: {},
    query: {},
    params: {},
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}

function fakeRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(_s: string) {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

const initCtx = makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'system' });

describe('POST /api/chat/allow-host', () => {
  it('calls proxy:add-host with the AUTHENTICATED user ctx (never the browser-supplied id)', async () => {
    const calls: Array<{ ctx: AgentContext; input: unknown }> = [];
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('proxy:add-host', 'proxy', async (ctx, input) => {
      calls.push({ ctx, input });
      return { added: true };
    });
    const handler = makeAllowHostHandler({ bus, initCtx });

    const { res, captured } = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'status.example.com' })) }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ added: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ctx.userId).toBe('u1'); // host-side identity, not browser-supplied
    expect(calls[0]?.input).toEqual({ sessionId: 's1', host: 'status.example.com' });
  });

  it('returns 401 when unauthenticated', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no' });
    });
    const handler = makeAllowHostHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from('{"sessionId":"s1","host":"h"}') }),
      res,
    );
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
  });

  it('a session-store fault is a logged 500, not a 401 (TASK-1030)', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => {
      throw storeFault();
    });
    const { ctx, logger } = faultInitCtx();
    const handler = makeAllowHostHandler({ bus, initCtx: ctx });
    const { res, captured } = fakeRes();
    await handler(fakeReq({ body: Buffer.from('{"sessionId":"s1","host":"h"}') }), res);
    expectLoggedRequireUserFault(logger, 'host_grant_require_user_failed', {
      status: captured.statusCode,
      body: captured.body,
    });
  });

  it('returns 400 on a malformed body', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    const handler = makeAllowHostHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await handler(fakeReq({ body: Buffer.from('not json') }), res);
    expect(captured.statusCode).toBe(400);
  });

  it('maps proxy forbidden → 403 and invalid-host → 400', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    let mode: 'forbidden' | 'invalid-host' = 'forbidden';
    bus.registerService('proxy:add-host', 'proxy', async () => {
      throw new PluginError({ code: mode, plugin: 'proxy', message: mode });
    });
    const handler = makeAllowHostHandler({ bus, initCtx });

    const r1 = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'h.example.com' })) }),
      r1.res,
    );
    expect(r1.captured.statusCode).toBe(403);

    mode = 'invalid-host';
    const r2 = fakeRes();
    await handler(
      fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'h.example.com' })) }),
      r2.res,
    );
    expect(r2.captured.statusCode).toBe(400);
  });
});

// --- "Always for this agent" (TASK-44; TASK-1212) ---------------------------

interface WarnLogger extends Logger {
  warns: Array<{ event: string; fields: Record<string, unknown> | undefined }>;
}

/** Records `warn` calls — the level a failed keep is logged at. */
function warnLogger(): WarnLogger {
  const warns: WarnLogger['warns'] = [];
  const logger: WarnLogger = {
    warns,
    debug: () => {},
    info: () => {},
    warn: (event, fields) => {
      warns.push({ event, fields });
    },
    error: () => {},
    child: () => logger,
  };
  return logger;
}

type LiveAnswer = { added: boolean; agentId?: string };

/**
 * The world an "Always" click lands in: signed in as `u1`, the proxy answering
 * `live` for the session, `agents:resolve` admitting `u1` unless `resolve`
 * says otherwise, and `host-grants:grant` keeping the site unless `grant` says
 * otherwise (`'absent'` = a preset without @ax/host-grants). Every call each
 * hook receives is recorded.
 */
function keepWorld(opts: {
  live: LiveAnswer | (() => Promise<LiveAnswer>);
  resolve?: () => Promise<unknown>;
  grant?: (() => Promise<unknown>) | 'absent';
}) {
  const addHosts: unknown[] = [];
  const resolves: unknown[] = [];
  const grants: unknown[] = [];
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'auth', async () => ({
    user: { id: 'u1', isAdmin: false },
  }));
  const live = opts.live;
  bus.registerService('proxy:add-host', 'proxy', async (_ctx, input) => {
    addHosts.push(input);
    return typeof live === 'function' ? live() : live;
  });
  const resolve = opts.resolve;
  bus.registerService('agents:resolve', 'agents', async (_ctx, input) => {
    resolves.push(input);
    if (resolve !== undefined) return resolve();
    return { agent: { id: (input as { agentId: string }).agentId, visibility: 'team' } };
  });
  const grant = opts.grant;
  if (grant !== 'absent') {
    bus.registerService('host-grants:grant', 'hg', async (_ctx, input) => {
      grants.push(input);
      return grant !== undefined ? grant() : { created: true };
    });
  }
  const logger = warnLogger();
  const handler = makeAllowHostHandler({
    bus,
    initCtx: makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'system', logger }),
  });
  return { handler, addHosts, resolves, grants, logger };
}

async function post(
  handler: ReturnType<typeof makeAllowHostHandler>,
  body: unknown,
): Promise<CapturedRes> {
  const { res, captured } = fakeRes();
  await handler(fakeReq({ body: Buffer.from(JSON.stringify(body)) }), res);
  return captured;
}

/** A refusal whose message names the host, so a log that copies it is caught. */
function pluginError(code: string): PluginError {
  return new PluginError({ code, plugin: 'test', message: `${code} for x.example.com` });
}

describe('"Always for this agent" keeps the site on the agent (TASK-44, TASK-1212)', () => {
  it("a live Always keeps it on the proxy's agent, never the body's", async () => {
    const w = keepWorld({ live: { added: true, agentId: 'agent-7' } });
    const out = await post(w.handler, {
      sessionId: 's1',
      host: 'x.example.com',
      persist: true,
      agentId: 'agent-someone-elses',
    });
    expect(out.statusCode).toBe(200);
    // agentId never reaches the browser (fork #2).
    expect(out.body).toStrictEqual({ added: true, kept: true });
    // The key is server-authoritative: the person from auth, the agent from the
    // proxy's own SessionConfig.
    expect(w.grants).toEqual([{ ownerUserId: 'u1', agentId: 'agent-7', host: 'x.example.com' }]);
    // The access check is about the proxy's agent too; the body's is never looked up.
    expect(w.resolves).toEqual([{ agentId: 'agent-7', userId: 'u1' }]);
  });

  it.each([
    ['forbidden', 'forbidden'],
    ['not-found', 'not-found'],
    ['a fault', 'unknown'],
  ])(
    'a live Always on an agent the person can no longer use (%s) keeps nothing',
    async (_label, code) => {
      // A session can outlive its owner's access — e.g. removed from the team
      // mid-session. The live widen stands; the agent's list is not touched.
      const w = keepWorld({
        live: { added: true, agentId: 'agent-7' },
        resolve: async () => {
          if (code === 'unknown') throw new Error('agents store down');
          throw pluginError(code);
        },
      });
      const out = await post(w.handler, {
        sessionId: 's1',
        host: 'x.example.com',
        persist: true,
        agentId: 'agent-7',
      });
      expect(out.statusCode).toBe(200);
      expect(out.body).toStrictEqual({ added: true, kept: false });
      expect(w.grants).toEqual([]);
      expect(w.logger.warns).toEqual([{ event: 'host_grant_persist_failed', fields: { code } }]);
      expect(JSON.stringify(w.logger.warns)).not.toContain('x.example.com');
    },
  );

  it('Always on an ended session keeps the site for an agent the person can use, and says kept', async () => {
    const w = keepWorld({ live: { added: false } });
    const out = await post(w.handler, {
      sessionId: 's-gone',
      host: 'x.example.com',
      persist: true,
      agentId: 'agent-7',
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toStrictEqual({ added: false, kept: true });
    // The ACL is asked about exactly the body's agent, for the AUTHENTICATED person.
    expect(w.resolves).toEqual([{ agentId: 'agent-7', userId: 'u1' }]);
    expect(w.grants).toEqual([{ ownerUserId: 'u1', agentId: 'agent-7', host: 'x.example.com' }]);
  });

  it('a site the agent already has still says kept', async () => {
    const w = keepWorld({ live: { added: false }, grant: async () => ({ created: false }) });
    const out = await post(w.handler, {
      sessionId: 's-gone',
      host: 'x.example.com',
      persist: true,
      agentId: 'agent-7',
    });
    expect(out.body).toStrictEqual({ added: false, kept: true });
  });

  it.each([
    ['forbidden', 'forbidden'],
    ['not-found', 'not-found'],
    ['a fault', 'unknown'],
  ])(
    "Always on an ended session for an agent they can't use (%s) keeps nothing, with the same answer",
    async (_label, code) => {
      const w = keepWorld({
        live: { added: false },
        resolve: async () => {
          // A raw throw is what a crashing store does; the bus wraps it as 'unknown'.
          if (code === 'unknown') throw new Error('agents store down');
          throw pluginError(code);
        },
      });
      const out = await post(w.handler, {
        sessionId: 's-gone',
        host: 'x.example.com',
        persist: true,
        agentId: 'agent-9',
      });
      // One answer for "no such agent", "not yours" and a fault: no existence oracle.
      expect(out.statusCode).toBe(200);
      expect(out.body).toStrictEqual({ added: false, kept: false });
      expect(w.grants).toEqual([]);
      expect(w.logger.warns).toEqual([{ event: 'host_grant_persist_failed', fields: { code } }]);
    },
  );

  it('an ended Always with no agentId keeps nothing', async () => {
    const w = keepWorld({ live: { added: false } });
    const out = await post(w.handler, { sessionId: 's-gone', host: 'x.example.com', persist: true });
    expect(out.statusCode).toBe(200);
    expect(out.body).toStrictEqual({ added: false, kept: false });
    expect(w.resolves).toEqual([]);
    expect(w.grants).toEqual([]);
  });

  it.each([
    ['live', { added: true, agentId: 'agent-7' }, { added: true, kept: false, full: true }],
    ['ended', { added: false }, { added: false, kept: false, full: true }],
  ])(
    'at the cap (%s): kept false and full; the log has the code and never the host',
    async (_label, live, answer) => {
      const w = keepWorld({
        live,
        grant: async () => {
          throw pluginError('grant-limit');
        },
      });
      const out = await post(w.handler, {
        sessionId: 's1',
        host: 'x.example.com',
        persist: true,
        agentId: 'agent-7',
      });
      expect(out.statusCode).toBe(200);
      expect(out.body).toStrictEqual(answer);
      expect(w.logger.warns).toEqual([
        { event: 'host_grant_persist_failed', fields: { code: 'grant-limit' } },
      ]);
      expect(JSON.stringify(w.logger.warns)).not.toContain('x.example.com');
    },
  );

  it('another save failure: kept false, still 200', async () => {
    // The live widen already applied, so the site works for THIS session; a
    // failed keep is said, never turned into a 500.
    const w = keepWorld({
      live: { added: true, agentId: 'agent-7' },
      grant: async () => {
        throw new Error('pg down while saving x.example.com');
      },
    });
    const out = await post(w.handler, { sessionId: 's1', host: 'x.example.com', persist: true });
    expect(out.statusCode).toBe(200);
    expect(out.body).toStrictEqual({ added: true, kept: false });
    expect(w.logger.warns).toEqual([
      { event: 'host_grant_persist_failed', fields: { code: 'unknown' } },
    ]);
  });

  it('without @ax/host-grants, Always still answers 200 and says nothing was kept', async () => {
    const cases: Array<[LiveAnswer, unknown]> = [
      [{ added: true, agentId: 'agent-7' }, { added: true, kept: false }],
      [{ added: false }, { added: false, kept: false }],
    ];
    for (const [live, answer] of cases) {
      const w = keepWorld({ live, grant: 'absent' });
      const out = await post(w.handler, {
        sessionId: 's1',
        host: 'x.example.com',
        persist: true,
        agentId: 'agent-7',
      });
      expect(out.statusCode).toBe(200);
      expect(out.body).toStrictEqual(answer);
      expect(w.resolves).toEqual([]);
    }
  });

  it('a refused live widen (forbidden, invalid-host) keeps nothing, whatever agent the body names', async () => {
    // A forged sessionId for someone else's LIVE session is refused by the
    // proxy. It must not fall through to the ended-session keep, which would
    // otherwise trust the body's agentId.
    for (const code of ['forbidden', 'invalid-host'] as const) {
      const w = keepWorld({
        live: async () => {
          throw pluginError(code);
        },
      });
      const out = await post(w.handler, {
        sessionId: 's-theirs',
        host: 'x.example.com',
        persist: true,
        agentId: 'agent-7',
      });
      expect(out.statusCode).toBe(code === 'forbidden' ? 403 : 400);
      expect(w.resolves).toEqual([]);
      expect(w.grants).toEqual([]);
    }
  });

  it.each([[''], ['x'.repeat(129)], [42]])(
    'an agentId that is not a 1–128 character string is a 400 (%j)',
    async (agentId) => {
      const w = keepWorld({ live: { added: false } });
      const out = await post(w.handler, {
        sessionId: 's1',
        host: 'x.example.com',
        persist: true,
        agentId,
      });
      expect(out.statusCode).toBe(400);
      expect(out.body).toEqual({ error: 'invalid-body' });
      expect(w.addHosts).toEqual([]);
      expect(w.grants).toEqual([]);
    },
  );

  it('Just this once answers { added } only, and keeps and looks up nothing', async () => {
    const cases: Array<[LiveAnswer, boolean | undefined]> = [
      [{ added: true, agentId: 'agent-7' }, undefined],
      [{ added: true, agentId: 'agent-7' }, false],
      [{ added: false }, false],
    ];
    for (const [live, persist] of cases) {
      const w = keepWorld({ live });
      const out = await post(w.handler, {
        sessionId: 's1',
        host: 'x.example.com',
        ...(persist === undefined ? {} : { persist }),
        agentId: 'agent-7',
      });
      expect(out.statusCode).toBe(200);
      expect(out.body).toStrictEqual({ added: live.added });
      expect(w.resolves).toEqual([]);
      expect(w.grants).toEqual([]);
    }
  });
});

// --- TASK-1246: a shared agent's "Always" stays session-only -----------------

describe('"Always for this agent" on a shared personal agent (TASK-1246)', () => {
  /** agents:resolve's answer for someone a personal agent is shared with. */
  const sharee = async () => ({
    agent: { id: 'agent-7', visibility: 'personal', isOwner: false },
  });
  /** …and for one of its owners. */
  const owner = async () => ({
    agent: { id: 'agent-7', visibility: 'personal', isOwner: true },
  });

  it("a sharee's live Always widens the session only: kept false, nothing kept on the owner's agent", async () => {
    const w = keepWorld({ live: { added: true, agentId: 'agent-7' }, resolve: sharee });
    const out = await post(w.handler, {
      sessionId: 's1',
      host: 'x.example.com',
      persist: true,
      agentId: 'agent-7',
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toStrictEqual({ added: true, kept: false });
    // The session-only widen still happened, for exactly this session and host.
    expect(w.addHosts).toEqual([{ sessionId: 's1', host: 'x.example.com' }]);
    // The owner's agent is untouched.
    expect(w.grants).toEqual([]);
    expect(w.resolves).toEqual([{ agentId: 'agent-7', userId: 'u1' }]);
  });

  it("an owner's live Always still keeps the site on their agent", async () => {
    const w = keepWorld({ live: { added: true, agentId: 'agent-7' }, resolve: owner });
    const out = await post(w.handler, { sessionId: 's1', host: 'x.example.com', persist: true });
    expect(out.statusCode).toBe(200);
    expect(out.body).toStrictEqual({ added: true, kept: true });
    expect(w.grants).toEqual([{ ownerUserId: 'u1', agentId: 'agent-7', host: 'x.example.com' }]);
  });

  it("a team agent's Always is unchanged: kept for anyone agents:resolve admits", async () => {
    const lives: LiveAnswer[] = [{ added: true, agentId: 'agent-t' }, { added: false }];
    for (const live of lives) {
      const w = keepWorld({
        live,
        resolve: async () => ({ agent: { id: 'agent-t', visibility: 'team', isOwner: false } }),
      });
      const out = await post(w.handler, {
        sessionId: 's1',
        host: 'x.example.com',
        persist: true,
        agentId: 'agent-t',
      });
      expect(out.body).toStrictEqual({ added: live.added, kept: true });
      expect(w.grants).toEqual([{ ownerUserId: 'u1', agentId: 'agent-t', host: 'x.example.com' }]);
    }
  });

  it("an ended Always naming a personal agent the person doesn't own keeps nothing", async () => {
    // The ended case's id is the browser's word. A personal agent that is only
    // shared with the person is never written to from here.
    const w = keepWorld({ live: { added: false }, resolve: sharee });
    const out = await post(w.handler, {
      sessionId: 's-gone',
      host: 'x.example.com',
      persist: true,
      agentId: 'agent-7',
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toStrictEqual({ added: false, kept: false });
    expect(w.resolves).toEqual([{ agentId: 'agent-7', userId: 'u1' }]);
    expect(w.grants).toEqual([]);
  });

  it.each([
    ['no answer', undefined],
    ['no agent', {}],
    ['a null agent', { agent: null }],
    ['personal, isOwner missing', { agent: { id: 'agent-7', visibility: 'personal' } }],
    [
      'personal, isOwner not a boolean',
      { agent: { id: 'agent-7', visibility: 'personal', isOwner: 'yes' } },
    ],
    ['no visibility', { agent: { id: 'agent-7', isOwner: true } }],
    ['an unknown visibility', { agent: { id: 'agent-7', visibility: 'org', isOwner: true } }],
  ])('a malformed agents:resolve answer (%s) keeps nothing', async (_label, answer) => {
    const w = keepWorld({ live: { added: true, agentId: 'agent-7' }, resolve: async () => answer });
    const out = await post(w.handler, { sessionId: 's1', host: 'x.example.com', persist: true });
    expect(out.statusCode).toBe(200);
    expect(out.body).toStrictEqual({ added: true, kept: false });
    expect(w.grants).toEqual([]);
  });
});

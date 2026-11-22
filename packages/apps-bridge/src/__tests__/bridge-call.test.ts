import { CallResponseSchema, GrantsResponseSchema, REFUSAL_STATUS, RefusalSchema } from '@ax/apps-bridge-contract';
import { PluginError, ownerlessIdFor, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it, vi } from 'vitest';
import { GRANTS_BODY_BUDGET_BYTES, answerCall, answerClaim, answerGrants, type BridgeAnswer, type BridgeDeps } from '../bridge-call.js';
import { LINK_CODE_TTL_MS, hashLinkCode, newLinkCode } from '../link-codes.js';
import type { ViewerVerdict } from '../verify-token.js';
import { createFakeStore, type FakeStore } from './support/fake-store.js';

/*
  The claim, call and grants answers over a fake bus (it records every
  { hook, ctx, input }) and the in-memory store. Each refusal is checked for
  its status and code, and a refused call is checked to never reach
  `connectors:call-tool-result`.
*/

const P = 'canopy';
const APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const APP2 = 'app_02OTHER';
const CONN = 'linear';
const NS = 'c0123456789';
const NS_GITHUB = 'cabcdefabcd';
const TOOL = 'list_issues';
const KEY = `mcp.${NS}.${TOOL}`;
const KEY_CREATE = `mcp.${NS}.create_issue`;
const LINKER = 'usr_ada';
const AGENT = 'agt_support';
const VIEWER = 'usr_vic';
const VIEWER_AGENT = 'agt_vic';
const TEAM_AGENT = 'agt_team';
const BOB_AGENT = 'agt_bob';
const VIEWER_EMAIL = 'vic.secret-email@example.test';
const ASSERTION = 'eyJhbGciOiJSUzI1NiJ9.SECRET-ASSERTION.sig';
const ORIGIN = 'https://ax.test';
const APPROVE_URL = 'https://ax.test/apps/approve/canopy/app_01JDZ8M5Q4X7RT3VKF0N2C9H6B/linear';
const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const SECRET_INPUT = 'SECRET-INPUT-VALUE';
const CONTENT = [{ type: 'text', text: 'SECRET-CONTENT issue list' }];
const SUCCEEDED = { outcome: 'succeeded', content: CONTENT };

type AgentRow = {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  connectorAttachments: string[];
  connectorExclusions: string[];
};
const AGENTS: Record<string, AgentRow> = {
  [AGENT]: agentRow(AGENT, LINKER, 'user'),
  [VIEWER_AGENT]: agentRow(VIEWER_AGENT, VIEWER, 'user'),
  [TEAM_AGENT]: agentRow(TEAM_AGENT, 'team_eng', 'team'),
  [BOB_AGENT]: agentRow(BOB_AGENT, 'usr_bob', 'user'),
};
function agentRow(id: string, ownerId: string, ownerType: 'user' | 'team'): AgentRow {
  return {
    id,
    ownerId,
    ownerType,
    visibility: ownerType === 'user' ? 'personal' : 'team',
    displayName: `Agent ${id}`,
    connectorAttachments: [CONN],
    connectorExclusions: [],
  };
}

interface Recorded { hook: string; ctx: AgentContext; input: unknown }
// `never` input: each fake handler names the payload it reads.
type Handler = (ctx: AgentContext, input: never) => unknown;
interface Line { level: string; msg: string; bindings: Record<string, unknown> | undefined }

function capturingLogger(lines: Line[]): Logger {
  const at = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    lines.push({ level, msg, bindings });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  return logger;
}

const pluginError = (code: string) => new PluginError({ code, plugin: 'fake', message: `fake ${code}: SECRET-MESSAGE` });

function defaultHandlers(): Record<string, Handler> {
  return {
    'agents:can-manage-connectors': () => ({ allowed: true }),
    // Any agent resolves for a user in this fake (team membership included);
    // the bridge itself decides what a viewer may borrow.
    'agents:resolve': (_ctx, input: { agentId: string }) => {
      const agent = AGENTS[input.agentId];
      if (agent === undefined) throw pluginError('not-found');
      return { agent };
    },
    // Both connectors reach every agent in this fake, each with its own namespace.
    'connectors:list-effective': () => ({
      connectors: [
        { summary: { id: CONN, name: 'Linear' }, source: 'attached', toolNamespaces: [{ toolNamespace: NS, server: 'main' }] },
        { summary: { id: 'github', name: 'GitHub' }, source: 'attached', toolNamespaces: [{ toolNamespace: NS_GITHUB, server: 'main' }] },
      ],
    }),
    'tool-policy:evaluate': () => ({ verdict: 'allow', ruleId: null, capability: null, irreversible: false, effect: [] }),
    'connectors:call-tool-result': () => SUCCEEDED,
    'auth:find-user-by-email': (_ctx, input: { email: string }) => (input.email === VIEWER_EMAIL ? { userId: VIEWER } : null),
    'connectors:list': () => ({
      connectors: [
        { id: 'github', name: 'GitHub', description: 'SECRET-DESC' },
        { id: CONN, name: 'Linear', description: '' },
      ],
    }),
    'connectors:describe-tools': (_ctx, input: { connectorId: string }) => ({
      status: 'ok',
      checkedAt: new Date(NOW).toISOString(),
      tools: INVENTORY[input.connectorId] ?? [],
    }),
  };
}

const LIST_SCHEMA = { type: 'object', properties: { team: { type: 'string' } } };
const INVENTORY: Record<string, unknown[]> = {
  [CONN]: [
    { name: 'create_issue', title: 'Create', description: 'Make an issue', readOnly: false, outward: true, inputSchema: null, toolKey: KEY_CREATE },
    { name: TOOL, title: 'List', description: 'List issues', readOnly: true, outward: false, inputSchema: LIST_SCHEMA, toolKey: KEY },
    { name: 'other', title: 'Other', description: 'Not granted', readOnly: true, outward: false, inputSchema: null, toolKey: `mcp.${NS}.other` },
  ],
  github: [
    { name: 'search', title: 'Search', description: 'Search code', readOnly: true, outward: false, inputSchema: { type: 'object' }, toolKey: 'mcp.cabcdefabcd.search' },
  ],
};

function harness(opts: { handlers?: Record<string, Handler>; verdict?: () => Promise<ViewerVerdict>; takeApp?: () => boolean } = {}) {
  const store: FakeStore = createFakeStore();
  const calls: Recorded[] = [];
  const lines: Line[] = [];
  const handlers: Record<string, Handler> = { ...defaultHandlers(), ...opts.handlers };
  const verifyViewer = vi.fn(async (assertion: string): Promise<ViewerVerdict> => {
    void assertion;
    return opts.verdict !== undefined ? opts.verdict() : { ok: true, email: VIEWER_EMAIL };
  });
  const takeApp = vi.fn(opts.takeApp ?? (() => true));
  const deps: BridgeDeps = {
    bus: {
      async call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> {
        calls.push({ hook, ctx, input });
        const h = handlers[hook];
        if (h === undefined) throw pluginError('no-service');
        return (await h(ctx, input as never)) as O;
      },
    },
    store,
    platformId: P,
    publicOrigin: ORIGIN,
    verifyViewer,
    limiter: { takeApp },
    logger: capturingLogger(lines),
    now: () => NOW,
  };
  const hooks = () => calls.map((c) => c.hook);
  const callOf = (hook: string) => calls.find((c) => c.hook === hook);
  return { deps, store, calls, lines, handlers, verifyViewer, takeApp, hooks, callOf };
}
type H = ReturnType<typeof harness>;

async function mint(h: H, opts: { userId?: string; agentId?: string; expiresAt?: number } = {}): Promise<string> {
  const code = newLinkCode();
  await h.store.mintLinkCode({
    codeHash: hashLinkCode(code),
    userId: opts.userId ?? LINKER,
    agentId: opts.agentId ?? AGENT,
    expiresAt: new Date(opts.expiresAt ?? NOW + LINK_CODE_TTL_MS),
    now: new Date(NOW - 1000),
  });
  return code;
}

async function link(h: H, appId = APP): Promise<void> {
  const code = await mint(h);
  const r = await h.store.claimLinkCode({ codeHash: hashLinkCode(code), platformId: P, appId, appName: 'Support desk', now: new Date(NOW) });
  expect(r.result).toBe('linked');
}

async function grant(h: H, mode: 'builder' | 'viewer', toolKeys: string[] = [KEY, KEY_CREATE], connectorId = CONN): Promise<void> {
  const r = await h.store.putGrant({ platformId: P, appId: APP, connectorId, mode, toolKeys });
  expect(r).not.toBe('no-link');
}

async function approve(h: H, toolKeys: string[] = [KEY], agentId = VIEWER_AGENT): Promise<void> {
  expect(await h.store.putApproval({ viewerUserId: VIEWER, platformId: P, appId: APP, connectorId: CONN, agentId, toolKeys })).toBe('saved');
}

const builderBody = (over: Record<string, unknown> = {}) => ({
  appId: APP,
  connectorId: CONN,
  tool: TOOL,
  mode: 'builder',
  input: { team: 'eng', note: SECRET_INPUT },
  ...over,
});
const viewerBody = (over: Record<string, unknown> = {}) => builderBody({ mode: 'viewer', viewerAssertion: ASSERTION, ...over });

function expectRefusal(a: BridgeAnswer, code: keyof typeof REFUSAL_STATUS, retryAfterSeconds?: number): void {
  expect(a.status).toBe(REFUSAL_STATUS[code]);
  expect((a.body as { code?: string }).code).toBe(code);
  // Every refusal is a contract-v1 body.
  expect(RefusalSchema.safeParse(a.body).success).toBe(true);
  if (code !== 'viewer_approval_required') expect(a.body).toEqual({ code });
  expect(a.retryAfterSeconds).toBe(retryAfterSeconds);
  expect(a.log.outcome).toBe(code);
}

// ---------------------------------------------------------------------------
// POST /links/claim
// ---------------------------------------------------------------------------

describe('answerClaim', () => {
  it("claim: a fresh code links the app to the code's person and agent, with the normalized name", async () => {
    const h = harness();
    const code = await mint(h);
    const a = await answerClaim(h.deps, { appId: APP, appName: '  Support\u0007   desk\u202e ', code });
    expect(a).toEqual({ status: 200, body: { appId: APP }, log: { appId: APP, outcome: 'linked' } });
    const linked = await h.store.getLink(P, APP);
    expect(linked).toMatchObject({ platformId: P, appId: APP, agentId: AGENT, linkedByUserId: LINKER, appName: 'Support desk' });
    // The minter's rights were asked as the minter, never as an admin.
    expect(h.hooks()).toEqual(['agents:can-manage-connectors']);
    const ask = h.callOf('agents:can-manage-connectors');
    expect(ask?.input).toEqual({ agentId: AGENT, actor: { userId: LINKER, isAdmin: false } });
    expect(ask?.ctx.userId).toBe(LINKER);
    expect(ask?.ctx.agentId).toBe(AGENT);
    // The code is burned.
    expect(await h.store.peekLinkCode(hashLinkCode(code), new Date(NOW))).toBeNull();
  });

  type ClaimCase = [name: string, arrange: (h: H) => Promise<unknown>, code: keyof typeof REFUSAL_STATUS];
  const CLAIM_REFUSALS: ClaimCase[] = [
    ['a body that is not an object is invalid_request', async () => 'nope', 'invalid_request'],
    ['a body with no code is invalid_request', async () => ({ appId: APP, appName: 'Desk' }), 'invalid_request'],
    ['a body with an extra key is invalid_request', async (h) => ({ appId: APP, appName: 'Desk', code: await mint(h), extra: 1 }), 'invalid_request'],
    ['a malformed app id is invalid_request', async (h) => ({ appId: 'has space', appName: 'Desk', code: await mint(h) }), 'invalid_request'],
    ['an empty app name is invalid_request', async (h) => ({ appId: APP, appName: '', code: await mint(h) }), 'invalid_request'],
    ['an over-long app name is invalid_request', async (h) => ({ appId: APP, appName: 'x'.repeat(201), code: await mint(h) }), 'invalid_request'],
    ["a name that normalizes to '' is invalid_request", async (h) => ({ appId: APP, appName: ' \u200b\u0007 \u202e\t', code: await mint(h) }), 'invalid_request'],
    ['an empty code is link_code_invalid', async () => ({ appId: APP, appName: 'Desk', code: '' }), 'link_code_invalid'],
    ['a 65-character code is link_code_invalid', async () => ({ appId: APP, appName: 'Desk', code: `axl_${'a'.repeat(61)}` }), 'link_code_invalid'],
    ['an upper-case code is link_code_invalid', async (h) => ({ appId: APP, appName: 'Desk', code: (await mint(h)).toUpperCase() }), 'link_code_invalid'],
    ['an unknown code is link_code_invalid', async () => ({ appId: APP, appName: 'Desk', code: newLinkCode() }), 'link_code_invalid'],
    ['an expired code is link_code_invalid', async (h) => ({ appId: APP, appName: 'Desk', code: await mint(h, { expiresAt: NOW }) }), 'link_code_invalid'],
    [
      'a used code is link_code_invalid',
      async (h) => {
        const code = await mint(h);
        await h.store.claimLinkCode({ codeHash: hashLinkCode(code), platformId: P, appId: APP2, appName: 'Other', now: new Date(NOW) });
        return { appId: APP, appName: 'Desk', code };
      },
      'link_code_invalid',
    ],
    [
      'a minter who lost their rights is link_code_invalid',
      async (h) => {
        h.handlers['agents:can-manage-connectors'] = () => ({ allowed: false });
        return { appId: APP, appName: 'Desk', code: await mint(h) };
      },
      'link_code_invalid',
    ],
    [
      'a code for a deleted agent is link_code_invalid',
      async (h) => {
        h.handlers['agents:can-manage-connectors'] = () => {
          throw pluginError('not-found');
        };
        return { appId: APP, appName: 'Desk', code: await mint(h) };
      },
      'link_code_invalid',
    ],
    [
      'a code for an agent the minter can no longer reach is link_code_invalid',
      async (h) => {
        h.handlers['agents:can-manage-connectors'] = () => {
          throw pluginError('forbidden');
        };
        return { appId: APP, appName: 'Desk', code: await mint(h) };
      },
      'link_code_invalid',
    ],
    [
      'an app already linked is already_linked',
      async (h) => {
        await link(h);
        return { appId: APP, appName: 'Desk', code: await mint(h, { agentId: 'agt_other' }) };
      },
      'already_linked',
    ],
  ];

  it.each(CLAIM_REFUSALS)('%s', async (_name, arrange, code) => {
    const h = harness();
    const body = await arrange(h);
    const linksBefore = h.store.linkCount();
    const a = await answerClaim(h.deps, body);
    expectRefusal(a, code);
    expect(h.store.linkCount()).toBe(linksBefore);
    if (code === 'already_linked') {
      // The code is kept: the person can still use it on another app.
      const kept = (body as { code: string }).code;
      expect(await h.store.peekLinkCode(hashLinkCode(kept), new Date(NOW))).not.toBeNull();
    }
  });

  it('claim: a store or hook failure is unavailable, retry in 5 s', async () => {
    const h = harness();
    const code = await mint(h);
    vi.spyOn(h.store, 'peekLinkCode').mockRejectedValueOnce(new Error('db down'));
    expectRefusal(await answerClaim(h.deps, { appId: APP, appName: 'Desk', code }), 'unavailable', 5);

    h.handlers['agents:can-manage-connectors'] = () => {
      throw pluginError('timeout');
    };
    expectRefusal(await answerClaim(h.deps, { appId: APP, appName: 'Desk', code }), 'unavailable', 5);

    h.handlers['agents:can-manage-connectors'] = () => ({ allowed: true });
    vi.spyOn(h.store, 'claimLinkCode').mockRejectedValueOnce(new Error('db down'));
    expectRefusal(await answerClaim(h.deps, { appId: APP, appName: 'Desk', code }), 'unavailable', 5);
    expect(h.store.linkCount()).toBe(0);

    // An answer from can-manage that can't be read is a failure, not a yes.
    h.handlers['agents:can-manage-connectors'] = () => ({ allowed: 'yes' });
    expectRefusal(await answerClaim(h.deps, { appId: APP, appName: 'Desk', code }), 'unavailable', 5);
    expect(h.store.linkCount()).toBe(0);
  });

  it('claim: a store throw on the replay lookup is unavailable', async () => {
    // Peek finds nothing, then the replay lookup throws.
    const h = harness();
    vi.spyOn(h.store, 'getLinkByCode').mockRejectedValue(new Error('db down'));
    expectRefusal(await answerClaim(h.deps, { appId: APP, appName: 'Desk', code: newLinkCode() }), 'unavailable', 5);

    // A lost race: the claim answers 'invalid', then the replay lookup throws.
    const r = harness();
    const code = await mint(r);
    vi.spyOn(r.store, 'claimLinkCode').mockResolvedValueOnce({ result: 'invalid' });
    vi.spyOn(r.store, 'getLinkByCode').mockRejectedValue(new Error('db down'));
    expectRefusal(await answerClaim(r.deps, { appId: APP, appName: 'Desk', code }), 'unavailable', 5);
  });

  it('claim: a retried claim of the code that made the link answers 200; the same code for another app id is link_code_invalid', async () => {
    const h = harness();
    const code = await mint(h);
    const first = await answerClaim(h.deps, { appId: APP, appName: 'Desk', code });
    expect(first.status).toBe(200);
    const retry = await answerClaim(h.deps, { appId: APP, appName: 'Desk again', code });
    expect(retry).toEqual({ status: 200, body: { appId: APP }, log: { appId: APP, outcome: 'linked', reason: 'replay' } });
    expect((await h.store.getLink(P, APP))?.appName).toBe('Desk');
    expectRefusal(await answerClaim(h.deps, { appId: APP2, appName: 'Desk', code }), 'link_code_invalid');
    expect(h.store.linkCount()).toBe(1);

    // A code that made a DIFFERENT link to this app id is not a replay.
    const other = await mint(h);
    expectRefusal(await answerClaim(h.deps, { appId: APP, appName: 'Desk', code: other }), 'already_linked');
  });

  /** Hold every can-manage answer until `n` claims are waiting on it, so all of them have peeked the code. */
  function gateCanManage(h: H, n: number): void {
    let waiting = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    h.handlers['agents:can-manage-connectors'] = async () => {
      waiting += 1;
      if (waiting === n) open();
      await gate;
      return { allowed: true };
    };
  }

  it('claim: two concurrent claims of one code for one app id both answer 200 and make one link (F1)', async () => {
    const h = harness();
    const code = await mint(h);
    const claim = vi.spyOn(h.store, 'claimLinkCode');
    gateCanManage(h, 2);
    const [a, b] = await Promise.all([
      answerClaim(h.deps, { appId: APP, appName: 'Desk', code }),
      answerClaim(h.deps, { appId: APP, appName: 'Desk', code }),
    ]);
    expect(a?.status).toBe(200);
    expect(b?.status).toBe(200);
    expect(a?.body).toEqual({ appId: APP });
    expect(b?.body).toEqual({ appId: APP });
    expect(h.store.linkCount()).toBe(1);
    // The race really happened: the store answered the loser 'invalid'.
    const results = await Promise.all(claim.mock.results.map((r) => r.value as Promise<{ result: string }>));
    expect(results.map((r) => r.result).sort()).toEqual(['invalid', 'linked']);
    expect([a?.log.reason, b?.log.reason].sort()).toEqual(['replay', undefined]);
  });

  it('claim: one code claimed at once for two different app ids makes one link; the other is link_code_invalid (F1)', async () => {
    const h = harness();
    const code = await mint(h);
    gateCanManage(h, 2);
    const [a, b] = await Promise.all([
      answerClaim(h.deps, { appId: APP, appName: 'Desk', code }),
      answerClaim(h.deps, { appId: APP2, appName: 'Desk', code }),
    ]);
    expect([a?.status, b?.status]).toEqual([200, 403]);
    expectRefusal(b as BridgeAnswer, 'link_code_invalid');
    expect(h.store.linkCount()).toBe(1);
    expect(await h.store.getLink(P, APP2)).toBeNull();
  });

  it('claim: logs never carry the code or the app name', async () => {
    const h = harness();
    const name = 'SECRET-APP-NAME';
    const answers: BridgeAnswer[] = [];
    const code = await mint(h);
    answers.push(await answerClaim(h.deps, { appId: APP, appName: name, code }));
    answers.push(await answerClaim(h.deps, { appId: APP, appName: name, code }));
    answers.push(await answerClaim(h.deps, { appId: APP2, appName: name, code }));
    answers.push(await answerClaim(h.deps, { appId: APP, appName: name, code: await mint(h) }));
    answers.push(await answerClaim(h.deps, { appId: APP, appName: name, code: 'axl_garbage' }));
    answers.push(await answerClaim(h.deps, { appId: 'bad id', appName: name, code }));
    answers.push(await answerClaim(h.deps, { appId: APP, appName: '\u0007', code }));
    vi.spyOn(h.store, 'peekLinkCode').mockRejectedValueOnce(new Error(`boom ${code} ${name}`));
    answers.push(await answerClaim(h.deps, { appId: APP, appName: name, code }));
    const text = JSON.stringify([answers.map((a) => a.log), h.lines]);
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.slice(4));
    expect(text).not.toContain(hashLinkCode(code));
    expect(text).not.toContain(name);
    expect(text).not.toContain('garbage');
    expect(text).not.toContain('bad id');
    expect(text).not.toContain('boom');
    for (const a of answers) {
      expect(Object.keys(a.log).every((k) => ['appId', 'outcome', 'reason'].includes(k))).toBe(true);
    }
    // A request field reaches the log only after it passed its grammar.
    expect(answers[5]?.log).toEqual({ outcome: 'invalid_request' });
  });
});

// ---------------------------------------------------------------------------
// POST /call
// ---------------------------------------------------------------------------

describe('answerCall', () => {
  it("builder: runs as the linker and the linked agent, and sends the request's own input object", async () => {
    const h = harness();
    await link(h);
    await grant(h, 'builder');
    const body = JSON.parse(JSON.stringify(builderBody())) as { input: Record<string, unknown> };
    const a = await answerCall(h.deps, body);

    expect(h.hooks()).toEqual([
      'agents:resolve',
      'agents:can-manage-connectors',
      'connectors:list-effective',
      'tool-policy:evaluate',
      'connectors:call-tool-result',
    ]);
    expect(h.callOf('agents:resolve')?.input).toEqual({ agentId: AGENT, userId: LINKER });
    // The linker's rights are asked on every builder call, as at claim time.
    expect(h.callOf('agents:can-manage-connectors')?.input).toEqual({ agentId: AGENT, actor: { userId: LINKER, isAdmin: false } });
    expect(h.callOf('connectors:list-effective')?.input).toEqual({ userId: LINKER, attachmentIds: [CONN], exclusions: [] });
    const policy = h.callOf('tool-policy:evaluate');
    expect(policy?.input).toEqual({ call: { name: KEY, input: body.input }, agentId: AGENT });
    expect((policy?.input as { call: { input: unknown } }).call.input).toBe(body.input);
    const sent = h.callOf('connectors:call-tool-result');
    expect(sent?.input).toEqual({ userId: LINKER, agentId: AGENT, toolKey: KEY, input: body.input });
    expect((sent?.input as { input: unknown }).input).toBe(body.input);
    for (const c of h.calls) {
      expect(c.ctx.userId).toBe(LINKER);
      expect(c.ctx.agentId).toBe(AGENT);
      expect(c.ctx.sessionId).toBe('apps-bridge');
    }
    expect(h.takeApp).toHaveBeenCalledWith(P, APP);
    expect(h.verifyViewer).not.toHaveBeenCalled();
    expect(a).toEqual({
      status: 200,
      body: { outcome: 'succeeded', content: CONTENT },
      log: { appId: APP, connectorId: CONN, tool: TOOL, mode: 'builder', outcome: 'succeeded' },
    });
  });

  type CallCase = [
    name: string,
    arrange: (h: H) => Promise<void>,
    body: () => unknown,
    code: keyof typeof REFUSAL_STATUS,
    retryAfterSeconds?: number,
  ];
  const linked = (mode: 'builder' | 'viewer' = 'builder') => async (h: H) => {
    await link(h);
    await grant(h, mode);
  };
  const setHandler = (hook: string, fn: Handler) => async (h: H) => {
    await linked()(h);
    h.handlers[hook] = fn;
  };
  const REFUSALS_IN_ORDER: CallCase[] = [
    ['bad body (extra key) is invalid_request', linked(), () => builderBody({ extra: 1 }), 'invalid_request'],
    ['bad body (input is an array) is invalid_request', linked(), () => builderBody({ input: [1] }), 'invalid_request'],
    ['bad body (input is null) is invalid_request', linked(), () => builderBody({ input: null }), 'invalid_request'],
    ['bad body (no input) is invalid_request', linked(), () => ({ ...builderBody(), input: undefined }), 'invalid_request'],
    ['bad body (unknown mode) is invalid_request', linked(), () => builderBody({ mode: 'admin' }), 'invalid_request'],
    ['bad body (viewer with no assertion) is invalid_request', linked('viewer'), () => builderBody({ mode: 'viewer' }), 'invalid_request'],
    ['bad body (builder with an assertion) is invalid_request', linked(), () => builderBody({ viewerAssertion: ASSERTION }), 'invalid_request'],
    ['bad body (tool with a space) is invalid_request', linked(), () => builderBody({ tool: 'list issues' }), 'invalid_request'],
    ['bad body (not JSON object) is invalid_request', linked(), () => null, 'invalid_request'],
    [
      'an app over its limit is rate_limited',
      async (h) => {
        await linked()(h);
        h.takeApp.mockReturnValue(false);
      },
      () => builderBody(),
      'rate_limited',
      60,
    ],
    ['no link is app_not_linked', async () => {}, () => builderBody(), 'app_not_linked'],
    ['no grant is not_granted', async (h) => link(h), () => builderBody(), 'not_granted'],
    ['a grant of the other mode is not_granted', linked('viewer'), () => builderBody(), 'not_granted'],
    ['a grant for another connector is not_granted', linked(), () => builderBody({ connectorId: 'github' }), 'not_granted'],
    ['a tool not on the grant is tool_not_allowed', linked(), () => builderBody({ tool: 'other' }), 'tool_not_allowed'],
    ['a tool key spelled as the tool name is tool_not_allowed', linked(), () => builderBody({ tool: KEY }), 'tool_not_allowed'],
    ['resolve not-found is agent_unavailable', setHandler('agents:resolve', () => { throw pluginError('not-found'); }), () => builderBody(), 'agent_unavailable'],
    ['resolve forbidden is agent_unavailable', setHandler('agents:resolve', () => { throw pluginError('forbidden'); }), () => builderBody(), 'agent_unavailable'],
    [
      'a linker who can no longer manage the agent is agent_unavailable',
      setHandler('agents:can-manage-connectors', () => ({ allowed: false })),
      () => builderBody(),
      'agent_unavailable',
    ],
    [
      'a linker who can no longer reach the agent to manage it is agent_unavailable',
      setHandler('agents:can-manage-connectors', () => { throw pluginError('forbidden'); }),
      () => builderBody(),
      'agent_unavailable',
    ],
    ['can-manage timing out is unavailable', setHandler('agents:can-manage-connectors', () => { throw pluginError('timeout'); }), () => builderBody(), 'unavailable', 5],
    [
      "a grant key whose namespace is another connector's is tool_not_allowed",
      async (h) => {
        await link(h);
        await grant(h, 'builder', [`mcp.${NS_GITHUB}.search`]);
      },
      () => builderBody({ tool: 'search' }),
      'tool_not_allowed',
    ],
    ['the effective set failing is unavailable', setHandler('connectors:list-effective', () => { throw pluginError('timeout'); }), () => builderBody(), 'unavailable', 5],
    ['an unreadable effective set is unavailable', setHandler('connectors:list-effective', () => ({ nope: 1 })), () => builderBody(), 'unavailable', 5],
    ['policy hold is approval_required', setHandler('tool-policy:evaluate', () => ({ verdict: 'hold' })), () => builderBody(), 'approval_required'],
    ['policy deny is tool_not_allowed', setHandler('tool-policy:evaluate', () => ({ verdict: 'deny' })), () => builderBody(), 'tool_not_allowed'],
    ['policy throws is unavailable', setHandler('tool-policy:evaluate', () => { throw pluginError('timeout'); }), () => builderBody(), 'unavailable', 5],
    ["policy answers {verdict:'maybe'} is unavailable", setHandler('tool-policy:evaluate', () => ({ verdict: 'maybe' })), () => builderBody(), 'unavailable', 5],
    ['policy answers null is unavailable', setHandler('tool-policy:evaluate', () => null), () => builderBody(), 'unavailable', 5],
    ['resolve times out is unavailable', setHandler('agents:resolve', () => { throw pluginError('timeout'); }), () => builderBody(), 'unavailable', 5],
    ['resolve answers an unreadable agent is unavailable', setHandler('agents:resolve', () => ({ agent: { id: AGENT } })), () => builderBody(), 'unavailable', 5],
    [
      'the store throwing on the link is unavailable',
      async (h) => {
        await linked()(h);
        vi.spyOn(h.store, 'getLink').mockRejectedValue(new Error('db down'));
      },
      () => builderBody(),
      'unavailable',
      5,
    ],
    [
      'the store throwing on the grant is unavailable',
      async (h) => {
        await linked()(h);
        vi.spyOn(h.store, 'getGrant').mockRejectedValue(new Error('db down'));
      },
      () => builderBody(),
      'unavailable',
      5,
    ],
  ];

  it.each(REFUSALS_IN_ORDER)('%s', async (_name, arrange, body, code, retryAfterSeconds) => {
    const h = harness();
    await arrange(h);
    const a = await answerCall(h.deps, body());
    expectRefusal(a, code, retryAfterSeconds);
    expect(h.hooks()).not.toContain('connectors:call-tool-result');
    // The rate limit is spent only by a well-formed request, before any read.
    if (code === 'invalid_request') expect(h.takeApp).not.toHaveBeenCalled();
    if (code === 'rate_limited') expect(h.calls).toEqual([]);
  });

  it('builder: a linker demoted on a team agent (still a member, can no longer manage it) is agent_unavailable', async () => {
    const h = harness({ handlers: { 'agents:can-manage-connectors': () => ({ allowed: false }) } });
    // The link is to a team agent the linker still reaches.
    const code = await mint(h, { agentId: TEAM_AGENT });
    h.handlers['agents:can-manage-connectors'] = () => ({ allowed: true });
    expect((await answerClaim(h.deps, { appId: APP, appName: 'Desk', code })).status).toBe(200);
    await grant(h, 'builder');
    expect((await answerCall(h.deps, builderBody())).status).toBe(200);
    h.handlers['agents:can-manage-connectors'] = () => ({ allowed: false });
    const before = h.calls.filter((c) => c.hook === 'connectors:call-tool-result').length;
    const a = await answerCall(h.deps, builderBody());
    expectRefusal(a, 'agent_unavailable');
    expect(h.calls.filter((c) => c.hook === 'connectors:call-tool-result').length).toBe(before);
    expectRefusal(await answerGrants(h.deps, APP), 'agent_unavailable');
  });

  it('a grant key whose namespace is on no connector of the agent goes on to the call hook, which decides', async () => {
    const h = harness();
    await link(h);
    const orphan = 'mcp.c9999999999.list_issues';
    await grant(h, 'builder', [orphan]);
    const a = await answerCall(h.deps, builderBody());
    expect(a.status).toBe(200);
    expect(h.callOf('connectors:call-tool-result')?.input).toMatchObject({ toolKey: orphan });
  });

  it('viewer: no approval answers viewer_approval_required with the path-only approve link', async () => {
    const h = harness();
    await link(h);
    await grant(h, 'viewer');
    const a = await answerCall(h.deps, viewerBody());
    expect(a.status).toBe(403);
    expect(a.body).toEqual({ code: 'viewer_approval_required', approveUrl: APPROVE_URL });
    expect(a.log).toEqual({ appId: APP, connectorId: CONN, tool: TOOL, mode: 'viewer', outcome: 'viewer_approval_required' });
    expect(h.verifyViewer).toHaveBeenCalledWith(ASSERTION);
    expect(h.hooks()).toEqual(['auth:find-user-by-email']);
    expect(h.callOf('auth:find-user-by-email')?.input).toEqual({ email: VIEWER_EMAIL });
    // The lookup is asked as no one: an owner-less stand-in, never a real person or ''.
    const lookup = h.callOf('auth:find-user-by-email');
    expect(lookup?.ctx.userId).toBe(ownerlessIdFor('apps-bridge'));
    expect(lookup?.ctx.agentId).toBe(ownerlessIdFor('apps-bridge'));
  });

  it('viewer: a bad assertion is viewer_invalid; a JWKS outage is unavailable; an email with no account is viewer_invalid', async () => {
    const bad = harness({ verdict: async () => ({ ok: false, reason: 'bad-signature' }) });
    await linked('viewer')(bad);
    await approve(bad);
    const a = await answerCall(bad.deps, viewerBody());
    expectRefusal(a, 'viewer_invalid');
    expect(a.log.reason).toBe('bad-signature');
    expect(bad.calls).toEqual([]);

    const expired = harness({ verdict: async () => ({ ok: false, reason: 'expired' }) });
    await linked('viewer')(expired);
    expectRefusal(await answerCall(expired.deps, viewerBody()), 'viewer_invalid');

    const outage = harness({ verdict: async () => ({ ok: false, reason: 'keys-unavailable' }) });
    await linked('viewer')(outage);
    await approve(outage);
    expectRefusal(await answerCall(outage.deps, viewerBody()), 'unavailable', 5);
    expect(outage.calls).toEqual([]);

    const throws = harness({ verdict: async () => { throw new Error('verifier bug'); } });
    await linked('viewer')(throws);
    expectRefusal(await answerCall(throws.deps, viewerBody()), 'unavailable', 5);

    const stranger = harness({ verdict: async () => ({ ok: true, email: 'nobody@example.test' }) });
    await linked('viewer')(stranger);
    await approve(stranger);
    const s = await answerCall(stranger.deps, viewerBody());
    expectRefusal(s, 'viewer_invalid');
    expect(s.log.reason).toBe('no-account');
    expect(stranger.hooks()).toEqual(['auth:find-user-by-email']);

    const lookupDown = harness({ handlers: { 'auth:find-user-by-email': () => { throw pluginError('timeout'); } } });
    await linked('viewer')(lookupDown);
    expectRefusal(await answerCall(lookupDown.deps, viewerBody()), 'unavailable', 5);

    const unreadable = harness({ handlers: { 'auth:find-user-by-email': () => ({ userId: '' }) } });
    await linked('viewer')(unreadable);
    await approve(unreadable);
    expectRefusal(await answerCall(unreadable.deps, viewerBody()), 'unavailable', 5);
    expect(unreadable.hooks()).not.toContain('connectors:call-tool-result');
  });

  it('viewer: runs as the viewer and the agent they approved', async () => {
    const h = harness();
    await link(h);
    await grant(h, 'viewer');
    await approve(h);
    const a = await answerCall(h.deps, viewerBody());
    expect(a).toEqual({
      status: 200,
      body: SUCCEEDED,
      log: { appId: APP, connectorId: CONN, tool: TOOL, mode: 'viewer', outcome: 'succeeded' },
    });
    // No can-manage question: a viewer borrows their own agent, not the linker's rights.
    expect(h.hooks()).toEqual([
      'auth:find-user-by-email',
      'agents:resolve',
      'connectors:list-effective',
      'tool-policy:evaluate',
      'connectors:call-tool-result',
    ]);
    expect(h.callOf('agents:resolve')?.input).toEqual({ agentId: VIEWER_AGENT, userId: VIEWER });
    expect(h.callOf('tool-policy:evaluate')?.input).toMatchObject({ call: { name: KEY }, agentId: VIEWER_AGENT });
    expect(h.callOf('connectors:call-tool-result')?.input).toMatchObject({ userId: VIEWER, agentId: VIEWER_AGENT, toolKey: KEY });
    for (const c of h.calls.slice(1)) {
      expect(c.ctx.userId).toBe(VIEWER);
      expect(c.ctx.agentId).toBe(VIEWER_AGENT);
    }
    // Never the linker or the linked agent.
    expect(JSON.stringify(h.calls.map((c) => [c.ctx.userId, c.ctx.agentId, c.input]))).not.toContain(LINKER);
    expect(JSON.stringify(h.calls.map((c) => [c.ctx.userId, c.ctx.agentId, c.input]))).not.toContain(AGENT);
  });

  it("viewer: an approved agent that is no longer the viewer's personal agent is agent_unavailable", async () => {
    for (const agentId of [TEAM_AGENT, BOB_AGENT]) {
      const h = harness();
      await link(h);
      await grant(h, 'viewer');
      await approve(h, [KEY], agentId);
      expectRefusal(await answerCall(h.deps, viewerBody()), 'agent_unavailable');
      expect(h.hooks()).toEqual(['auth:find-user-by-email', 'agents:resolve']);
    }
    const gone = harness();
    await link(gone);
    await grant(gone, 'viewer');
    await approve(gone, [KEY], 'agt_deleted');
    expectRefusal(await answerCall(gone.deps, viewerBody()), 'agent_unavailable');
  });

  it('viewer: a tool added after approval needs approval again; approved tools still work; a removed tool is not allowed', async () => {
    const h = harness();
    await link(h);
    await grant(h, 'viewer', [KEY]);
    await approve(h, [KEY]);
    expect((await answerCall(h.deps, viewerBody())).status).toBe(200);

    // The builder widens the grant: the viewer approved only list_issues.
    await grant(h, 'viewer', [KEY, KEY_CREATE]);
    expect((await answerCall(h.deps, viewerBody())).status).toBe(200);
    const widened = await answerCall(h.deps, viewerBody({ tool: 'create_issue' }));
    expect(widened.body).toEqual({ code: 'viewer_approval_required', approveUrl: APPROVE_URL });

    // The builder removes list_issues: the viewer's old approval doesn't bring it back.
    await grant(h, 'viewer', [KEY_CREATE]);
    const sent = h.calls.filter((c) => c.hook === 'connectors:call-tool-result').length;
    expectRefusal(await answerCall(h.deps, viewerBody()), 'tool_not_allowed');
    expect(h.calls.filter((c) => c.hook === 'connectors:call-tool-result').length).toBe(sent);
  });

  const OUTCOMES: Array<[string, Record<string, unknown>]> = [
    ['succeeded', SUCCEEDED],
    ['succeeded with no content', { outcome: 'succeeded', content: [] }],
    ['tool-error with content', { outcome: 'failed', reason: 'tool-error', content: [{ type: 'text', text: 'SECRET-CONTENT bad team', isError: true }] }],
    ['tool-error from a JSON-RPC error', { outcome: 'failed', reason: 'tool-error', content: [] }],
    ['needs-auth', { outcome: 'failed', reason: 'needs-auth' }],
    ['not-connected', { outcome: 'failed', reason: 'not-connected' }],
    ['rejected', { outcome: 'failed', reason: 'rejected' }],
    ['timeout', { outcome: 'unknown', reason: 'timeout' }],
    ['interrupted', { outcome: 'unknown', reason: 'interrupted' }],
  ];

  it.each(OUTCOMES)('outcomes pass through verbatim, tool-error content included: %s', async (_name, result) => {
    const h = harness({ handlers: { 'connectors:call-tool-result': () => result } });
    await link(h);
    await grant(h, 'builder');
    const a = await answerCall(h.deps, builderBody());
    expect(a.status).toBe(200);
    expect(a.body).toBe(result);
    expect(CallResponseSchema.safeParse(a.body).success).toBe(true);
    expect(a.retryAfterSeconds).toBeUndefined();
    expect(a.log.outcome).toBe(result['outcome']);
    expect(a.log.reason).toBe(result['reason']);
  });

  it('a bus throw after dispatch is unknown/interrupted; the log line keeps its cause as a code', async () => {
    const cases: Array<[Error, { code?: string }]> = [
      [pluginError('timeout'), { code: 'timeout' }],
      [pluginError('invalid-return'), { code: 'invalid-return' }],
      [pluginError('no-service'), { code: 'no-service' }],
      // Not a PluginError: no code, and never its message.
      [new Error('socket hang up SECRET-MESSAGE'), {}],
    ];
    for (const [thrown, code] of cases) {
      const h = harness({ handlers: { 'connectors:call-tool-result': () => { throw thrown; } } });
      await link(h);
      await grant(h, 'builder');
      const a = await answerCall(h.deps, builderBody());
      // The wire answer is the same whatever the cause.
      expect(a).toEqual({
        status: 200,
        body: { outcome: 'unknown', reason: 'interrupted' },
        log: { appId: APP, connectorId: CONN, tool: TOOL, mode: 'builder', outcome: 'unknown', reason: 'interrupted', unexpected: true, ...code },
      });
      expect(JSON.stringify(a.log)).not.toContain('SECRET');
    }
    // An answer the contract can't carry is treated the same on the wire (the
    // call may have gone out); the log line names it a contract mismatch.
    const h = harness({ handlers: { 'connectors:call-tool-result': () => ({ outcome: 'succeeded', content: 'SECRET-CONTENT' }) } });
    await link(h);
    await grant(h, 'builder');
    const a = await answerCall(h.deps, builderBody());
    expect(a.body).toEqual({ outcome: 'unknown', reason: 'interrupted' });
    expect(a.log).toEqual({
      appId: APP,
      connectorId: CONN,
      tool: TOOL,
      mode: 'builder',
      outcome: 'unknown',
      reason: 'interrupted',
      unexpected: true,
      code: 'contract-mismatch',
    });
  });

  it('an interruption the connector itself reports is not marked unexpected', async () => {
    const h = harness({ handlers: { 'connectors:call-tool-result': () => ({ outcome: 'unknown', reason: 'interrupted' }) } });
    await link(h);
    await grant(h, 'builder');
    const a = await answerCall(h.deps, builderBody());
    expect(a.body).toEqual({ outcome: 'unknown', reason: 'interrupted' });
    expect(a.log).toEqual({ appId: APP, connectorId: CONN, tool: TOOL, mode: 'builder', outcome: 'unknown', reason: 'interrupted' });
  });

  it('input keys like __proto__ reach the hook byte-faithfully and pollute nothing', async () => {
    const h = harness();
    await link(h);
    await grant(h, 'builder');
    const inputJson = '{"__proto__":{"polluted":1},"constructor":"x","team":"eng"}';
    const body = JSON.parse(
      `{"appId":"${APP}","connectorId":"${CONN}","tool":"${TOOL}","mode":"builder","input":${inputJson}}`,
    ) as { input: Record<string, unknown> };
    const a = await answerCall(h.deps, body);
    expect(a.status).toBe(200);
    const sent = (h.callOf('connectors:call-tool-result')?.input as { input: Record<string, unknown> }).input;
    expect(sent).toBe(body.input);
    expect(Object.hasOwn(sent, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
    expect(sent['constructor']).toBe('x');
    expect(JSON.stringify(sent)).toBe(inputJson);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
    const policyInput = (h.callOf('tool-policy:evaluate')?.input as { call: { input: unknown } }).call.input;
    expect(policyInput).toBe(body.input);
  });

  it('log fields carry codes and validated ids only', async () => {
    const answers: BridgeAnswer[] = [];
    const lines: Line[] = [];

    const b = harness({ handlers: { 'connectors:call-tool-result': () => ({ outcome: 'failed', reason: 'tool-error', content: CONTENT }) } });
    await link(b);
    await grant(b, 'builder');
    answers.push(await answerCall(b.deps, builderBody()));
    answers.push(await answerCall(b.deps, builderBody({ tool: 'other' })));
    lines.push(...b.lines);

    const v = harness();
    await link(v);
    await grant(v, 'viewer');
    answers.push(await answerCall(v.deps, viewerBody()));
    await approve(v);
    answers.push(await answerCall(v.deps, viewerBody()));
    lines.push(...v.lines);

    const bad = harness({ verdict: async () => ({ ok: false, reason: 'wrong-audience' }) });
    await link(bad);
    await grant(bad, 'viewer');
    answers.push(await answerCall(bad.deps, viewerBody()));
    lines.push(...bad.lines);

    const err = harness({ handlers: { 'tool-policy:evaluate': () => { throw new Error(`policy ${SECRET_INPUT} ${VIEWER_EMAIL}`); } } });
    await link(err);
    await grant(err, 'viewer');
    await approve(err);
    answers.push(await answerCall(err.deps, viewerBody()));
    lines.push(...err.lines);

    // A request field reaches the log only after the body passed its grammar.
    const malformed = harness();
    answers.push(await answerCall(malformed.deps, builderBody({ appId: 'evil\nline', connectorId: 'SECRET-CONNECTOR' })));
    answers.push(await answerCall(malformed.deps, builderBody({ tool: 'SECRET-TOOL', extra: true })));
    lines.push(...malformed.lines);
    expect(answers.at(-2)?.log).toEqual({ outcome: 'invalid_request' });
    expect(answers.at(-1)?.log).toEqual({ outcome: 'invalid_request' });

    const text = JSON.stringify([answers.map((a) => a.log), lines]);
    for (const secret of [SECRET_INPUT, 'SECRET-CONTENT', ASSERTION, 'SECRET-ASSERTION', VIEWER_EMAIL, APPROVE_URL, 'evil', 'SECRET-CONNECTOR', 'SECRET-TOOL', 'SECRET-MESSAGE', KEY]) {
      expect(text).not.toContain(secret);
    }
    const allowed = ['appId', 'connectorId', 'tool', 'mode', 'outcome', 'reason', 'unexpected', 'code'];
    for (const a of answers) expect(Object.keys(a.log).every((k) => allowed.includes(k))).toBe(true);
    expect(answers.map((a) => a.log.outcome)).toEqual([
      'failed',
      'tool_not_allowed',
      'viewer_approval_required',
      'succeeded',
      'viewer_invalid',
      'unavailable',
      'invalid_request',
      'invalid_request',
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /apps/:appId/grants
// ---------------------------------------------------------------------------

describe('answerGrants', () => {
  async function seeded(over: Record<string, Handler> = {}) {
    const h = harness({ handlers: over });
    await link(h);
    await grant(h, 'builder', [KEY, KEY_CREATE]);
    await grant(h, 'viewer', ['mcp.cabcdefabcd.search'], 'github');
    return h;
  }

  it("grants: each tool carries the inventory's description and inputSchema, and connectors carry their display name", async () => {
    const h = await seeded();
    await grant(h, 'builder', ['mcp.c2222222222.find'], 'notion'); // not in connectors:list
    const a = await answerGrants(h.deps, APP);
    expect(a.status).toBe(200);
    expect(GrantsResponseSchema.safeParse(a.body).success).toBe(true);
    expect(a.body).toEqual({
      grants: [
        {
          connectorId: 'github',
          displayName: 'GitHub',
          mode: 'viewer',
          tools: [{ name: 'search', description: 'Search code', inputSchema: { type: 'object' } }],
        },
        {
          connectorId: CONN,
          displayName: 'Linear',
          mode: 'builder',
          tools: [
            { name: TOOL, description: 'List issues', inputSchema: LIST_SCHEMA },
            { name: 'create_issue', description: 'Make an issue', inputSchema: null },
          ],
        },
        { connectorId: 'notion', displayName: 'notion', mode: 'builder', tools: [{ name: 'find', description: '', inputSchema: null }] },
      ],
    });
    expect(a.log).toEqual({ appId: APP, outcome: 'succeeded' });

    // Every read is the linker's, for the linked agent.
    expect(h.callOf('connectors:list')?.input).toEqual({ userId: LINKER });
    const described = h.calls.filter((c) => c.hook === 'connectors:describe-tools');
    expect(described.map((c) => c.input)).toEqual([
      { userId: LINKER, agentId: AGENT, connectorId: 'github' },
      { userId: LINKER, agentId: AGENT, connectorId: CONN },
      { userId: LINKER, agentId: AGENT, connectorId: 'notion' },
    ]);
    for (const c of h.calls) {
      expect(c.ctx.userId).toBe(LINKER);
      expect(c.ctx.agentId).toBe(AGENT);
    }
  });

  it('grants: a linker demoted on a team agent (still a member, can no longer manage it) is agent_unavailable', async () => {
    const h = await seeded({ 'agents:can-manage-connectors': () => ({ allowed: false }) });
    const a = await answerGrants(h.deps, APP);
    expectRefusal(a, 'agent_unavailable');
    expect(a.log).toEqual({ appId: APP, outcome: 'agent_unavailable' });
    expect(h.callOf('agents:can-manage-connectors')?.input).toEqual({ agentId: AGENT, actor: { userId: LINKER, isAdmin: false } });
    expect(h.hooks()).toEqual(['agents:can-manage-connectors']);

    const gone = await seeded({ 'agents:can-manage-connectors': () => { throw pluginError('not-found'); } });
    expectRefusal(await answerGrants(gone.deps, APP), 'agent_unavailable');
    const down = await seeded({ 'agents:can-manage-connectors': () => { throw pluginError('timeout'); } });
    expectRefusal(await answerGrants(down.deps, APP), 'unavailable', 5);
  });

  it('grants: a link with no grants answers an empty list', async () => {
    const h = harness();
    await link(h);
    expect(await answerGrants(h.deps, APP)).toEqual({ status: 200, body: { grants: [] }, log: { appId: APP, outcome: 'succeeded' } });
  });

  it('grants: an unknown app is app_not_linked; a malformed app id is invalid_request', async () => {
    const h = harness();
    expectRefusal(await answerGrants(h.deps, APP), 'app_not_linked');
    const bad = await answerGrants(h.deps, 'bad/app');
    expectRefusal(bad, 'invalid_request');
    expect(bad.log).toEqual({ outcome: 'invalid_request' });
    expectRefusal(await answerGrants(h.deps, ''), 'invalid_request');
    expectRefusal(await answerGrants(h.deps, 'a'.repeat(65)), 'invalid_request');
    expect(h.calls).toEqual([]);
  });

  it('grants: a tool the inventory lacks, or a describe-tools throw, gives an empty description and a null schema', async () => {
    const h = await seeded({
      'connectors:describe-tools': (_ctx, input: { connectorId: string }) => {
        if (input.connectorId === 'github') throw pluginError('timeout');
        return {
          status: 'ok',
          checkedAt: new Date(NOW).toISOString(),
          tools: [
            // list_issues: a schema that isn't a plain object, and a non-string description.
            { name: TOOL, description: 42, inputSchema: ['not', 'an', 'object'], toolKey: KEY },
            // create_issue is missing from the inventory.
          ],
        };
      },
    });
    const a = await answerGrants(h.deps, APP);
    expect(a.status).toBe(200);
    expect(GrantsResponseSchema.safeParse(a.body).success).toBe(true);
    expect(a.body).toEqual({
      grants: [
        { connectorId: 'github', displayName: 'GitHub', mode: 'viewer', tools: [{ name: 'search', description: '', inputSchema: null }] },
        {
          connectorId: CONN,
          displayName: 'Linear',
          mode: 'builder',
          tools: [
            { name: TOOL, description: '', inputSchema: null },
            { name: 'create_issue', description: '', inputSchema: null },
          ],
        },
      ],
    });
    // One log line per request: the failure rides on it as a code (the
    // thrown PluginError's), and nothing else is logged.
    expect(a.log).toEqual({ appId: APP, outcome: 'succeeded', reason: 'describe-tools-failed', code: 'timeout' });
    expect(h.lines).toEqual([]);
  });

  it('grants: past the body budget, further tools keep their description but lose their schema', async () => {
    // Worst case without a budget: ~32 KiB of schema x 200 tools x N
    // connectors. Three connectors of 200 tools with 30 KiB schemas would be
    // ~18 MiB; the answer stays under GRANTS_BODY_BUDGET_BYTES and valid.
    const big = { type: 'object', description: 'x'.repeat(30 * 1024) };
    const ns = ['c0000000001', 'c0000000002', 'c0000000003'];
    const ids = ['alpha', 'beta', 'gamma'];
    const keysFor = (n: string) => Array.from({ length: 200 }, (_, i) => `mcp.${n}.t${i}`);
    const h = harness({
      handlers: {
        'connectors:describe-tools': (_ctx, input: { connectorId: string }) => ({
          status: 'ok',
          checkedAt: new Date(NOW).toISOString(),
          tools: keysFor(ns[ids.indexOf(input.connectorId)] ?? 'c9999999999').map((toolKey, i) => ({
            name: `t${i}`,
            description: `does thing ${i}`,
            inputSchema: big,
            toolKey,
          })),
        }),
      },
    });
    await link(h);
    for (const [i, id] of ids.entries()) await grant(h, 'builder', keysFor(ns[i]!), id);

    const a = await answerGrants(h.deps, APP);
    expect(a.status).toBe(200);
    expect(GrantsResponseSchema.safeParse(a.body).success).toBe(true);
    // The budget bounds what carries a schema; the schema-less tail after it
    // (names and capped descriptions, ~60 bytes each here) is all that's over.
    const bytes = Buffer.byteLength(JSON.stringify(a.body), 'utf8');
    expect(bytes).toBeLessThanOrEqual(GRANTS_BODY_BUDGET_BYTES + 64 * 1024);
    const tools = (a.body as { grants: Array<{ tools: Array<{ description: string; inputSchema: unknown }> }> }).grants.flatMap(
      (g) => g.tools,
    );
    expect(tools).toHaveLength(600);
    // Every description survives; schemas are kept in order until the budget runs out, then all null.
    expect(tools.every((t, i) => t.description === `does thing ${i % 200}`)).toBe(true);
    const kept = tools.filter((t) => t.inputSchema !== null).length;
    expect(kept).toBeGreaterThan(100);
    expect(kept).toBeLessThan(600);
    expect(tools.slice(0, kept).every((t) => t.inputSchema !== null)).toBe(true);
    expect(tools.slice(kept).every((t) => t.inputSchema === null)).toBe(true);
    expect(a.log).toEqual({ appId: APP, outcome: 'succeeded', reason: 'schemas-trimmed' });
  });

  it('grants: the body budget is 4 MiB (the first grants test shows an answer under it is untouched)', () => {
    expect(GRANTS_BODY_BUDGET_BYTES).toBe(4 * 1024 * 1024);
  });

  it('grants: an unreadable describe-tools answer degrades the same way', async () => {
    const h = await seeded({ 'connectors:describe-tools': () => ({ status: 'ok', tools: 'nope' }) });
    const a = await answerGrants(h.deps, APP);
    expect(a.status).toBe(200);
    expect(a.log).toEqual({ appId: APP, outcome: 'succeeded', reason: 'describe-tools-failed', code: 'contract-mismatch' });
    const tools = (a.body as { grants: Array<{ tools: unknown[] }> }).grants.flatMap((g) => g.tools);
    expect(tools).toEqual([
      { name: 'search', description: '', inputSchema: null },
      { name: TOOL, description: '', inputSchema: null },
      { name: 'create_issue', description: '', inputSchema: null },
    ]);
  });

  it('grants: any other throw is unavailable, retry in 5 s (F9)', async () => {
    const listThrows = await seeded({ 'connectors:list': () => { throw pluginError('timeout'); } });
    expectRefusal(await answerGrants(listThrows.deps, APP), 'unavailable', 5);

    const listUnreadable = await seeded({ 'connectors:list': () => ({ nope: true }) });
    expectRefusal(await answerGrants(listUnreadable.deps, APP), 'unavailable', 5);

    const linkThrows = await seeded();
    vi.spyOn(linkThrows.store, 'getLink').mockRejectedValue(new Error('db down'));
    expectRefusal(await answerGrants(linkThrows.deps, APP), 'unavailable', 5);

    const grantsThrow = await seeded();
    vi.spyOn(grantsThrow.store, 'listGrants').mockRejectedValue(new Error('db down'));
    expectRefusal(await answerGrants(grantsThrow.deps, APP), 'unavailable', 5);
  });
});

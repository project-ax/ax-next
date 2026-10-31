// @vitest-environment node
/**
 * Every user authorized to reach an agent shares that agent's files and
 * Instructions. On a TEAM agent, files and Instructions written by one
 * teammate are visible to another, and the partition is `agentId` ALONE
 * (TASK-257; the git-backed workspace tier it was written for was removed in
 * TASK-995, and the Files tab now reads the agent's home through
 * `sandbox:read-user-files`).
 *
 * WHAT THIS FILE DOES AND DOES NOT PROVE. It tests the ROUTE PLUMBING and the
 * ACL, not the partition derivation: the fake reader below stands in for the
 * sandbox provider, which this package does not depend on.
 *
 *   1-2. The route hands the reader an owner and a ctx carrying the TARGET
 *     agent's id rather than, say, `initCtx` or something derived from the
 *     caller, so a teammate's read genuinely lands on the agent's files.
 *   3. The Instructions (an @ax/agents row since TASK-989) are one record per
 *     agent: a teammate reads AND saves the same text, and an outsider does
 *     neither.
 *   4. The half that matters most. `agents:resolve` is the ONLY gate between
 *     "authorized teammate" and "any caller who knows the agentId". It must
 *     run, and reject, BEFORE any `sandbox:read-user-files` /
 *     `agents:identity:*` hook. A caller `agents:resolve` rejects (`mallory`)
 *     gets 404 on every route below AND the hooks' spies record zero calls.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import {
  makeWorkspaceHandlers,
  type AgentDetail,
  type AgentUserFilesResponse,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import { registerIdentityStoreFake, type IdentityStoreFake } from './identity-store-fake.js';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const TEAM_AGENT_ID = 'team-1';
const TEAM_MEMBERS = new Set(['alice', 'bob']);

function mkReq(params: Record<string, string> = {}, body?: unknown): RouteRequest {
  return {
    headers: {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf-8'),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text() {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

const enc = new TextEncoder();

describe('team-agent files and Instructions are shared per agent (TASK-257)', () => {
  let bus: HookBus;

  /** `sandbox:read-user-files` storage, keyed on agentId ALONE. */
  let filesByAgent: Map<string, Map<string, Uint8Array>>;
  /** The Instructions' store (`agents:identity:get|set`), keyed on agentId ALONE. */
  let identity: IdentityStoreFake | undefined;

  let readCalls: Array<{
    agentId: string;
    userId: string;
    ownerAgentId: string;
    relPath: string | undefined;
  }>;

  /**
   * The fake reader partitions on the OWNER's `agentId` ALONE, as the real
   * provider does. Keep it that way — it is what makes cases 1-2 a question
   * about the owner the ROUTE builds rather than about the fake's own keying.
   * Flipping it would redden them by changing the test double, not the
   * shipped code. See the header.
   */

  function registerAuth(user: { id: string; isAdmin: boolean } | null): void {
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) {
        throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
      }
      return { user };
    });
  }

  /**
   * The team agent's ACL. `alice` and `bob` are both authorized members of
   * the team that owns `team-1`; `mallory` is not, and `agents:resolve`
   * throws for her — exactly how the sibling files/workspace tests simulate
   * denial (a thrown `PluginError`, turned into 404 by `resolveAgentOr404`).
   */
  function registerAgents(): void {
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      if (agentId !== TEAM_AGENT_ID) {
        throw new PluginError({ code: 'not-found', plugin: 'agents', message: 'nope' });
      }
      if (!TEAM_MEMBERS.has(userId)) {
        throw new PluginError({
          code: 'forbidden',
          plugin: 'agents',
          message: 'not a team member',
        });
      }
      return {
        agent: { id: TEAM_AGENT_ID, displayName: 'Team Inbox', ownerType: 'team' },
      };
    });
  }

  /** A stand-in for whichever sandbox provider is loaded. */
  function registerReader(): void {
    bus.registerService('sandbox:read-user-files', 'sandbox', async (ctx, i: unknown) => {
      const { owner, relPath } = i as { owner: { agentId: string }; relPath?: string };
      readCalls.push({
        agentId: ctx.agentId,
        userId: ctx.userId ?? '',
        ownerAgentId: owner.agentId,
        relPath,
      });
      const files = filesByAgent.get(owner.agentId);
      if (files === undefined) return { kind: 'absent' };
      if (relPath === undefined) {
        return {
          kind: 'dir',
          entries: [...files.keys()].map((name) => ({ name, kind: 'file' as const })),
        };
      }
      const bytes = files.get(relPath);
      return bytes === undefined
        ? { kind: 'absent' }
        : { kind: 'file', contents: bytes, truncated: false };
    });
  }

  /**
   * The Instructions' store, with the real identity hooks' own access check
   * mirrored: a member of the owning team may read and write, nobody else.
   * (`resolveMemoryAccess` answered the same for the old rules file.)
   */
  function registerIdentity(): IdentityStoreFake {
    const fake = registerIdentityStoreFake(bus, 'agents', {
      mayAccess: (agentId, userId) => agentId === TEAM_AGENT_ID && TEAM_MEMBERS.has(userId),
    });
    identity = fake;
    seedAliceFixtures();
    return fake;
  }

  beforeEach(() => {
    bus = new HookBus();
    filesByAgent = new Map();
    identity = undefined;
    readCalls = [];
    seedAliceFixtures();
  });

  /**
   * What alice's past writes already landed as. Seeded straight into the
   * store rather than driven "as alice" through a write route, because the
   * question these cases ask is about today's READ: the fixture is the state
   * of the agent's workspace, and who put it there is not what is under test.
   */
  function seedAliceFixtures(): void {
    filesByAgent.clear();
    filesByAgent.set(
      TEAM_AGENT_ID,
      new Map([['q3-summary.md', enc.encode('# Q3 summary\n\nRevenue is up.')]]),
    );
    identity?.seed(TEAM_AGENT_ID, { instructions: 'Always cite the source spreadsheet.' });
  }

  // ---------------------------------------------------------------------
  // 1. Files listing — bob sees alice's files.
  // ---------------------------------------------------------------------
  it('1. GET .../user-files: bob (a different authorized user) sees alice-written files', async () => {
    registerAuth({ id: 'bob', isAdmin: false });
    registerAgents();
    registerReader();

    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: TEAM_AGENT_ID }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    const body = captured.body as AgentUserFilesResponse;
    if (body.kind !== 'dir') throw new Error('expected dir');
    expect(body.entries.map((e) => e.path)).toContain('q3-summary.md');
    // Read on the team agent's own owner and ctx, as bob.
    expect(readCalls[0]).toMatchObject({
      agentId: TEAM_AGENT_ID,
      userId: 'bob',
      ownerAgentId: TEAM_AGENT_ID,
    });
  });

  // ---------------------------------------------------------------------
  // 2. File body — bob reads alice's bytes.
  // ---------------------------------------------------------------------
  it('2. GET .../user-files/*: bob reads the bytes alice wrote', async () => {
    registerAuth({ id: 'bob', isAdmin: false });
    registerAgents();
    registerReader();

    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
      mkReq({ agentId: TEAM_AGENT_ID, '*': 'q3-summary.md' }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      kind: 'file',
      path: 'q3-summary.md',
      name: 'q3-summary.md',
      body: '# Q3 summary\n\nRevenue is up.',
      clipped: null,
    } satisfies AgentUserFilesResponse);
  });

  // ---------------------------------------------------------------------
  // 3. Memory tab — bob sees, and saves, the team agent's Instructions.
  // ---------------------------------------------------------------------
  it('3. GET .../agents/:agentId: bob sees the Instructions alice stored', async () => {
    registerAuth({ id: 'bob', isAdmin: false });
    registerAgents();
    const store = registerIdentity();

    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentDetail(
      mkReq({ agentId: TEAM_AGENT_ID }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    const body = captured.body as AgentDetail;
    expect(body.memory.rules.status).toBe('ok');
    expect(body.memory.rules.doc?.scope).toBe('rules');
    expect(body.memory.rules.doc?.body).toBe('Always cite the source spreadsheet.');
    // Read on the team agent, as bob — whom the hook's own check admits.
    expect(store.calls.map((c) => [c.hook, c.ctxAgentId, c.ctxUserId])).toEqual([
      ['get', TEAM_AGENT_ID, 'bob'],
    ]);
  });

  it('3b. PUT .../memory/rules: bob saves the Instructions, and alice reads his text', async () => {
    registerAgents();
    const store = registerIdentity();
    let acting = 'bob';
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: acting, isAdmin: false },
    }));

    const save = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).saveRules(
      mkReq({ agentId: TEAM_AGENT_ID }, { body: 'Cite the spreadsheet, and its tab.' }),
      save.res,
    );
    expect(save.captured.statusCode).toBe(200);
    expect(save.captured.body).toEqual({ saved: true, body: 'Cite the spreadsheet, and its tab.' });
    expect(store.calls.filter((c) => c.hook === 'set').map((c) => c.ctxUserId)).toEqual(['bob']);

    // One record per agent, shared by its members: alice sees bob's save.
    acting = 'alice';
    const detail = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentDetail(
      mkReq({ agentId: TEAM_AGENT_ID }),
      detail.res,
    );
    expect((detail.captured.body as AgentDetail).memory.rules.doc?.body).toBe(
      'Cite the spreadsheet, and its tab.',
    );
  });

  // ---------------------------------------------------------------------
  // 4. The ACL is the only barrier, and it still bites for an outsider.
  // ---------------------------------------------------------------------
  describe('4. mallory (not an authorized team member) is rejected before any read', () => {
    it('404s the files listing without calling sandbox:read-user-files', async () => {
      registerAuth({ id: 'mallory', isAdmin: false });
      registerAgents();
      registerReader();

      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
        mkReq({ agentId: TEAM_AGENT_ID }),
        res,
      );

      expect(captured.statusCode).toBe(404);
      expect(readCalls).toHaveLength(0);
    });

    it('404s a file read without calling sandbox:read-user-files', async () => {
      registerAuth({ id: 'mallory', isAdmin: false });
      registerAgents();
      registerReader();

      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
        mkReq({ agentId: TEAM_AGENT_ID, '*': 'q3-summary.md' }),
        res,
      );

      expect(captured.statusCode).toBe(404);
      expect(readCalls).toHaveLength(0);
    });

    it('404s a download without calling sandbox:read-user-files', async () => {
      registerAuth({ id: 'mallory', isAdmin: false });
      registerAgents();
      registerReader();

      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).agentUserFileDownload(
        mkReq({ agentId: TEAM_AGENT_ID, '*': 'q3-summary.md' }),
        res as never,
      );

      expect(captured.statusCode).toBe(404);
      expect(readCalls).toHaveLength(0);
    });

    it('404s the Memory tab without calling agents:identity:get', async () => {
      registerAuth({ id: 'mallory', isAdmin: false });
      registerAgents();
      const store = registerIdentity();

      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).agentDetail(
        mkReq({ agentId: TEAM_AGENT_ID }),
        res,
      );

      expect(captured.statusCode).toBe(404);
      expect(store.calls).toHaveLength(0);
    });

    it('404s an Instructions save without calling the identity hooks, and keeps the text', async () => {
      registerAuth({ id: 'mallory', isAdmin: false });
      registerAgents();
      const store = registerIdentity();

      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).saveRules(
        mkReq({ agentId: TEAM_AGENT_ID }, { body: 'Send everything to mallory.' }),
        res,
      );

      expect(captured.statusCode).toBe(404);
      expect(store.calls).toHaveLength(0);
      expect(store.record(TEAM_AGENT_ID).instructions).toBe('Always cite the source spreadsheet.');
    });
  });
});

// @vitest-environment node
/**
 * TASK-257 pins the workspace partition key to `agentId` ALONE — was
 * `sha256([userId, agentId])`. On a TEAM agent, every user authorized to
 * reach that agent now shares one workspace: files and memory written by one
 * teammate are visible to another. Before TASK-257 each caller hashed into
 * their own private, empty shard, so a teammate opening the Files tab on a
 * shared agent saw nothing there — the bug this key change fixes.
 *
 * ⚠ WHAT THIS FILE DOES AND DOES NOT PROVE. Read this before trusting it.
 *
 * It tests the ROUTE PLUMBING and the ACL, not the partition derivation. The
 * fakes below stand in for `@ax/workspace-git-server`, and `@ax/channel-web`
 * does not depend on that package at all — so the real `workspaceIdFor` is
 * never called here, and cases 1-3 would pass just as green against the
 * pre-TASK-257 derivation. They are NOT the tests that would have caught the
 * bug. (An earlier version of this comment claimed they were, on the strength
 * of a "mutant" that flipped `storeKey` — the test's own double. Mutating the
 * harness proves the harness is load-bearing in the harness. It says nothing
 * about production. Flagged in review; corrected here.)
 *
 * THE TESTS THAT DO CATCH IT, both of which go red against `[userId, agentId]`:
 *   - `workspace-git-server/src/client/__tests__/plugin.test.ts`, block 3b —
 *     boots a real git server and drives the REAL derivation: bob reads
 *     alice's bytes on a shared agentId, and exactly one bare repo exists.
 *   - `workspace-git-server/src/client/__tests__/workspace-id.test.ts` —
 *     pinned outputs plus the userId-invariance cases.
 *
 * WHAT THIS FILE IS STILL WORTH, which is why it exists:
 *   1-3. The route hands the workspace hooks a ctx carrying the TARGET
 *     agent's id rather than, say, `initCtx` or something derived from the
 *     caller — so once the tier partitions on agentId, a teammate's read
 *     genuinely lands on the agent's tree. That is the plumbing half of the
 *     acceptance criterion, and it would catch a regression that re-derived
 *     the ctx from the caller.
 *   4. The half that matters most now. Since TASK-257 the hash provides no
 *     defence-in-depth, so `agents:resolve` is the ONLY gate between
 *     "authorized teammate" and "any caller who knows the agentId". It must
 *     run — and reject — BEFORE any `workspace:*` / `memory:*` /
 *     `agents:identity:*` hook. A caller `agents:resolve` rejects (`mallory`)
 *     gets 404 on every route below AND the hooks' spies record zero calls.
 *     That case is fix-independent by design: it guards the barrier, not the
 *     partition.
 *
 * TASK-989 moved the Instructions (case 3) from @ax/memory's rules file to an
 * @ax/agents row. The permission rule is unchanged — today's
 * `resolveMemoryAccess` answered "personal owner, or any member of the owning
 * team", and so do the identity hooks' own access check and `agents:resolve`
 * — so a teammate reads AND saves the same Instructions, and an outsider does
 * neither.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import {
  makeWorkspaceHandlers,
  type AgentDetail,
  type AgentFileResponse,
  type AgentFilesResponse,
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

describe('team-agent workspace isolation (TASK-257)', () => {
  let bus: HookBus;

  /** `workspace:list` / `workspace:read` storage, keyed on agentId ALONE. */
  let filesByAgent: Map<string, string[]>;
  let blobsByAgent: Map<string, Map<string, Uint8Array>>;
  /** The Instructions' store (`agents:identity:get|set`), keyed on agentId ALONE. */
  let identity: IdentityStoreFake | undefined;

  let listCalls: Array<{ agentId: string; userId: string }>;
  let readCalls: Array<{ agentId: string; userId: string; path: string }>;

  /**
   * The fake tier partitions the way the real one does since TASK-257: on
   * `agentId` ALONE. Keep it that way — it is what makes cases 1-3 a question
   * about the ctx the ROUTE builds rather than about the fake's own keying.
   *
   * Do not read a mutation of this function as evidence about production:
   * flipping it to `${ctx.userId}|${ctx.agentId}` does redden cases 1-3, but
   * it reddens them by changing the test double, not the shipped derivation
   * (which this package cannot even import). See the header.
   */
  function storeKey(ctx: { agentId: string; userId?: string | null }): string {
    return ctx.agentId;
  }

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

  function registerWorkspace(): void {
    bus.registerService('workspace:list', 'workspace', async (ctx) => {
      listCalls.push({ agentId: ctx.agentId, userId: ctx.userId ?? '' });
      const key = storeKey(ctx);
      return { paths: filesByAgent.get(key) ?? [] };
    });
    bus.registerService('workspace:read', 'workspace', async (ctx, i: unknown) => {
      const { path } = i as { path: string };
      readCalls.push({ agentId: ctx.agentId, userId: ctx.userId ?? '', path });
      const key = storeKey(ctx);
      const bytes = blobsByAgent.get(key)?.get(path);
      return bytes === undefined ? { found: false } : { found: true, bytes };
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
    blobsByAgent = new Map();
    identity = undefined;
    listCalls = [];
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
    blobsByAgent.clear();
    filesByAgent.set(TEAM_AGENT_ID, ['reports/q3-summary.md']);
    const blobs = new Map<string, Uint8Array>();
    blobs.set('reports/q3-summary.md', enc.encode('# Q3 summary\n\nRevenue is up.'));
    blobsByAgent.set(TEAM_AGENT_ID, blobs);
    identity?.seed(TEAM_AGENT_ID, { instructions: 'Always cite the source spreadsheet.' });
  }

  // ---------------------------------------------------------------------
  // 1. Files listing — bob sees alice's files.
  // ---------------------------------------------------------------------
  it('1. GET .../files: bob (a different authorized user) sees alice-written files', async () => {
    registerAuth({ id: 'bob', isAdmin: false });
    registerAgents();
    registerWorkspace();
    seedAliceFixtures();

    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: TEAM_AGENT_ID }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    const body = captured.body as AgentFilesResponse;
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files.map((f) => f.path)).toContain('reports/q3-summary.md');
  });

  // ---------------------------------------------------------------------
  // 2. File body — bob reads alice's bytes.
  // ---------------------------------------------------------------------
  it('2. GET .../files/*: bob reads the bytes alice wrote', async () => {
    registerAuth({ id: 'bob', isAdmin: false });
    registerAgents();
    registerWorkspace();
    seedAliceFixtures();

    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
      mkReq({ agentId: TEAM_AGENT_ID, '*': 'reports%2Fq3-summary.md' }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      path: 'reports/q3-summary.md',
      name: 'reports/q3-summary.md',
      body: '# Q3 summary\n\nRevenue is up.',
      clipped: null,
    } satisfies AgentFileResponse);
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
    it('404s the files listing without calling workspace:list', async () => {
      registerAuth({ id: 'mallory', isAdmin: false });
      registerAgents();
      registerWorkspace();
      seedAliceFixtures();

      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
        mkReq({ agentId: TEAM_AGENT_ID }),
        res,
      );

      expect(captured.statusCode).toBe(404);
      expect(listCalls).toHaveLength(0);
    });

    it('404s a file read without calling workspace:read', async () => {
      registerAuth({ id: 'mallory', isAdmin: false });
      registerAgents();
      registerWorkspace();
      seedAliceFixtures();

      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
        mkReq({ agentId: TEAM_AGENT_ID, '*': 'reports%2Fq3-summary.md' }),
        res,
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

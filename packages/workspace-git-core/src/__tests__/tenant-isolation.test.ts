// TASK-396 — cross-tenant isolation for the single-replica workspace backend.
//
// THE BUG THIS PINS. Before this file existed, `registerWorkspaceGitHooks`
// opened ONE bare repo (`<repoRoot>/repo.git`) at ONE ref (`refs/heads/main`)
// and ignored `ctx` on every read path. Every user and every agent in the
// deployment therefore shared one tree: a non-admin user opened the Files tab
// of their OWN agent on canopyworks.ai and was served a file another user's
// agent had written. The chart's default (`workspace.backend: local`) selects
// this backend, so this was the code actually serving production.
//
// A note on `workspaceRef`, because the original report named it. The agent
// row's `workspace_ref` column is NOT consumed by any workspace backend. So
// "every agent has workspace_ref = NULL" was never the mechanism, and filling
// that column in would have fixed nothing. Partitioning here is derived from
// `ctx.agentId` and nothing else. The acceptance criterion "a NULL
// workspace_ref never resolves to a shared ref" is pinned by `two agents that
// both have a null workspaceRef do not share a tree` below: the field is
// absent from this backend's inputs entirely, so two such agents are isolated
// by agentId or not at all.
//
// THE PARTITION IS `agentId` ALONE, matching `@ax/workspace-git-server` since
// TASK-257 (#573). That is a policy, not an accident, and it cuts both ways —
// so this file asserts BOTH directions: different agents must not see each
// other's files, and two users on the SAME agent must see the SAME tree. A
// backend that over-partitioned by (userId, agentId) would pass every
// isolation case here and silently fragment a team agent's shared files, which
// is why the second direction is tested rather than assumed.
//
// Every `it` in this file FAILS against the unpartitioned backend except the
// two explicitly labelled anti-vacuity guards. The direction each one fails in
// is written next to it, because a fail-closed assertion that passes either
// way is worse than no assertion at all.

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type {
  AgentContext,
  Plugin,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { OWNERLESS_ID_PREFIX, ownerlessIdFor } from '@ax/core';
import { registerWorkspaceGitHooks } from '../impl.js';

const enc = new TextEncoder();

function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-internal',
        'workspace:apply-bundle',
        'workspace:export-baseline-bundle',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot });
    },
  };
}

async function setup() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-tenant-'));
  const h = await createTestHarness({ plugins: [makeCorePlugin(repoRoot)] });
  const caller = (userId: string, agentId: string): AgentContext =>
    h.ctx({ userId, agentId, sessionId: `${userId}:${agentId}` });
  const write = (
    ctx: AgentContext,
    path: string,
    body: string,
    parent: WorkspaceApplyInput['parent'] = null,
  ) =>
    h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes: [{ path, kind: 'put', content: enc.encode(body) }],
      parent,
    });
  const list = (ctx: AgentContext) =>
    h.bus.call<WorkspaceListInput, WorkspaceListOutput>('workspace:list', ctx, {});
  const read = (ctx: AgentContext, path: string) =>
    h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', ctx, { path });
  const bareRepos = () => readdirSync(repoRoot).filter((d) => d.endsWith('.git')).sort();
  return { repoRoot, h, caller, write, list, read, bareRepos };
}

describe('@ax/workspace-git-core tenant isolation (TASK-396)', () => {
  it("does not serve one user's agent's file to a different user's agent", async () => {
    // The walk, reduced to its bones: vinay's agent writes; test@'s agent
    // opens its own Files tab. FAILS on the unpartitioned backend, where
    // `list` returns ['CAVEMAN-POEM.md'] and `read` returns the bytes.
    const { caller, write, list, read } = await setup();
    const vinay = caller('user-vinay', 'agent-vinay');
    const tester = caller('user-test', 'agent-test');

    await write(vinay, 'CAVEMAN-POEM.md', 'CAVEMAN POEM\nby Caveman\n');

    expect((await list(tester)).paths).toEqual([]);
    expect(await read(tester, 'CAVEMAN-POEM.md')).toEqual({ found: false });
  });

  it('two agents that both have a null workspaceRef do not share a tree', async () => {
    // Same user, two agents — the production shape, where every agent row
    // carries workspace_ref = NULL. Isolation must come from `ctx.agentId`,
    // and it must hold in BOTH directions so this cannot pass by returning
    // nothing to everyone. FAILS on the unpartitioned backend: each agent
    // sees the other's file.
    const { caller, write, list, read } = await setup();
    const first = caller('user-solo', 'agent-one');
    const second = caller('user-solo', 'agent-two');

    await write(first, 'one.md', 'from agent one');
    await write(second, 'two.md', 'from agent two');

    expect((await list(first)).paths).toEqual(['one.md']);
    expect((await list(second)).paths).toEqual(['two.md']);
    expect(await read(first, 'two.md')).toEqual({ found: false });
    expect(await read(second, 'one.md')).toEqual({ found: false });
  });

  it('still serves an owner its OWN file', async () => {
    // ANTI-VACUITY GUARD #1. A backend that answered "not found" to everybody
    // would satisfy every isolation test above and be completely broken; this
    // one passes BOTH before and after the fix, on purpose, and its job is to
    // fail if the fix over-reaches.
    const { caller, write, list, read } = await setup();
    const me = caller('user-vinay', 'agent-vinay');

    await write(me, 'mine.md', 'hello');

    expect((await list(me)).paths).toEqual(['mine.md']);
    const got = await read(me, 'mine.md');
    expect(got.found).toBe(true);
    expect(got.found === true && new TextDecoder().decode(got.bytes)).toBe('hello');
  });

  it('gives two users of the SAME agent the SAME tree (partition is agentId alone)', async () => {
    // ANTI-VACUITY GUARD #2, and the TASK-257 policy stated as a test. Also
    // passes before AND after the fix — before, because everything shared one
    // tree; after, because both callers derive the same workspaceId. It is
    // here to fail the *other* way: a backend keyed on (userId, agentId) —
    // which is what the first draft of this fix did — turns a team agent's
    // shared files into per-user fragments and diverges from
    // `@ax/workspace-git-server`. One bare repo on disk, not two, is the
    // structural half of that claim.
    const { caller, write, list, read, bareRepos } = await setup();
    const alice = caller('user-alice', 'agent-shared');
    const bob = caller('user-bob', 'agent-shared');

    await write(alice, 'team-notes.md', 'from alice');

    expect((await list(bob)).paths).toEqual(['team-notes.md']);
    const got = await read(bob, 'team-notes.md');
    expect(got.found).toBe(true);
    expect(got.found === true && new TextDecoder().decode(got.bytes)).toBe('from alice');
    expect(bareRepos()).toHaveLength(1);
  });

  it('keeps each agent in its own repo on disk — there is no shared repo.git', async () => {
    // The structural half of "a null workspaceRef never resolves to a shared
    // ref": not "B could not read A's file" but "there is no single tree for
    // them to share in the first place". FAILS on the unpartitioned backend,
    // which creates exactly one directory named `repo.git`.
    const { caller, write, list, bareRepos } = await setup();
    const a = await write(caller('user-a', 'agent-a'), 'a.md', 'a');
    await write(caller('user-b', 'agent-b'), 'b.md', 'b');

    expect(bareRepos()).not.toContain('repo.git');
    expect(bareRepos()).toHaveLength(2);
    // The same agentId must land on the same repo, or every turn would start
    // from an empty workspace. Passing the PARENT version returned by the
    // first apply is the proof: a fresh repo would reject it as a mismatch.
    const a2 = await write(caller('user-a', 'agent-a'), 'a2.md', 'a2', a.version);
    expect(bareRepos()).toHaveLength(2);
    // ...and a different USER on the same agent must NOT mint a third repo —
    // it continues the same history, from the same parent.
    await write(caller('user-z', 'agent-a'), 'a3.md', 'a3', a2.version);
    expect(bareRepos()).toHaveLength(2);
    expect((await list(caller('user-z', 'agent-a'))).paths).toEqual([
      'a.md',
      'a2.md',
      'a3.md',
    ]);
  });

  describe('fails closed when the caller has no agent', () => {
    // These are the ones most at risk of being written vacuously, so each
    // FIRST writes a file under a real agent and THEN asserts the agent-less
    // call rejects. Against the unpartitioned backend the call does not reject
    // at all — it succeeds and hands back that file — so "rejects" is a claim
    // that can only be true after the fix.
    const blank: ReadonlyArray<readonly [string, string, string]> = [
      ['empty agentId', 'user-a', ''],
      ['whitespace-only agentId', 'user-a', '   '],
      ['tab/newline-only agentId', 'user-a', '\t\n'],
      ['empty agentId and empty userId', '', ''],
    ];

    for (const [label, userId, agentId] of blank) {
      it(`rejects list/read/apply on ${label}`, async () => {
        const { caller, write, list, read } = await setup();
        await write(caller('user-a', 'agent-a'), 'secret.md', 'not yours');
        const anon = caller(userId, agentId);

        await expect(list(anon)).rejects.toMatchObject({
          code: 'workspace-identity-required',
        });
        await expect(read(anon, 'secret.md')).rejects.toMatchObject({
          code: 'workspace-identity-required',
        });
        await expect(write(anon, 'theirs.md', 'x')).rejects.toMatchObject({
          code: 'workspace-identity-required',
        });
      });
    }

    it('rejects rather than falling back to the legacy shared repo', async () => {
      // Belt and braces on the direction that actually matters: refusing must
      // not be implemented as "resolve to some default tree and find nothing
      // there". Nothing named `repo.git` may be created by an agent-less call,
      // no new bare repo may appear at all, and the real agent's tree must be
      // untouched.
      const { repoRoot, caller, write, list, bareRepos } = await setup();
      const me = caller('user-a', 'agent-a');
      await write(me, 'mine.md', 'hello');
      const before = bareRepos();

      await expect(list(caller('', ''))).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });

      expect(readdirSync(repoRoot)).not.toContain('repo.git');
      expect(bareRepos()).toEqual(before);
      expect((await list(me)).paths).toEqual(['mine.md']);
    });
  });

  // -------------------------------------------------------------------------
  // TASK-411 — the second instance of the class this file closed.
  //
  // #583 (this file's first eight cases) closed the path where an ABSENT agent
  // scope pooled everyone. The blank check above is what closes it. But the
  // two IPC listeners never sent a blank agentId: they substituted a CONSTANT
  // that looks like a real id — `'ipc-http'` / `'ipc-server'` — whenever a
  // session resolved with no owner. `requireAgent` waved it straight through,
  // hashed it, and handed every owner-less session in the deployment the SAME
  // bare repo. A null check cannot catch that, which is exactly why it
  // survived #583.
  //
  // The substitution is now `ownerlessIdFor(sessionId)` (per-session, and
  // MARKED). This block asserts the fail-closed half: a marked caller gets
  // NOTHING here. The direction matters and is stated deliberately — an empty
  // workspace, or an error, is a correct answer for a session with no owner;
  // another session's file never is.
  //
  // Why this belongs in the backend at all, given the listener was fixed: the
  // per-session id already stops the POOLING everywhere. This turns "your own
  // private, pointless repo" into "no repo", so an owner-less caller cannot
  // accumulate a tree at all. Both halves, because either alone is weaker.
  // -------------------------------------------------------------------------
  describe('fails closed when the caller has no OWNER (TASK-411)', () => {
    it('refuses list/read/apply for an owner-less caller', async () => {
      // Against unfixed code every one of these SUCCEEDS: the listener's
      // constant hashed to a real repo and the call was served from it.
      const { caller, write, list, read } = await setup();
      await write(caller('user-a', 'agent-a'), 'secret.md', 'not yours');
      const anon = caller(
        ownerlessIdFor('s-canary-1'),
        ownerlessIdFor('s-canary-1'),
      );

      await expect(list(anon)).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });
      await expect(read(anon, 'secret.md')).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });
      await expect(write(anon, 'theirs.md', 'x')).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });
    });

    it('two owner-less sessions cannot reach one shared tree', async () => {
      // The bug itself. Against unfixed code, session 1's write and session 2's
      // list both resolve to ws-sha256(["ipc-server"]) and the second call
      // returns the first session's file.
      const { caller, write, list } = await setup();
      const one = caller(ownerlessIdFor('s-1'), ownerlessIdFor('s-1'));
      const two = caller(ownerlessIdFor('s-2'), ownerlessIdFor('s-2'));

      await expect(write(one, 'pooled.md', 'session one')).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });
      await expect(list(two)).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });
    });

    it('creates no bare repo, and leaves the real agent untouched', async () => {
      const { repoRoot, caller, write, list, bareRepos } = await setup();
      const me = caller('user-a', 'agent-a');
      await write(me, 'mine.md', 'hello');
      const before = bareRepos();

      const anon = caller(ownerlessIdFor('s-x'), ownerlessIdFor('s-x'));
      await expect(write(anon, 'theirs.md', 'x')).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });

      expect(readdirSync(repoRoot)).not.toContain('repo.git');
      expect(bareRepos()).toEqual(before);
      expect((await list(me)).paths).toEqual(['mine.md']);
    });

    it('ANTI-VACUITY: a real agent whose id merely CONTAINS the marker still works', async () => {
      // Passes before and after the fix, on purpose. It pins that the refusal
      // is a PREFIX test on a reserved namespace, not a substring search that
      // would strand a real agent, and that the gate has not simply become
      // "refuse everything" — the failure mode a fail-closed patch is most
      // likely to ship by accident.
      const { caller, write, list } = await setup();
      const odd = caller('user-a', `agt_x-${OWNERLESS_ID_PREFIX}suffix`);
      await write(odd, 'fine.md', 'served');
      expect((await list(odd)).paths).toEqual(['fine.md']);
    });
  });
});

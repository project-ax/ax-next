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
// row's `workspace_ref` column is NOT consumed by any workspace backend — the
// chat-orchestrator calls it out as a deliberate pass-through. So "every agent
// has workspace_ref = NULL" was never the mechanism, and no amount of filling
// that column in would have fixed anything. Partitioning here is derived from
// the CALLER'S IDENTITY on `ctx` and nothing else. The acceptance criterion
// "a NULL workspace_ref never resolves to a shared ref" is pinned by
// `two agents that both have a null workspaceRef do not share a tree` below:
// the field is absent from this backend's inputs entirely, so two such agents
// are isolated by identity or not at all.
//
// Every `it` in this file FAILS against the unpartitioned backend. The
// direction each one fails in is written next to it, because a fail-closed
// assertion that passes either way is worse than no assertion at all.

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
  const owner = (userId: string, agentId: string): AgentContext =>
    h.ctx({ userId, agentId, sessionId: `${userId}:${agentId}` });
  const write = (ctx: AgentContext, path: string, body: string) =>
    h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes: [{ path, kind: 'put', content: enc.encode(body) }],
      parent: null,
    });
  const list = (ctx: AgentContext) =>
    h.bus.call<WorkspaceListInput, WorkspaceListOutput>('workspace:list', ctx, {});
  const read = (ctx: AgentContext, path: string) =>
    h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', ctx, { path });
  return { repoRoot, h, owner, write, list, read };
}

describe('@ax/workspace-git-core tenant isolation (TASK-396)', () => {
  it('does not serve one user\'s file to a different user', async () => {
    // The walk, reduced to its bones: vinay's agent writes; test@'s agent
    // opens its own Files tab. FAILS on the unpartitioned backend, where
    // `list` returns ['CAVEMAN-POEM.md'] and `read` returns the bytes.
    const { owner, write, list, read } = await setup();
    const vinay = owner('user-vinay', 'agent-vinay');
    const tester = owner('user-test', 'agent-test');

    await write(vinay, 'CAVEMAN-POEM.md', 'CAVEMAN POEM\nby Caveman\n');

    expect((await list(tester)).paths).toEqual([]);
    expect(await read(tester, 'CAVEMAN-POEM.md')).toEqual({ found: false });
  });

  it('two agents that both have a null workspaceRef do not share a tree', async () => {
    // Same user, two agents — the production shape, where every agent row
    // carries workspace_ref = NULL. Isolation must come from identity, and
    // it must hold in BOTH directions so this cannot pass by returning
    // nothing to everyone. FAILS on the unpartitioned backend: each agent
    // sees the other's file.
    const { owner, write, list, read } = await setup();
    const first = owner('user-solo', 'agent-one');
    const second = owner('user-solo', 'agent-two');

    await write(first, 'one.md', 'from agent one');
    await write(second, 'two.md', 'from agent two');

    expect((await list(first)).paths).toEqual(['one.md']);
    expect((await list(second)).paths).toEqual(['two.md']);
    expect(await read(first, 'two.md')).toEqual({ found: false });
    expect(await read(second, 'one.md')).toEqual({ found: false });
  });

  it('still serves an owner its OWN file', async () => {
    // The anti-vacuity guard for every assertion above. A backend that
    // answered "not found" to everybody would satisfy the isolation tests
    // and be completely broken; this one passes BOTH before and after the
    // fix, on purpose, and its job is to fail if the fix over-reaches.
    const { owner, write, list, read } = await setup();
    const me = owner('user-vinay', 'agent-vinay');

    await write(me, 'mine.md', 'hello');

    expect((await list(me)).paths).toEqual(['mine.md']);
    const got = await read(me, 'mine.md');
    expect(got.found).toBe(true);
    expect(got.found === true && new TextDecoder().decode(got.bytes)).toBe('hello');
  });

  it('keeps each owner in its own repo on disk — there is no shared repo.git', async () => {
    // The structural half of "a null workspaceRef never resolves to a shared
    // ref": not "B could not read A's file" but "there is no single tree for
    // them to share in the first place". FAILS on the unpartitioned backend,
    // which creates exactly one directory named `repo.git`.
    const { repoRoot, owner, write } = await setup();
    await write(owner('user-a', 'agent-a'), 'a.md', 'a');
    await write(owner('user-b', 'agent-b'), 'b.md', 'b');

    const dirs = readdirSync(repoRoot).filter((d) => d.endsWith('.git')).sort();
    expect(dirs).not.toContain('repo.git');
    expect(dirs).toHaveLength(2);
    // Same (userId, agentId) must land on the same repo, or every turn would
    // start from an empty workspace.
    await write(owner('user-a', 'agent-a'), 'a2.md', 'a2').catch(() => undefined);
    expect(readdirSync(repoRoot).filter((d) => d.endsWith('.git'))).toHaveLength(2);
  });

  describe('fails closed when the caller has no identity', () => {
    // These are the ones most at risk of being written vacuously, so each
    // FIRST writes a file under a real identity and THEN asserts the
    // identity-less call rejects. Against the unpartitioned backend the call
    // does not reject at all — it succeeds and hands back that file — so
    // "rejects" is a claim that can only be true after the fix.
    const blank: ReadonlyArray<readonly [string, string, string]> = [
      ['empty userId', '', 'agent-a'],
      ['empty agentId', 'user-a', ''],
      ['whitespace-only userId', '   ', 'agent-a'],
      ['whitespace-only agentId', 'user-a', '\t\n'],
    ];

    for (const [label, userId, agentId] of blank) {
      it(`rejects list/read/apply on ${label}`, async () => {
        const { owner, write, list, read } = await setup();
        await write(owner('user-a', 'agent-a'), 'secret.md', 'not yours');
        const anon = owner(userId, agentId);

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
      // there". Nothing named `repo.git` may be created by an identity-less
      // call, and the real owner's tree must be untouched.
      const { repoRoot, owner, write, list } = await setup();
      const me = owner('user-a', 'agent-a');
      await write(me, 'mine.md', 'hello');

      await expect(list(owner('', ''))).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });

      expect(readdirSync(repoRoot)).not.toContain('repo.git');
      expect((await list(me)).paths).toEqual(['mine.md']);
    });
  });
});

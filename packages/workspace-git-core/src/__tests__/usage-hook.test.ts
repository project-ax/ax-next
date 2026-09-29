// TASK-690 -- `workspace:usage` reports how many bytes the CALLER'S workspace
// occupies on this backend's storage. The disk-quota plugin builds a per-owner
// limit on this number, so the things worth pinning are: it grows when the
// workspace grows, it is per agent (one agent's writes never move another's
// number), it reads without creating anything, and it fails closed for a
// caller with no identity exactly like every other workspace hook.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type {
  AgentContext,
  Plugin,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceUsageInput,
  WorkspaceUsageOutput,
} from '@ax/core';
import { ownerlessIdFor } from '@ax/core';
import { registerWorkspaceGitHooks } from '../impl.js';

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
        'workspace:usage',
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
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-usage-'));
  const h = await createTestHarness({ plugins: [makeCorePlugin(repoRoot)] });
  const caller = (userId: string, agentId: string): AgentContext =>
    h.ctx({ userId, agentId, sessionId: `${userId}:${agentId}` });
  const usage = (ctx: AgentContext) =>
    h.bus.call<WorkspaceUsageInput, WorkspaceUsageOutput>('workspace:usage', ctx, {});
  const write = (ctx: AgentContext, path: string, content: Uint8Array, parent: WorkspaceApplyInput['parent'] = null) =>
    h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes: [{ path, kind: 'put', content }],
      parent,
    });
  const list = (ctx: AgentContext) =>
    h.bus.call<WorkspaceListInput, WorkspaceListOutput>('workspace:list', ctx, {});
  const bareRepos = () => readdirSync(repoRoot).filter((d) => d.endsWith('.git')).sort();
  return { repoRoot, h, caller, usage, write, list, bareRepos };
}

describe('@ax/workspace-git-core workspace:usage (TASK-690)', () => {
  it('is registered, so callers can probe for it', async () => {
    const { h } = await setup();
    expect(h.bus.hasService('workspace:usage')).toBe(true);
  });

  it('reports exactly 0 for an agent whose workspace has never been touched, and creates nothing', async () => {
    // "No workspace yet" is 0, not an error and not an init: a measurement must
    // not be the thing that materializes a repo.
    const { caller, usage, bareRepos } = await setup();
    expect(await usage(caller('user-a', 'agent-a'))).toEqual({ bytes: 0 });
    expect(bareRepos()).toEqual([]);
  });

  it('reports a small positive number once the repo exists but holds no files', async () => {
    // `workspace:list` initializes the repo (empty listing). Whatever the
    // backend's scaffolding weighs, it is real bytes: positive, and tiny next
    // to any file a person would write.
    const { caller, usage, list } = await setup();
    const me = caller('user-a', 'agent-a');
    expect((await list(me)).paths).toEqual([]);
    const { bytes } = await usage(me);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(100_000);
  });

  it('grows after a write of an incompressible 200 KB file', async () => {
    const { caller, usage, write } = await setup();
    const me = caller('user-a', 'agent-a');
    const before = (await usage(me)).bytes;

    await write(me, 'big.bin', randomBytes(200_000));

    const after = (await usage(me)).bytes;
    // git stores the blob zlib-compressed; random bytes do not shrink, so the
    // repo holds at least ~200 KB. Assert half of that to stay off the edge.
    expect(after).toBeGreaterThanOrEqual(100_000);
    expect(after).toBeGreaterThan(before);
  });

  it('keeps history: overwriting a file does not shrink the number', async () => {
    // History is what fills a disk, and it is what this measures. The old
    // 200 KB blob is still in the repo after the file is replaced.
    const { caller, usage, write } = await setup();
    const me = caller('user-a', 'agent-a');
    const first = await write(me, 'big.bin', randomBytes(200_000));
    const afterFirst = (await usage(me)).bytes;

    await write(me, 'big.bin', new TextEncoder().encode('tiny'), first.version);

    expect((await usage(me)).bytes).toBeGreaterThanOrEqual(afterFirst);
  });

  it("measures each agent on its own: A's writes do not move B's number", async () => {
    const { caller, usage, write } = await setup();
    const a = caller('user-a', 'agent-a');
    const b = caller('user-a', 'agent-b'); // same user, different agent

    await write(b, 'small.md', new TextEncoder().encode('hello'));
    const bBefore = (await usage(b)).bytes;
    expect(await usage(a)).toEqual({ bytes: 0 });

    await write(a, 'big.bin', randomBytes(200_000));

    expect((await usage(a)).bytes).toBeGreaterThanOrEqual(100_000);
    expect((await usage(b)).bytes).toBe(bBefore);
    // Anti-vacuity: B's number is a real measurement, not a constant 0.
    expect(bBefore).toBeGreaterThan(0);
  });

  it('routes by agent, not by user: two users on one agent see one number', async () => {
    const { caller, usage, write } = await setup();
    await write(caller('user-a', 'agent-shared'), 'big.bin', randomBytes(200_000));

    const viaA = await usage(caller('user-a', 'agent-shared'));
    const viaB = await usage(caller('user-b', 'agent-shared'));
    expect(viaB).toEqual(viaA);
    expect(viaA.bytes).toBeGreaterThanOrEqual(100_000);
  });

  describe('fails closed when the caller has no agent', () => {
    // Same two refusals as every other workspace hook. Each FIRST writes under
    // a real agent so "rejects" cannot pass vacuously against a backend that
    // answers everyone with a deployment-wide total.
    const blank: ReadonlyArray<readonly [string, string, string]> = [
      ['empty agentId', 'user-a', ''],
      ['whitespace-only agentId', 'user-a', '   '],
      ['empty agentId and empty userId', '', ''],
    ];

    for (const [label, userId, agentId] of blank) {
      it(`rejects on ${label}`, async () => {
        const { caller, usage, write } = await setup();
        await write(caller('user-a', 'agent-a'), 'secret.md', new TextEncoder().encode('not yours'));
        await expect(usage(caller(userId, agentId))).rejects.toMatchObject({
          code: 'workspace-identity-required',
        });
      });
    }

    it('rejects an owner-less stand-in id', async () => {
      const { caller, usage, write, bareRepos } = await setup();
      await write(caller('user-a', 'agent-a'), 'secret.md', new TextEncoder().encode('not yours'));
      const before = bareRepos();

      const anon = caller(ownerlessIdFor('s-canary-1'), ownerlessIdFor('s-canary-1'));
      await expect(usage(anon)).rejects.toMatchObject({
        code: 'workspace-identity-required',
      });
      expect(bareRepos()).toEqual(before);
    });
  });
});

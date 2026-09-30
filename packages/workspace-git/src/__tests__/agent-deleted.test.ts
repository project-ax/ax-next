// TASK-719 -- the plugin (not just the core helper) is wired for agent delete:
// its manifest declares the `agents:deleted` subscription, and loading the
// plugin is enough for a deleted agent's repo to be removed and
// `workspace:deleted` to fire. The behaviour in depth is pinned in
// `@ax/workspace-git-core`'s agent-deleted.test.ts; this file only proves the
// wrapper reaches it.

import { mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type { WorkspaceApplyInput, WorkspaceApplyOutput } from '@ax/core';
import { createWorkspaceGitPlugin } from '../plugin.js';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe('@ax/workspace-git agents:deleted (TASK-719)', () => {
  it('declares the agents:deleted subscription in its manifest', () => {
    const p = createWorkspaceGitPlugin({ repoRoot: '/tmp/repo' });
    expect(p.manifest.subscribes).toEqual(['agents:deleted']);
  });

  it('removes a deleted agent repo and fires workspace:deleted, leaving the other agent alone', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-git-agent-deleted-'));
    roots.push(repoRoot);
    const h = await createTestHarness({ plugins: [createWorkspaceGitPlugin({ repoRoot })] });
    const fired: unknown[] = [];
    h.bus.subscribe('workspace:deleted', 'test-recorder', async (_ctx, p) => {
      fired.push(p);
      return undefined;
    });
    const write = (agentId: string) =>
      h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx({ agentId, userId: 'u1', sessionId: `s-${agentId}` }),
        { changes: [{ path: 'f.md', kind: 'put', content: new TextEncoder().encode('x') }], parent: null },
      );
    await write('agent-a');
    await write('agent-b');
    const repos = () => readdirSync(repoRoot).filter((d) => d.endsWith('.git'));
    expect(repos()).toHaveLength(2);

    await h.bus.fire('agents:deleted', h.ctx(), { agentId: 'agent-a', ownerId: 'u1', ownerType: 'user' });

    expect(repos()).toHaveLength(1);
    expect(fired).toStrictEqual([{ agentId: 'agent-a' }]);
    await expect(write('agent-a')).rejects.toMatchObject({ code: 'agent-deleted' });
    await h.close();
  });
});

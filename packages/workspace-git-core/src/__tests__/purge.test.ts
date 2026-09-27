// TASK-576 — `workspace:purge` on the single-replica git backend.
//
// Real git, real temp dirs, driven through the hook bus exactly the way the
// one-time memory-wipe migration drives it. The purge is irreversible and runs
// once against every agent's workspace in production, so each property below
// is one we would otherwise only find out about after the data is gone.

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import {
  PluginError,
  type AgentContext,
  type FileChange,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspacePurgeInput,
  type WorkspacePurgeOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import { registerWorkspaceGitHooks, workspaceIdForAgent } from '../impl.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const SELECTOR: WorkspacePurgeInput = {
  prefixes: ['memory/', 'permanent/memory/facts/'],
  keep: ['memory/system/rules.md'],
};

function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-purge-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-internal',
        'workspace:apply-bundle',
        'workspace:export-baseline-bundle',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
        'workspace:purge',
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
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-purge-'));
  const h = await createTestHarness({ plugins: [makeCorePlugin(repoRoot)] });
  const caller = (agentId: string): AgentContext =>
    h.ctx({ userId: 'user-1', agentId, sessionId: `s:${agentId}` });
  const apply = (ctx: AgentContext, changes: FileChange[], parent: WorkspaceVersion | null) =>
    h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes,
      parent,
    });
  const list = (ctx: AgentContext, version?: WorkspaceVersion) =>
    h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
      'workspace:list',
      ctx,
      version === undefined ? {} : { version },
    );
  const read = (ctx: AgentContext, path: string, version?: WorkspaceVersion) =>
    h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      version === undefined ? { path } : { path, version },
    );
  const purge = (ctx: AgentContext, input: WorkspacePurgeInput = SELECTOR) =>
    h.bus.call<WorkspacePurgeInput, WorkspacePurgeOutput>('workspace:purge', ctx, input);
  const text = async (ctx: AgentContext, path: string, version?: WorkspaceVersion) => {
    const r = await read(ctx, path, version);
    return r.found ? dec.decode(r.bytes) : null;
  };
  return { repoRoot, h, caller, apply, list, read, purge, text };
}

const put = (path: string, body: string): FileChange => ({
  path,
  kind: 'put',
  content: enc.encode(body),
});
const del = (path: string): FileChange => ({ path, kind: 'delete' });

/** Seeds an agent's workspace over several applies, including deletes. */
async function seed(
  s: Awaited<ReturnType<typeof setup>>,
  ctx: AgentContext,
): Promise<WorkspaceVersion[]> {
  const versions: WorkspaceVersion[] = [];
  let parent: WorkspaceVersion | null = null;
  const step = async (changes: FileChange[]) => {
    const out = await s.apply(ctx, changes, parent);
    parent = out.version;
    versions.push(out.version);
  };
  await step([
    put('.ax/IDENTITY.md', 'I am the agent.\n'),
    put('memory/system/rules.md', 'Rule 1: be kind.\n'),
    put('memory/system/agent.md', 'derived agent summary\n'),
    put('notes/x.md', 'a note\n'),
  ]);
  await step([
    put('memory/docs/secret-a.md', 'SECRET-A the user told me\n'),
    put('permanent/memory/facts/profile.md', 'FACT: lives in Lisbon\n'),
  ]);
  await step([del('memory/docs/secret-a.md'), put('memory/inbox/1.md', 'inbox item\n')]);
  await step([
    put('memory/system/rules.md', 'Rule 1: be kind.\nRule 2: be brief.\n'),
    put('notes/x.md', 'a note, edited\n'),
  ]);
  return versions;
}

describe('@ax/workspace-git-core workspace:purge (TASK-576)', () => {
  it('removes the selector from the tip and from every past version; keeps rules + other files byte-identical', async () => {
    const s = await setup();
    const agent = s.caller('agent-purge');
    const versions = await seed(s, agent);
    const oldHead = versions[versions.length - 1]!;
    const oldSecretVersion = versions[1]!;
    expect(await s.text(agent, 'memory/docs/secret-a.md', oldSecretVersion)).toBe(
      'SECRET-A the user told me\n',
    );

    const out = await s.purge(agent);
    expect(out.pastVersionsChanged).toBe(true);
    expect(out.version).not.toBeNull();
    expect(out.version).not.toBe(oldHead);
    expect(out.purged).toEqual([
      'memory/docs/secret-a.md',
      'memory/inbox/1.md',
      'memory/system/agent.md',
      'permanent/memory/facts/profile.md',
    ]);

    // Current tree: purged paths gone, everything else intact byte-for-byte.
    expect((await s.list(agent)).paths).toEqual([
      '.ax/IDENTITY.md',
      'memory/system/rules.md',
      'notes/x.md',
    ]);
    expect(await s.text(agent, 'memory/system/rules.md')).toBe(
      'Rule 1: be kind.\nRule 2: be brief.\n',
    );
    expect(await s.text(agent, '.ax/IDENTITY.md')).toBe('I am the agent.\n');
    expect(await s.text(agent, 'notes/x.md')).toBe('a note, edited\n');

    // Old version ids no longer resolve — not even for untouched paths.
    expect(await s.read(agent, 'memory/docs/secret-a.md', oldSecretVersion)).toEqual({
      found: false,
    });
    expect(await s.read(agent, 'notes/x.md', oldHead)).toEqual({ found: false });

    // The returned version is a real, usable version for list + diff.
    const v = out.version!;
    expect((await s.list(agent, v)).paths).toContain('notes/x.md');
    const diff = await s.h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>(
      'workspace:diff',
      agent,
      { from: null, to: v },
    );
    expect(diff.delta.changes.map((c) => c.path)).toEqual([
      '.ax/IDENTITY.md',
      'memory/system/rules.md',
      'notes/x.md',
    ]);
  });

  it('apply continues from the returned version; the pre-purge version is a parent-mismatch', async () => {
    const s = await setup();
    const agent = s.caller('agent-continue');
    const versions = await seed(s, agent);
    const oldHead = versions[versions.length - 1]!;
    const out = await s.purge(agent);

    const stale = await s
      .apply(agent, [put('notes/y.md', 'late')], oldHead)
      .then(() => null, (e: unknown) => e);
    expect(stale).toBeInstanceOf(PluginError);
    expect((stale as PluginError).code).toBe('parent-mismatch');

    const next = await s.apply(agent, [put('notes/y.md', 'after purge')], out.version);
    expect(await s.text(agent, 'notes/y.md', next.version)).toBe('after purge');
  });

  it('a second purge is a no-op at the same version', async () => {
    const s = await setup();
    const agent = s.caller('agent-twice');
    await seed(s, agent);
    const first = await s.purge(agent);
    const second = await s.purge(agent);
    expect(second).toEqual({ purged: [], version: first.version, pastVersionsChanged: false });
  });

  it("leaves another agent's workspace untouched", async () => {
    const s = await setup();
    const target = s.caller('agent-target');
    const bystander = s.caller('agent-bystander');
    await seed(s, target);
    const bystanderVersions = await seed(s, bystander);
    const bystanderHead = bystanderVersions[bystanderVersions.length - 1]!;
    const before = (await s.list(bystander)).paths;

    await s.purge(target);

    expect((await s.list(bystander)).paths).toEqual(before);
    const after = await s.read(bystander, 'memory/inbox/1.md');
    expect(after.found && after.version).toBe(bystanderHead);
    // Its history is intact too.
    expect(await s.text(bystander, 'memory/docs/secret-a.md', bystanderVersions[1]!)).toBe(
      'SECRET-A the user told me\n',
    );
  });

  it('a missing workspace answers version null and does not create a repo', async () => {
    const s = await setup();
    const agent = s.caller('agent-never-wrote');
    const out = await s.purge(agent);
    expect(out).toEqual({ purged: [], version: null, pastVersionsChanged: false });
    expect(existsSync(join(s.repoRoot, `${workspaceIdForAgent('agent-never-wrote')}.git`))).toBe(
      false,
    );
    expect(readdirSync(s.repoRoot)).toEqual([]);
  });

  it('a workspace with nothing under the selector is a no-op', async () => {
    const s = await setup();
    const agent = s.caller('agent-clean');
    const out1 = await s.apply(agent, [put('notes/only.md', 'x')], null);
    const out = await s.purge(agent);
    expect(out).toEqual({ purged: [], version: out1.version, pastVersionsChanged: false });
  });

  it('rejects an invalid selector before touching storage', async () => {
    const s = await setup();
    const agent = s.caller('agent-bad-selector');
    const bad: WorkspacePurgeInput[] = [
      { prefixes: [] },
      { prefixes: ['memory'] },
      { prefixes: ['../memory/'] },
      { prefixes: ['memory/'], keep: ['notes/x.md'] },
    ];
    for (const input of bad) {
      const err = await s.purge(agent, input).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).code).toBe('invalid-input');
    }
    expect(readdirSync(s.repoRoot)).toEqual([]);
  });

  it('refuses a caller with no agent identity', async () => {
    const s = await setup();
    const err = await s
      .purge(s.h.ctx({ userId: 'u', agentId: '', sessionId: 's' }))
      .then(() => null, (e: unknown) => e);
    expect((err as PluginError).code).toBe('workspace-identity-required');
  });

  it('is serialized with a concurrent apply (no lost write)', async () => {
    const s = await setup();
    const agent = s.caller('agent-race');
    const versions = await seed(s, agent);
    const head = versions[versions.length - 1]!;

    const [applied, purged] = await Promise.allSettled([
      s.apply(agent, [put('notes/race.md', 'raced')], head),
      s.purge(agent),
    ]);
    expect(purged.status).toBe('fulfilled');
    const paths = (await s.list(agent)).paths;
    if (applied.status === 'fulfilled') {
      // The apply landed (before the purge, which then carried it through the
      // rewrite, or after it): its write must survive.
      expect(paths).toContain('notes/race.md');
      expect(await s.text(agent, 'notes/race.md')).toBe('raced');
    } else {
      // The purge landed first; the apply saw a moved head. Never silent.
      expect((applied.reason as PluginError).code).toBe('parent-mismatch');
      expect(paths).not.toContain('notes/race.md');
    }
    expect(paths.filter((p) => p.startsWith('memory/') && p !== 'memory/system/rules.md')).toEqual(
      [],
    );
  });
});

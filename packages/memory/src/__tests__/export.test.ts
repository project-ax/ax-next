import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_FACTS_EXPORT_ROOT, type AgentContext } from '@ax/core';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';

import { MEMORY_EXPORT_FLUSH_HOOK } from '../exporter.js';
import {
  ALICE,
  BOB,
  engineRecord,
  makeMemoryHarness,
  type MemoryHarness,
} from './harness.js';

const ROOT = MEMORY_FACTS_EXPORT_ROOT;
const dirs: string[] = [];
const harnesses: MemoryHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.teardown();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeExportHarness(options: Parameters<typeof makeMemoryHarness>[1] = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ax-export-ws-'));
  dirs.push(repoRoot);
  const h = await makeMemoryHarness({ exports: { debounceMs: 5 } }, options);
  harnesses.push(h);
  const ws = createWorkspaceGitPlugin({ repoRoot });
  await ws.init({ bus: h.bus });
  const flush = (ctx?: AgentContext) =>
    h.bus.call<Record<string, never>, { changed: boolean }>(
      MEMORY_EXPORT_FLUSH_HOOK,
      ctx ?? h.ctx(),
      {},
    );
  const listPaths = async (ctx?: AgentContext): Promise<string[]> => {
    const out = await h.bus.call<{ pathGlob: string }, { paths: string[] }>(
      'workspace:list',
      ctx ?? h.ctx(),
      { pathGlob: `${ROOT}/**` },
    );
    return out.paths;
  };
  const readText = async (path: string, ctx?: AgentContext): Promise<string> => {
    const out = await h.bus.call<{ path: string }, { found: boolean; bytes?: Uint8Array }>(
      'workspace:read',
      ctx ?? h.ctx(),
      { path },
    );
    if (!out.found) throw new Error(`not found: ${path}`);
    return Buffer.from(out.bytes!).toString('utf-8');
  };
  return { h, flush, listPaths, readText };
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

describe('memory facts export — real engine + real workspace-git', () => {
  it('a first export into a workspace that already has commits succeeds and preserves existing files', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness();
    await h.bus.call(
      'workspace:apply',
      h.ctx(),
      {
        parent: null,
        reason: 'seed',
        changes: [
          { path: '.ax/IDENTITY.md', kind: 'put', content: Buffer.from('# me\n') },
        ],
      },
    );
    await h.remember({ about: 'user', relation: 'lives in', value: 'seeded-tea' });
    const result = await flush();
    expect(result.changed).toBe(true);
    expect(await readText('.ax/IDENTITY.md')).toBe('# me\n');
    const paths = await listPaths();
    expect(paths).toContain(`${ROOT}/profile.md`);
    const profile = await readText(`${ROOT}/profile.md`);
    expect(profile).toContain('seeded-tea');
  });

  it('publishes profile/recent/journal files through the real workspace', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness();
    await h.remember({ about: 'user', relation: 'lives in', value: 'Seattle' });
    const result = await flush();
    expect(result.changed).toBe(true);
    const paths = await listPaths();
    expect(paths).toEqual(
      expect.arrayContaining([
        `${ROOT}/profile.md`,
        `${ROOT}/recent.md`,
        `${ROOT}/user/${thisMonth()}.md`,
      ]),
    );
    const profile = await readText(`${ROOT}/profile.md`);
    expect(profile).toContain('Seattle');
  });

  it('exports more than one scan page — no hidden recall limit', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness();
    const statements = Array.from({ length: 250 }, (_, i) => ({
      about: 'user:user-alice',
      relation: 'noted',
      value: `fact-${i}`,
      when: '2026-09-01T00:00:00.000Z',
      provenance: 'extracted' as const,
      ownerUserId: ALICE,
    }));
    await engineRecord(h.bus, h.ctx(), statements);
    await flush();
    const paths = await listPaths();
    const journal = paths.find((p) => p.startsWith(`${ROOT}/user/`));
    expect(journal).toBeDefined();
    const text = await readText(journal!);
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(250);
    expect(text).toContain('fact-0');
    expect(text).toContain('fact-249');
  });

  it('keys journal months by server recordedAt even for wild when values', async () => {
    const { h, flush, listPaths } = await makeExportHarness();
    await engineRecord(h.bus, h.ctx(), [
      { about: 'user:user-alice', relation: 'saw', value: 'comet', when: '1900-01-01T00:00:00.000Z', ownerUserId: ALICE },
      { about: 'user:user-alice', relation: 'will see', value: 'parade', when: '3000-12-31T00:00:00.000Z', ownerUserId: ALICE },
    ]);
    await flush();
    const paths = await listPaths();
    const journals = paths.filter((p) => p.startsWith(`${ROOT}/user/`));
    expect(journals).toEqual([`${ROOT}/user/${thisMonth()}.md`]);
  });

  it('a personal agent’s export excludes rows owned by someone else', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness();
    await engineRecord(h.bus, h.ctx(), [
      { about: 'user:user-alice', relation: 'likes', value: 'alice-tea', when: '2026-09-01T00:00:00.000Z', ownerUserId: ALICE },
      { about: 'user:user-bob', relation: 'likes', value: 'bob-secret', when: '2026-09-01T00:00:00.000Z', ownerUserId: BOB },
    ]);
    await flush();
    const paths = await listPaths();
    const journal = paths.find((p) => p.startsWith(`${ROOT}/user/`))!;
    const text = await readText(journal);
    expect(text).toContain('alice-tea');
    expect(text).not.toContain('bob-secret');
  });

  it('a team agent exports every member’s rows regardless of who triggers the flush', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness({
      agent: { visibility: 'team' },
    });
    await h.remember(
      { about: 'user', relation: 'lives in', value: 'Seattle' },
      h.ctx({ userId: ALICE }),
    );
    await h.remember(
      { about: 'user', relation: 'works at', value: 'Bob Co' },
      h.ctx({ userId: BOB }),
    );
    const bobCtx = h.ctx({ userId: BOB });
    await flush(bobCtx);
    const paths = await listPaths(bobCtx);
    const journal = paths.find((p) => p.startsWith(`${ROOT}/user/`))!;
    const byBob = await readText(journal, bobCtx);

    const aliceCtx = h.ctx({ userId: ALICE });
    await flush(aliceCtx);
    const byAlice = await readText(journal, aliceCtx);

    expect(byBob).toBe(byAlice);
    expect(byBob).toContain('Seattle');
    expect(byBob).toContain('Bob Co');
    expect(byBob).toContain('## user:user-alice');
    expect(byBob).toContain('## user:user-bob');

    const profile = await readText(`${ROOT}/profile.md`, aliceCtx);
    expect(profile).toContain('## user:user-alice');
    expect(profile).toContain('## user:user-bob');
  });

  it('two agents never share a projection', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness();
    const agent1 = h.ctx({ agentId: 'agent-1' });
    const agent2 = h.ctx({ agentId: 'agent-2' });
    await h.remember({ about: 'user', relation: 'likes', value: 'agent1-tea' }, agent1);
    await h.remember({ about: 'user', relation: 'likes', value: 'agent2-coffee' }, agent2);
    await flush(agent1);
    await flush(agent2);
    const p1 = await listPaths(agent1);
    const p2 = await listPaths(agent2);
    expect(p1.some((p) => p.startsWith(`${ROOT}/user/`))).toBe(true);
    expect(p2.some((p) => p.startsWith(`${ROOT}/user/`))).toBe(true);
    const j1 = p1.find((p) => p.startsWith(`${ROOT}/user/`))!;
    const j2 = p2.find((p) => p.startsWith(`${ROOT}/user/`))!;
    const t1 = await readText(j1, agent1);
    const t2 = await readText(j2, agent2);
    expect(t1).toContain('agent1-tea');
    expect(t1).not.toContain('agent2-coffee');
    expect(t2).toContain('agent2-coffee');
    expect(t2).not.toContain('agent1-tea');
  });

  it('an unchanged projection makes no second apply and returns changed:false', async () => {
    const { h, flush } = await makeExportHarness();
    let applies = 0;
    h.bus.subscribe('workspace:applied', 'test', async () => {
      applies += 1;
    });
    await h.remember({ about: 'user', relation: 'likes', value: 'tea' });
    await flush();
    expect(applies).toBe(1);
    const again = await flush();
    expect(again.changed).toBe(false);
    expect(applies).toBe(1);
  });

  it('a revoked member is refused before anything is published', async () => {
    const { h, flush } = await makeExportHarness({
      agent: { visibility: 'team' },
    });
    h.teamMembers.delete(BOB);
    await expect(flush(h.ctx({ userId: BOB }))).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('sandbox:memory-mounts resolver', () => {
  async function makeVolumeHarness(options: Parameters<typeof makeMemoryHarness>[1] = {}) {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ax-export-ws-'));
    const hostRoot = await mkdtemp(join(tmpdir(), 'ax-export-vol-'));
    dirs.push(repoRoot, hostRoot);
    const h = await makeMemoryHarness(
      {
        exports: {
          debounceMs: 5,
          volume: {
            hostRoot,
            backing: { server: 'nfs.internal', exportPath: '/srv/ax/memory' },
          },
        },
      },
      options,
    );
    const ws = createWorkspaceGitPlugin({ repoRoot });
    await ws.init({ bus: h.bus });
    harnesses.push(h);
    const resolveMounts = (owner: { agentId: string; userId: string }) =>
      h.bus.call<unknown, { mounts: Array<Record<string, unknown>> }>(
        'sandbox:memory-mounts',
        h.ctx(),
        { owner },
      );
    return { h, hostRoot, resolveMounts };
  }

  it('returns exactly one read-only nfs mount at /memory under the hashed agent dir', async () => {
    const { resolveMounts } = await makeVolumeHarness();
    const { mounts } = await resolveMounts({ agentId: 'agent-1', userId: ALICE });
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      kind: 'nfs',
      role: 'memory',
      mountPath: '/memory',
      server: 'nfs.internal',
      exportPath: '/srv/ax/memory',
      readOnly: true,
    });
    expect(mounts[0]!.subPath).toMatch(/^[0-9a-f]{64}\/permanent\/memory\/facts$/);
  });

  it('publishes the projection into the host volume during mount resolution', async () => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness();
    await h.remember({ about: 'user', relation: 'lives in', value: 'Portland' });
    await resolveMounts({ agentId: 'agent-1', userId: ALICE });
    const { readdirSync, readFileSync } = await import('node:fs');
    const key = readdirSync(hostRoot);
    expect(key).toHaveLength(1);
    const profile = readFileSync(
      join(hostRoot, key[0]!, 'permanent/memory/facts/profile.md'),
      'utf-8',
    );
    expect(profile).toContain('Portland');
  });

  it('a volume sync failure means no mount is returned', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ax-export-ws-'));
    const badHostRoot = join(await mkdtemp(join(tmpdir(), 'ax-export-vol-')), 'occupied');
    dirs.push(repoRoot, badHostRoot);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(badHostRoot, 'not a dir');
    const h = await makeMemoryHarness({
      exports: {
        debounceMs: 5,
        volume: { hostRoot: badHostRoot, backing: { server: 'nfs.internal', exportPath: '/srv/ax/memory' } },
      },
    });
    harnesses.push(h);
    const ws = createWorkspaceGitPlugin({ repoRoot });
    await ws.init({ bus: h.bus });
    await expect(
      h.bus.call('sandbox:memory-mounts', h.ctx(), {
        owner: { agentId: 'agent-1', userId: ALICE },
      }),
    ).rejects.toThrow();
  });

  it('an owner the ACL refuses gets no mount', async () => {
    const { resolveMounts } = await makeVolumeHarness();
    await expect(
      resolveMounts({ agentId: 'agent-1', userId: 'intruder' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a team agent’s members resolve the same agent dir', async () => {
    const { resolveMounts } = await makeVolumeHarness({
      agent: { visibility: 'team' },
    });
    const a = await resolveMounts({ agentId: 'agent-1', userId: ALICE });
    const b = await resolveMounts({ agentId: 'agent-1', userId: BOB });
    expect(a.mounts[0]!.subPath).toBe(b.mounts[0]!.subPath);
  });

  it('no volume configured → the hook is not registered', async () => {
    const { h } = await makeExportHarness();
    await expect(
      h.bus.call('sandbox:memory-mounts', h.ctx(), {
        owner: { agentId: 'agent-1', userId: ALICE },
      }),
    ).rejects.toThrow();
  });
});

describe('memory export wiring', () => {
  it('remember schedules an export without a manual flush', async () => {
    const { h, listPaths } = await makeExportHarness();
    await h.remember({ about: 'user', relation: 'likes', value: 'auto-tea' });
    await vi.waitFor(
      async () => expect((await listPaths()).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
  });

  it('plugin without exports config registers no flush service', async () => {
    const h: MemoryHarness = await makeMemoryHarness();
    harnesses.push(h);
    await expect(
      h.bus.call(MEMORY_EXPORT_FLUSH_HOOK, h.ctx(), {}),
    ).rejects.toThrow();
  });
});

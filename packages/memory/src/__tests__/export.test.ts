import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext, AgentContextSource } from '@ax/core';
import { MEMORY_FACTS_EXPORT_ROOT } from '@ax/sandbox-protocol';

import { MEMORY_EXPORT_FLUSH_HOOK } from '../exporter.js';
import { memoryMountSpec, volumeAgentKey } from '../export-volume.js';
import { createMemoryPlugin } from '../plugin.js';
import {
  ALICE,
  BOB,
  engineRecord,
  eventsNamed,
  makeMemoryHarness,
  type MemoryHarness,
} from './harness.js';

const ROOT = MEMORY_FACTS_EXPORT_ROOT;
const BACKING = { server: 'nfs.internal', exportPath: '/srv/ax/memory' };
const dirs: string[] = [];
const harnesses: MemoryHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.teardown();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeExportHarness(options: Parameters<typeof makeMemoryHarness>[1] = {}) {
  const hostRoot = await mkdtemp(join(tmpdir(), 'ax-export-vol-'));
  dirs.push(hostRoot);
  const h = await makeMemoryHarness(
    { exports: { debounceMs: 5, volume: { hostRoot, backing: BACKING } } },
    options,
  );
  harnesses.push(h);
  const flush = (ctx?: AgentContext) =>
    h.bus.call<Record<string, never>, { changed: boolean }>(
      MEMORY_EXPORT_FLUSH_HOOK,
      ctx ?? h.ctx(),
      {},
    );
  // The agent's own slot in the volume. Facts paths (`${ROOT}/…`) are relative to it.
  const agentDir = (ctx?: AgentContext): string =>
    join(hostRoot, volumeAgentKey((ctx ?? h.ctx()).agentId));
  const listPaths = async (ctx?: AgentContext): Promise<string[]> => {
    const paths: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return [];
          throw err;
        },
      );
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}/${entry.name}`);
        else paths.push(`${rel}/${entry.name}`);
      }
    };
    await walk(join(agentDir(ctx), ...ROOT.split('/')), ROOT);
    return paths;
  };
  const readText = (path: string, ctx?: AgentContext): Promise<string> =>
    readFile(join(agentDir(ctx), ...path.split('/')), 'utf-8');
  return { h, hostRoot, flush, listPaths, readText };
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** `auth:get-user` as auth answers it: the account by its display name, or null for no such account. */
function authNames(names: Record<string, string>): (userId: string) => unknown {
  return (userId) => {
    const displayName = names[userId];
    return displayName === undefined
      ? null
      : { id: userId, displayName, email: `${userId}@x.test`, isAdmin: false };
  };
}

describe('memory facts export — real engine + real volume', () => {
  it('publishes profile/recent/journal files into the volume', async () => {
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

  // TASK-1213: the export names members the way recall and the block do
  // (`memberLabels`), by the pass's own turn and never as "you": the file is
  // one per agent, read by every session that mounts it.
  it('a team agent’s export names its members, the same whoever triggers the flush', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness({
      agent: { visibility: 'team' },
      authUser: authNames({ [ALICE]: 'Alice Jones', [BOB]: 'Bob Smith' }),
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
    expect(byBob).toContain('## Alice Jones');
    expect(byBob).toContain('## Bob Smith');

    const profile = await readText(`${ROOT}/profile.md`, aliceCtx);
    expect(profile).toContain('## Alice Jones');
    expect(profile).toContain('## Bob Smith');
    for (const path of await listPaths(aliceCtx)) {
      const text = await readText(path, aliceCtx);
      expect(text, path).not.toContain('user:user-alice');
      expect(text, path).not.toContain('user:user-bob');
    }
  });

  it('a key for an account outside the team reads "a teammate" in the export, and auth is never asked about it', async () => {
    const EVE = 'user-eve';
    const { h, flush, listPaths, readText } = await makeExportHarness({
      agent: { visibility: 'team' },
      authUser: authNames({ [ALICE]: 'Alice Jones', [BOB]: 'Bob Smith', [EVE]: 'Eve Example' }),
    });
    // A member's private turn keeps a model-written `user:<id>` as written.
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${EVE}`, relation: 'lives_in', value: 'Paris', when: '2026-09-01T00:00:00.000Z', ownerUserId: ALICE },
      { about: `user:${BOB}`, relation: 'lives_in', value: 'Boston', when: '2026-09-01T00:00:00.000Z', ownerUserId: BOB },
    ]);
    await flush();
    const journal = await readText(`${ROOT}/user/${thisMonth()}.md`);
    expect(journal).toContain('## a teammate\n\n- 2026-09-01 · lives_in · Paris');
    expect(journal).toContain('## Bob Smith\n\n- 2026-09-01 · lives_in · Boston');
    for (const path of await listPaths()) {
      const text = await readText(path);
      expect(text, path).not.toContain('Eve Example');
      expect(text, path).not.toContain(`user:${EVE}`);
    }
    expect(h.memberCalls).toContain(EVE);
    expect(h.authCalls).not.toContain(EVE);
  });

  it("a personal agent's export names nobody and asks nobody", async () => {
    const { h, flush, readText } = await makeExportHarness({
      authUser: authNames({ [ALICE]: 'Alice Jones', [BOB]: 'Bob Smith' }),
    });
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${ALICE}`, relation: 'lives_in', value: 'Seattle', when: '2026-09-01T00:00:00.000Z', ownerUserId: ALICE },
      { about: `user:${BOB}`, relation: 'likes', value: 'tea', when: '2026-09-01T00:00:00.000Z', ownerUserId: ALICE },
    ]);
    await flush();
    const journal = await readText(`${ROOT}/user/${thisMonth()}.md`);
    expect(journal).toContain('## user:user-alice');
    expect(journal).toContain('## user:user-bob');
    expect(journal).not.toContain('Alice Jones');
    expect(journal).not.toContain('Bob Smith');
    expect(h.memberCalls).toEqual([]);
    expect(h.authCalls).toEqual([]);
  });

  it('two members whose names read the same both read "a teammate" in the export', async () => {
    const { h, flush, listPaths, readText } = await makeExportHarness({
      agent: { visibility: 'team' },
      authUser: authNames({ [ALICE]: 'Alice Jones', [BOB]: 'alice  jones.' }),
    });
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${ALICE}`, relation: 'lives_in', value: 'Seattle', when: '2026-09-01T00:00:00.000Z', ownerUserId: ALICE },
      { about: `user:${BOB}`, relation: 'lives_in', value: 'Boston', when: '2026-09-01T00:00:00.000Z', ownerUserId: BOB },
    ]);
    await flush();
    const journal = await readText(`${ROOT}/user/${thisMonth()}.md`);
    expect(journal).toContain('## a teammate\n\n- 2026-09-01 · lives_in · Seattle');
    expect(journal).toContain('## a teammate\n\n- 2026-09-01 · lives_in · Boston');
    for (const path of await listPaths()) expect(await readText(path), path).not.toMatch(/alice\s+jones/i);
  });

  // The pass's own turn decides, as it does for recall: a turn whose recall
  // reads shared rows only is told no names, so a pass it schedules writes
  // "a teammate" for everyone, until a pass from a member's turn.
  it('an export pass from a turn whose recall is scoped names nobody; the next pass from a member names them again', async () => {
    const { h, flush, readText } = await makeExportHarness({
      agent: { visibility: 'team' },
      authUser: authNames({ [ALICE]: 'Alice Jones', [BOB]: 'Bob Smith' }),
    });
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${ALICE}`, relation: 'lives_in', value: 'Seattle', when: '2026-09-01T00:00:00.000Z', ownerUserId: ALICE },
      { about: `user:${BOB}`, relation: 'lives_in', value: 'Boston', when: '2026-09-01T00:00:00.000Z', ownerUserId: BOB },
    ]);
    const journalPath = `${ROOT}/user/${thisMonth()}.md`;

    await flush(h.ctx({ source: 'unrecognized' }));
    const scoped = await readText(journalPath);
    expect(scoped).toContain('## a teammate\n\n- 2026-09-01 · lives_in · Seattle');
    expect(scoped).toContain('## a teammate\n\n- 2026-09-01 · lives_in · Boston');
    for (const hidden of ['Alice Jones', 'Bob Smith', 'user:user-']) expect(scoped).not.toContain(hidden);
    expect(h.authCalls).toEqual([]);

    await flush(h.ctx());
    const named = await readText(journalPath);
    expect(named).toContain('## Alice Jones');
    expect(named).toContain('## Bob Smith');
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

  it('an unchanged projection returns changed:false', async () => {
    const { h, flush } = await makeExportHarness();
    await h.remember({ about: 'user', relation: 'likes', value: 'tea' });
    expect(await flush()).toEqual({ changed: true });
    expect(await flush()).toEqual({ changed: false });
  });

  it('a revoked member is refused before anything is published', async () => {
    const { h, hostRoot, flush } = await makeExportHarness({
      agent: { visibility: 'team' },
    });
    h.teamMembers.delete(BOB);
    await expect(flush(h.ctx({ userId: BOB }))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await readdir(hostRoot)).toEqual([]);
  });
});

describe('sandbox:memory-mounts resolver', () => {
  async function makeVolumeHarness(options: Parameters<typeof makeMemoryHarness>[1] = {}) {
    const { h, hostRoot } = await makeExportHarness(options);
    const resolveMounts = (
      owner: { agentId: string; userId: string; audience?: string; source?: string },
      ctx: AgentContext = h.ctx(),
    ) =>
      h.bus.call<unknown, { mounts: Array<Record<string, unknown>> }>(
        'sandbox:memory-mounts',
        ctx,
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

  // TASK-1091. The export is every fact the agent has, scoped by owner but not
  // by audience, so a personal agent's session whose replies people without
  // access to the agent can read gets no file view at all. An audience this
  // build doesn't know fails closed, like `audienceOf`.
  it.each([
    ['a shared', 'shared'],
    ['an unknown-audience', 'public'],
  ])('%s session gets no memory mount and nothing is flushed', async (_label, audience) => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness();
    // Straight into the engine: `remember` would schedule an export of its own.
    await engineRecord(h.bus, h.ctx(), [
      {
        about: 'launch_plan',
        relation: 'codename',
        value: 'Nightjar',
        when: '2026-09-01T00:00:00.000Z',
        ownerUserId: ALICE,
        audience: 'private',
      },
    ]);
    const spy = vi.spyOn(h.bus, 'call');
    try {
      const out = await resolveMounts({ agentId: 'agent-1', userId: ALICE, audience });
      expect(out).toEqual({ mounts: [] });
      // Withheld after the access check (whose memory decides it, TASK-1204),
      // before the flush: nothing is granted, so nothing is read or written.
      expect(spy.mock.calls.map(([hook]) => hook)).toEqual(['sandbox:memory-mounts', 'agents:resolve']);
    } finally {
      spy.mockRestore();
    }
    expect(await readdir(hostRoot)).toEqual([]);
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toEqual([
      {
        level: 'info',
        event: 'memory_mount_withheld',
        bindings: { agentId: 'agent-1', reason: 'shared-audience' },
      },
    ]);
  });

  it('a session stamped private still gets its mount', async () => {
    const { h, resolveMounts } = await makeVolumeHarness();
    const { mounts } = await resolveMounts({ agentId: 'agent-1', userId: ALICE, audience: 'private' });
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ kind: 'nfs', role: 'memory', mountPath: '/memory', readOnly: true });
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toEqual([]);
  });

  // TASK-1204, design §4c: a team agent's memory is the team's, so a member's
  // session keeps its read-only view in every audience, as its recall does.
  it.each([
    ["a member's shared", { audience: 'shared', source: 'user' }],
    ['a shared', { audience: 'shared' }],
    ['an unknown-audience', { audience: 'public' }],
    ["a routine's shared", { audience: 'shared', source: 'routine' }],
    ["a member's private-stamped", { audience: 'private', source: 'user' }],
  ])('%s session of a team agent gets its mount', async (_label, session) => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness({ agent: { visibility: 'team' } });
    await h.remember({ about: 'user', relation: 'lives in', value: 'Portland' });

    const { mounts } = await resolveMounts({ agentId: 'agent-1', userId: ALICE, ...session });

    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ role: 'memory', mountPath: '/memory', readOnly: true });
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toEqual([]);
    expect(await readdir(hostRoot)).not.toEqual([]);
  });

  // The export holds every row, so a session gets no view wherever its recall
  // reads shared rows only (`recallAudienceScope`). On a personal agent that
  // is an outsider's session whatever its audience stamp (review F3: someone
  // without access to the agent reads its replies, so a private stamp, or
  // none, fails closed; no live producer sends one). On any agent it is a
  // session from a source this build doesn't know, which fails closed on a
  // team agent too (TASK-1209's security review): one outside the type, and
  // a stored one read back as `'unrecognized'` (TASK-1213).
  it.each([
    ['team', 'an unknown-source shared', { audience: 'shared', source: 'satellite' }],
    ['team', 'an unknown-source private-stamped', { audience: 'private', source: 'satellite' }],
    ['team', 'an unknown-source unstamped', { source: 'satellite' }],
    ['team', 'an unrecognized-source shared', { audience: 'shared', source: 'unrecognized' }],
    ['team', 'an unrecognized-source unstamped', { source: 'unrecognized' }],
    ['personal', "an outsider's private-stamped", { audience: 'private', source: 'external' }],
    ['personal', "an outsider's unstamped", { source: 'external' }],
    ['personal', 'an unknown-source shared', { audience: 'shared', source: 'satellite' }],
    ['personal', 'an unknown-source private-stamped', { audience: 'private', source: 'satellite' }],
    ['personal', 'an unrecognized-source private-stamped', { audience: 'private', source: 'unrecognized' }],
  ] as const)('a %s agent: %s session gets no mount and nothing is flushed', async (visibility, _label, session) => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness({ agent: { visibility } });
    await engineRecord(h.bus, h.ctx(), [
      {
        about: 'launch_plan',
        relation: 'codename',
        value: 'Nightjar',
        when: '2026-09-01T00:00:00.000Z',
        ownerUserId: ALICE,
        audience: 'private',
      },
    ]);
    const spy = vi.spyOn(h.bus, 'call');
    try {
      expect(await resolveMounts({ agentId: 'agent-1', userId: ALICE, ...session })).toEqual({ mounts: [] });
      expect(spy.mock.calls.map(([hook]) => hook)).toEqual(['sandbox:memory-mounts', 'agents:resolve']);
    } finally {
      spy.mockRestore();
    }
    expect(await readdir(hostRoot)).toEqual([]);
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toEqual([
      { level: 'info', event: 'memory_mount_withheld', bindings: { agentId: 'agent-1', reason: 'shared-audience' } },
    ]);
  });

  // TASK-1209 (design §4c): a team agent's memory is shared with anyone who
  // talks to it, so an outsider's session keeps the read-only view in every
  // audience, as its recall reads everything: the private row included.
  it.each([
    ["an outsider's shared", { audience: 'shared', source: 'external' }],
    ["an outsider's unknown-audience", { audience: 'public', source: 'external' }],
    ["an outsider's private-stamped", { audience: 'private', source: 'external' }],
    ["an outsider's unstamped", { source: 'external' }],
  ] as const)('%s session of a team agent gets its mount, flushed', async (_label, session) => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness({ agent: { visibility: 'team' } });
    // Straight into the engine: `remember` would schedule an export of its own.
    await engineRecord(h.bus, h.ctx(), [
      {
        about: 'launch_plan',
        relation: 'codename',
        value: 'Nightjar',
        when: '2026-09-01T00:00:00.000Z',
        ownerUserId: ALICE,
        audience: 'private',
      },
    ]);
    expect(await readdir(hostRoot)).toEqual([]);

    const { mounts } = await resolveMounts({ agentId: 'agent-1', userId: ALICE, ...session });

    expect(mounts).toEqual([memoryMountSpec('agent-1', { hostRoot, backing: BACKING })]);
    // The flush ran, and the view holds the private row.
    const files = (await readdir(hostRoot, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    const texts = await Promise.all(files.map((e) => readFile(join(e.parentPath, e.name), 'utf-8')));
    expect(texts.join('\n')).toContain('Nightjar');
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toEqual([]);
  });

  // The session's owner and the turn opening it agree (the orchestrator copies
  // one from the other). When they don't, either one whose recall reads
  // shared rows only withholds the view. On a team agent an outsider's turn
  // opening the session isn't one (TASK-1209); a turn from a source this
  // build doesn't know still is.
  it("a team agent's shared session opened by an outsider's turn gets its mount", async () => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness({ agent: { visibility: 'team' } });
    await h.remember({ about: 'user', relation: 'lives in', value: 'Portland' });
    const opening = h.ctx({ conversationId: 'conv-ext', source: 'external', audience: 'shared' });

    expect((await resolveMounts({ agentId: 'agent-1', userId: ALICE, audience: 'shared' }, opening)).mounts).toHaveLength(1);
    // And when the owner record says private.
    expect((await resolveMounts({ agentId: 'agent-1', userId: ALICE, audience: 'private' }, opening)).mounts).toHaveLength(1);
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toHaveLength(0);
    expect(await readdir(hostRoot)).not.toEqual([]);

    // A turn from a source this build doesn't know opening it: fail closed.
    const unknown = h.ctx({ conversationId: 'conv-odd', source: 'satellite' as AgentContextSource, audience: 'shared' });
    expect(await resolveMounts({ agentId: 'agent-1', userId: ALICE, audience: 'shared' }, unknown)).toEqual({ mounts: [] });
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toHaveLength(1);
  });

  // Unchanged on a personal agent: an outsider's turn opening even a session
  // whose owner record says private withholds the view.
  it("a personal agent's private session opened by an outsider's turn gets no mount", async () => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness();
    const opening = h.ctx({ conversationId: 'conv-ext', source: 'external', audience: 'shared' });

    expect(await resolveMounts({ agentId: 'agent-1', userId: ALICE, audience: 'private' }, opening)).toEqual({ mounts: [] });
    expect(await resolveMounts({ agentId: 'agent-1', userId: ALICE }, opening)).toEqual({ mounts: [] });
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toHaveLength(2);
    expect(await readdir(hostRoot)).toEqual([]);
    // The control: the owner's own turn opening it gets the view.
    expect((await resolveMounts({ agentId: 'agent-1', userId: ALICE, audience: 'private' })).mounts).toHaveLength(1);
  });

  // The access check comes first now, so a caller the agent refuses hears
  // so, instead of an empty answer that reads like a withheld view.
  it('a shared session whose owner may not use the personal agent is refused, not quietly withheld', async () => {
    const { h, hostRoot, resolveMounts } = await makeVolumeHarness();
    await expect(resolveMounts({ agentId: 'agent-1', userId: BOB, audience: 'shared' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toEqual([]);
    expect(await readdir(hostRoot)).toEqual([]);
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
    const parent = await mkdtemp(join(tmpdir(), 'ax-export-vol-'));
    dirs.push(parent);
    const badHostRoot = join(parent, 'occupied');
    await writeFile(badHostRoot, 'not a dir');
    const h = await makeMemoryHarness({
      exports: {
        debounceMs: 5,
        volume: { hostRoot: badHostRoot, backing: BACKING },
      },
    });
    harnesses.push(h);
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

  it('exports without a volume is refused at construction (TASK-991)', () => {
    expect(() => createMemoryPlugin({ exports: {} as never })).toThrowError(/exports\.volume/);
    expect(() => createMemoryPlugin({ exports: { debounceMs: 5 } as never })).toThrowError(
      /exports\.volume/,
    );
    expect(() => createMemoryPlugin({ exports: { volume: null } as never })).toThrowError(
      /exports\.volume/,
    );
  });

  it('an export-configured plugin calls no workspace hook and registers flush + mounts together', () => {
    const { manifest } = createMemoryPlugin({
      exports: { volume: { hostRoot: '/tmp/x', backing: BACKING } },
    });
    expect(manifest.calls.filter((h) => h.startsWith('workspace:'))).toEqual([]);
    expect(manifest.calls).toContain('memory:facts:scan');
    expect(manifest.registers).toEqual(
      expect.arrayContaining([MEMORY_EXPORT_FLUSH_HOOK, 'sandbox:memory-mounts']),
    );
  });

  it('a plugin without exports registers neither the flush hook nor the mount resolver', async () => {
    const h: MemoryHarness = await makeMemoryHarness();
    harnesses.push(h);
    await expect(h.bus.call(MEMORY_EXPORT_FLUSH_HOOK, h.ctx(), {})).rejects.toMatchObject({
      code: 'no-service',
    });
    await expect(
      h.bus.call('sandbox:memory-mounts', h.ctx(), {
        owner: { agentId: 'agent-1', userId: ALICE },
      }),
    ).rejects.toMatchObject({ code: 'no-service' });
  });
});

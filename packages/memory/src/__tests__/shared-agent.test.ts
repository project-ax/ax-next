import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  HookBus,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type AgentContextSource,
  type LlmCallOutput,
} from '@ax/core';
import { MEMORY_FACTS_EXPORT_ROOT } from '@ax/sandbox-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENTS_RESOLVE_HOOK, resolveMemoryAccess, type MemoryAccess } from '../access.js';
import { memoryMountSpec, volumeAgentKey } from '../export-volume.js';
import { MEMORY_EXPORT_FLUSH_HOOK } from '../exporter.js';
import { OBSERVER_RUN_EVENT } from '../failure.js';
import { MEMORY_NOTE_TOOL_HOOK, type MemoryNoteResult } from '../note-tool.js';
import { createMemoryPlugin, FACTS_RECALL_HOOK } from '../plugin.js';
import type { MemoryRecallOutput } from '../types.js';
import {
  ALICE,
  BOB,
  engineRecall,
  engineRecord,
  eventsNamed,
  makeMemoryHarness,
  registerMemoryAgents,
  TEAM_ID,
  type MemoryHarness,
  type MemoryHarnessOptions,
} from './harness.js';

/**
 * TASK-1248: a personal agent shared with other people (`agents:resolve` says
 * `shared: true`) follows the team-agent memory rules. Its memory is shared
 * with everyone who can use it, each person's own facts are filed under them,
 * an outsider's words are never kept, and a source this build doesn't know
 * reads shared rows only. A "Just me" agent is unchanged: its creator's alone.
 *
 * ALICE created the agent. BOB is someone it is shared with. Over the REAL
 * sqlite engine, as `team.test.ts` is, except where a test needs an
 * `agents:resolve` answer the harness's fake can't give.
 */

let harness: MemoryHarness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.teardown();
  harness = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const JAN = '2026-01-01T00:00:00Z';
/** Someone the agent isn't shared with. */
const MALLORY = 'user-mallory';
const AUGMENT_HOOK = 'system-prompt:augment:optional:memory';
const ROOT = MEMORY_FACTS_EXPORT_ROOT;
const BACKING = { server: 'nfs.internal', exportPath: '/srv/ax/memory' };
/** Both share the word `launch`, so one query matches both. */
const SECRET = 'launch codename Nightjar';
const PUBLIC = 'launch date in March';

/**
 * ALICE's personal agent, shared with BOB. A fresh `members` each time: the
 * harness hands the same set out as `teamMembers`.
 */
function sharedWithBob(): NonNullable<MemoryHarnessOptions['agent']> {
  return { visibility: 'personal', shared: true, members: new Set([BOB]) };
}

async function sharedAgent(options: Pick<MemoryHarnessOptions, 'llm'> = {}): Promise<MemoryHarness> {
  harness = await makeMemoryHarness({}, { ...options, agent: sharedWithBob() });
  return harness;
}

/** {@link sharedAgent}, with the `/memory` export and `sandbox:memory-mounts` on. */
async function sharedAgentWithExport() {
  const hostRoot = await mkdtemp(join(tmpdir(), 'ax-shared-agent-vol-'));
  dirs.push(hostRoot);
  const h = await makeMemoryHarness(
    { exports: { debounceMs: 5, volume: { hostRoot, backing: BACKING } } },
    { agent: sharedWithBob() },
  );
  harness = h;
  const flush = (ctx: AgentContext) =>
    h.bus.call<Record<string, never>, { changed: boolean }>(MEMORY_EXPORT_FLUSH_HOOK, ctx, {});
  const readText = (path: string): Promise<string> =>
    readFile(join(hostRoot, volumeAgentKey('agent-1'), ...path.split('/')), 'utf-8');
  /** Every file in the volume, joined: what a session mounting `/memory` can read. */
  const volumeText = async (): Promise<string> => {
    const files = (await readdir(hostRoot, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    const texts = await Promise.all(files.map((e) => readFile(join(e.parentPath, e.name), 'utf-8')));
    return texts.join('\n');
  };
  const resolveMounts = (
    owner: { agentId: string; userId: string; audience?: string; source?: string },
    ctx: AgentContext,
  ) => h.bus.call<unknown, { mounts: Array<Record<string, unknown>> }>('sandbox:memory-mounts', ctx, { owner });
  return { h, hostRoot, flush, readText, volumeText, resolveMounts };
}

function values(out: MemoryRecallOutput): string[] {
  return out.statements.map((s) => s.value);
}

async function augment(h: MemoryHarness, ctx: AgentContext): Promise<string> {
  const out = await h.bus.call<Record<string, never>, { recall?: string }>(AUGMENT_HOOK, ctx, {});
  return out.recall ?? '';
}

function note(h: MemoryHarness, ctx: AgentContext, input: Record<string, unknown>): Promise<MemoryNoteResult> {
  return h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, ctx, { input });
}

/** Every `memory:facts:recall` input the work sent, in order. */
async function engineReadsDuring(h: MemoryHarness, work: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const spy = vi.spyOn(h.bus, 'call');
  try {
    await work();
    return spy.mock.calls
      .filter(([hook]) => hook === FACTS_RECALL_HOOK)
      .map(([, , input]) => input as Record<string, unknown>);
  } finally {
    spy.mockRestore();
  }
}

/** Every row in the engine's table, straight off disk, as `about|value|audience`, in write order. */
function storedRows(h: MemoryHarness): string[] {
  const db = new Database(h.databasePath, { readonly: true });
  try {
    const rows = db.prepare('SELECT about, value, audience FROM memory_facts_v1 ORDER BY rowid').all() as Array<{
      about: string;
      value: string;
      audience: string | null;
    }>;
    return rows.map((r) => `${r.about}|${r.value}|${r.audience}`);
  } finally {
    db.close();
  }
}

function extractionReply(facts: Array<Record<string, unknown>>): LlmCallOutput {
  return {
    text: JSON.stringify({
      facts: facts.map((f) => ({ network: 'world', validStart: JAN, invalidatesPrevious: false, ...f })),
    }),
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** One `chat:end` observer pass, awaited. */
async function observeTurn(h: MemoryHarness, ctx: AgentContext, messages: unknown[]): Promise<void> {
  await h.bus.fire('chat:end', ctx, { outcome: { kind: 'complete', messages } });
  await h.settleObserver();
}

function forbiddenByResolve(): PluginError {
  return new PluginError({
    code: 'forbidden',
    plugin: '@ax/test-agents',
    hookName: AGENTS_RESOLVE_HOOK,
    message: 'Caller is not authorized for this agent',
  });
}

/**
 * Memory over a bare bus whose `agents:resolve` answers with `answer`, and a
 * stub engine that records what it is asked: `team.test.ts`'s shape, for an
 * answer the harness's fake doesn't give (a co-owner of a Just-me agent, a
 * malformed `shared`).
 */
async function memoryAnswering(answer: (input: { agentId: string; userId: string }) => unknown) {
  const bus = new HookBus();
  const engineCalls: string[] = [];
  const engineReads: Array<Record<string, unknown>> = [];
  for (const hook of ['memory:facts:recall', 'memory:facts:record', 'memory:facts:supersede']) {
    bus.registerService<Record<string, unknown>, unknown>(hook, 'stub', async (_ctx, input) => {
      engineCalls.push(hook);
      if (hook === FACTS_RECALL_HOOK) engineReads.push(input);
      return { statements: [], records: [{ id: 'x' }], degraded: [] };
    });
  }
  bus.registerService('tool:register', 'stub-catalog', async () => ({}));
  bus.registerService<{ agentId: string; userId: string }, unknown>(AGENTS_RESOLVE_HOOK, '@ax/test-agents', async (_ctx, input) =>
    answer(input),
  );
  await createMemoryPlugin().init({ bus, config: {} });
  const recallAs = (userId: string) =>
    bus.call<Record<string, never>, MemoryRecallOutput>(
      'memory:recall',
      makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId, workspace: { rootPath: '/tmp' } }),
      {},
    );
  return { recallAs, engineCalls, engineReads };
}

describe('resolveMemoryAccess — the access a shared personal agent gets (TASK-1248)', () => {
  async function accessFor(agent: Parameters<typeof registerMemoryAgents>[1], userId: string): Promise<MemoryAccess> {
    const bus = new HookBus();
    registerMemoryAgents(bus, agent);
    return resolveMemoryAccess(
      bus,
      makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId, workspace: { rootPath: '/tmp' } }),
    );
  }

  // `teamId` is a team's id, asked `teams:is-member` about: a shared personal
  // agent's `ownerId` is its creator, so it never becomes one. Its people are
  // proven through `agents:resolve` instead (`memberCheck`).
  it("is shared, proven through agents:resolve, and has no teamId; a team agent's and a Just-me agent's are unchanged", async () => {
    const shared = { visibility: 'personal', shared: true, members: new Set([BOB]) } as const;
    for (const userId of [ALICE, BOB]) {
      expect(await accessFor({ ...shared, displayName: 'Fern' }, userId)).toStrictEqual({
        userId,
        visibility: 'team',
        memberCheck: 'agent',
        agentName: 'Fern',
      });
    }
    expect(await accessFor(shared, BOB)).toStrictEqual({ userId: BOB, visibility: 'team', memberCheck: 'agent' });
    expect(await accessFor({ visibility: 'team', displayName: 'Fern' }, BOB)).toStrictEqual({
      userId: BOB,
      visibility: 'team',
      teamId: TEAM_ID,
      agentName: 'Fern',
    });
    expect(await accessFor({ visibility: 'personal', displayName: 'Fern' }, ALICE)).toStrictEqual({
      userId: ALICE,
      visibility: 'personal',
    });
  });
});

describe('@ax/memory — a personal agent shared with other people shares its memory with everyone who can use it (TASK-1248)', () => {
  it("one person's write is everyone's read, and another's correction closes it", async () => {
    const h = await sharedAgent();
    const alice = h.ctx({ userId: ALICE });
    const bob = h.ctx({ userId: BOB });

    const first = await h.remember({ about: 'priya', relation: 'works_at', value: 'Acme', when: JAN }, alice);

    const bobListing = await h.recall({ limit: 10 }, bob);
    expect(bobListing.statements.map((s) => s.id)).toEqual([first.id]);
    // On the wire this reads "this agent's memory is shared".
    expect(bobListing.visibility).toBe('team');
    expect(values(await h.recall({ query: 'Acme' }, bob))).toEqual(['Acme']);

    // Bob's Fix of the creator's row.
    const second = await h.correct(
      { id: first.id, about: 'priya', relation: 'works_at', value: 'Beta', reason: 'changed' },
      bob,
    );

    expect(values(await h.recall({ limit: 10 }, alice))).toEqual(['Beta']);
    const history = await h.recall({ limit: 10, activeOnly: false }, alice);
    const acme = history.statements.find((s) => s.id === first.id);
    expect(acme?.closure).toBe('replaced');
    expect(acme?.closedBy).toBe(second.id);
  });

  it("someone it is shared with can forget the owner's row, but never another agent's", async () => {
    const h = await sharedAgent();
    const alice = h.ctx({ userId: ALICE });
    const bob = h.ctx({ userId: BOB });
    const { id } = await h.remember({ about: 'priya', relation: 'works_at', value: 'Acme', when: JAN }, alice);
    const otherAgentRow = await h.remember(
      { about: 'priya', relation: 'works_at', value: 'Otherco', when: JAN },
      h.ctx({ agentId: 'agent-2', userId: ALICE }),
    );

    await h.forget({ ids: [id, otherAgentRow.id] }, bob);

    expect((await h.recall({ limit: 10 }, alice)).statements).toEqual([]);
    expect((await h.recall({ limit: 10 }, bob)).statements).toEqual([]);
    const history = await h.recall({ limit: 10, activeOnly: false }, alice);
    expect(history.statements.find((s) => s.id === id)?.closure).toBe('forgotten');

    const other = await engineRecall(h.bus, h.ctx({ agentId: 'agent-2' }), { limit: 10 });
    expect(other.statements.map((s) => s.id)).toEqual([otherAgentRow.id]);
    expect(other.statements[0]!.until).toBeUndefined();
  });

  it("keeps each person's speaker subject distinct, and profile is the caller's", async () => {
    const h = await sharedAgent();
    await h.remember({ about: 'user', relation: 'lives_in', value: 'Berlin', when: JAN }, h.ctx({ userId: ALICE }));
    await h.remember({ about: 'user', relation: 'lives_in', value: 'Lisbon', when: JAN }, h.ctx({ userId: BOB }));

    const shared = await h.recall({ limit: 10 }, h.ctx({ userId: BOB }));
    expect(new Set(shared.statements.map((s) => s.about))).toEqual(new Set([`user:${ALICE}`, `user:${BOB}`]));

    const bobProfile = await h.recall({ profile: true, limit: 100 }, h.ctx({ userId: BOB }));
    expect(bobProfile.statements.map((s) => s.about)).toEqual([`user:${BOB}`]);
    const aliceProfile = await h.recall({ profile: true, limit: 100 }, h.ctx({ userId: ALICE }));
    expect(aliceProfile.statements.map((s) => s.about)).toEqual([`user:${ALICE}`]);
  });

  // The speaker rule a team agent's member turn has (TASK-1204): the turn runs
  // as the person talking, so what they say about themself is theirs. On a
  // Just-me agent the same channel note keeps the speaker rule: refused.
  it('in a channel, what someone it is shared with says about themself is filed under their own key', async () => {
    const h = await sharedAgent();
    const bobInChannel = h.ctx({ userId: BOB, conversationId: 'conv-b', source: 'user', audience: 'shared' });

    expect(await note(h, bobInChannel, { about: 'user', relation: 'lives in', value: 'Boston' })).toEqual({ ok: true });

    expect(storedRows(h)).toEqual([`user:${BOB}|Boston|shared`]);
    const aliceReads = await h.recall({}, h.ctx({ userId: ALICE }));
    expect(aliceReads.statements.map((s) => `${s.aboutText}|${s.value}`)).toEqual(['a teammate|Boston']);

    // Just me again: the creator's own channel note about herself is refused.
    h.setShared(false);
    const aliceInChannel = h.ctx({ userId: ALICE, conversationId: 'conv-a', source: 'user', audience: 'shared' });
    expect(await note(h, aliceInChannel, { about: 'user', relation: 'lives in', value: 'Lisbon' })).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(storedRows(h)).toEqual([`user:${BOB}|Boston|shared`]);
  });

  it('refuses the moment the agent goes back to Just me: no cached grant', async () => {
    const h = await sharedAgent();
    const alice = h.ctx({ userId: ALICE });
    const bob = h.ctx({ userId: BOB });
    const bobs = await h.remember({ about: 'priya', relation: 'works_at', value: 'Acme', when: JAN }, bob);
    expect((await h.recall({ limit: 10 }, bob)).statements.map((s) => s.id)).toEqual([bobs.id]);

    h.setShared(false);
    const asked = h.resolveCalls.length;

    await expect(h.recall({ limit: 10 }, bob)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.remember({ about: 'a', relation: 'r', value: 'v' }, bob)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(h.forget({ ids: [bobs.id] }, bob)).rejects.toMatchObject({ code: 'forbidden' });
    // Each one asked `agents:resolve` afresh, and was refused there.
    expect(h.resolveCalls.slice(asked)).toEqual([BOB, BOB, BOB]);

    // The creator's reads are hers alone again: Bob's row isn't in them...
    const own = await h.recall({ limit: 10 }, alice);
    expect(own.visibility).toBe('personal');
    expect(own.statements).toEqual([]);
    // ...but it is kept, and back the moment the agent is shared again.
    const stored = await engineRecall(h.bus, alice, { limit: 10 });
    expect(stored.statements.map((s) => s.id)).toEqual([bobs.id]);
    expect(stored.statements[0]!.until).toBeUndefined();
    h.setShared(true);
    expect((await h.recall({ limit: 10 }, alice)).statements.map((s) => s.id)).toEqual([bobs.id]);
  });
});

describe('@ax/memory — a Just-me agent is unchanged, and only `shared: true` shares it (TASK-1248)', () => {
  it("a Just-me agent is still its creator's alone: a co-owner or anyone else is refused", async () => {
    // Bob is a co-owner: `agents:resolve` lets him in and says so. The agent is Just me.
    const m = await memoryAnswering((input) => {
      if (input.userId !== ALICE && input.userId !== BOB) throw forbiddenByResolve();
      return {
        agent: {
          id: input.agentId,
          ownerId: ALICE,
          ownerType: 'user',
          visibility: 'personal',
          shared: false,
          audience: 'just-me',
          isOwner: true,
        },
      };
    });

    await expect(m.recallAs(BOB)).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('belongs to another person'),
    });
    await expect(m.recallAs(MALLORY)).rejects.toMatchObject({ code: 'forbidden' });
    expect(m.engineCalls).toEqual([]);

    const own = await m.recallAs(ALICE);
    expect(own.visibility).toBe('personal');
    expect(m.engineReads.length).toBeGreaterThan(0);
    for (const read of m.engineReads) expect(read).toMatchObject({ ownerUserId: ALICE });
  });

  // Fail closed: only an exact `shared: true` shares a personal agent, and
  // memory never reads `audience` to decide it (card A's rule). Each answer
  // below says `audience: 'everyone'` and lets Bob in.
  it.each([
    ['no shared at all', undefined],
    ["shared: 'true'", 'true'],
    ['shared: 1', 1],
    ['shared: null', null],
  ] as const)('an answer with %s keeps the Just-me rule', async (_label, shared) => {
    const m = await memoryAnswering((input) => {
      if (input.userId !== ALICE && input.userId !== BOB) throw forbiddenByResolve();
      return {
        agent: {
          id: input.agentId,
          ownerId: ALICE,
          ownerType: 'user',
          visibility: 'personal',
          ...(shared === undefined ? {} : { shared }),
          audience: 'everyone',
          isOwner: input.userId === ALICE,
        },
      };
    });

    await expect(m.recallAs(BOB)).rejects.toMatchObject({ code: 'forbidden' });
    expect(m.engineCalls).toEqual([]);

    const own = await m.recallAs(ALICE);
    expect(own.visibility).toBe('personal');
    expect(m.engineReads.length).toBeGreaterThan(0);
    for (const read of m.engineReads) expect(read).toMatchObject({ ownerUserId: ALICE });
  });

  it.each([
    [
      'is about another agent',
      () => ({
        agent: { id: 'agent-elsewhere', ownerId: ALICE, ownerType: 'user', visibility: 'personal', shared: true },
      }),
    ],
    [
      'says a team owns a personal agent',
      (input: { agentId: string }) => ({
        agent: { id: input.agentId, ownerId: 'team-1', ownerType: 'team', visibility: 'personal', shared: true },
      }),
    ],
    [
      'names no owner',
      (input: { agentId: string }) => ({
        agent: { id: input.agentId, ownerType: 'user', visibility: 'personal', shared: true },
      }),
    ],
  ])('a shared answer that %s fails closed, before any engine call', async (_label, answer) => {
    const m = await memoryAnswering(answer);
    await expect(m.recallAs(BOB)).rejects.toMatchObject({ code: 'invalid-return', hookName: AGENTS_RESOLVE_HOOK });
    expect(m.engineCalls).toEqual([]);
  });

  it.each([
    ['shared', true],
    ['isOwner', true],
    ['memberCheck', 'agent'],
  ] as const)('refuses a caller-provided %s field, before asking anyone', async (field, value) => {
    const h = await sharedAgent();
    const bob = h.ctx({ userId: BOB });
    const smuggled = (input: object): never => ({ ...input, [field]: value }) as never;
    const refused = { code: 'invalid-payload', message: expect.stringContaining(`${field} is not a caller-settable field`) };

    await expect(h.recall(smuggled({ limit: 10 }), bob)).rejects.toMatchObject(refused);
    await expect(h.remember(smuggled({ about: 'a', relation: 'r', value: 'v' }), bob)).rejects.toMatchObject(refused);
    await expect(h.forget(smuggled({ ids: ['x'] }), bob)).rejects.toMatchObject(refused);
    await expect(
      h.correct(smuggled({ id: 'x', about: 'a', relation: 'r', value: 'v', reason: 'changed' }), bob),
    ).rejects.toMatchObject(refused);
    expect(h.resolveCalls).toEqual([]);
  });
});

describe("@ax/memory — on a shared agent an outsider's turn, and one from a source this build doesn't know, keep their rules (TASK-1248)", () => {
  /** What an outsider says: about themself, under the requester's own key, and about the work. */
  const OUTSIDER_FACTS = [
    { subject: 'user', predicate: 'lives_in', object: 'Paris' },
    { subject: `user:${ALICE}`, predicate: 'works_at', object: 'Initech' },
    { subject: 'billing_service', predicate: 'owner', object: 'Dana' },
  ];
  const OUTSIDER_TURN = [
    { role: 'user', content: 'I live in Paris and I work at Initech. Dana owns the billing service.' },
    { role: 'assistant', content: 'Thanks.' },
  ];

  // Design §4c, as on a team agent (TASK-1209): an outsider's turn runs as the
  // owner who set the bot up (Alice here), recalls what a member's turn does,
  // the private web chats included, and is never "you". What the outsider
  // says lands under no person, even with no `memory:pre-capture` veto.
  it("an outsider's turn recalls everything and files no person fact", async () => {
    const h = await sharedAgent({ llm: () => extractionReply(OUTSIDER_FACTS) });
    await h.remember({ about: 'user', relation: 'lives in', value: 'Lisbon' }, h.ctx({ conversationId: 'conv-web-a' }));
    await h.remember(
      { about: 'launch_plan', relation: 'codename', value: SECRET },
      h.ctx({ userId: BOB, conversationId: 'conv-web-b' }),
    );
    const outsider = h.ctx({ userId: ALICE, conversationId: 'conv-ext', source: 'external', audience: 'shared' });

    const reads = await engineReadsDuring(h, async () => {
      expect(values(await h.recall({}, outsider)).sort()).toEqual(['Lisbon', SECRET].sort());
      const block = await augment(h, outsider);
      expect(block).toContain('Nightjar');
      expect(block).toContain('Lisbon');
      expect(block).not.toContain('### Profile');
      expect(block).not.toContain('you lives in');
    });
    expect(reads.length).toBeGreaterThan(0);
    for (const input of reads) expect(input).not.toHaveProperty('audience');
    expect((await h.recall({}, outsider)).statements.map((s) => s.aboutText)).not.toContain('you');

    const before = storedRows(h).length;
    await observeTurn(h, outsider, OUTSIDER_TURN);
    expect(await note(h, outsider, { about: 'user', relation: 'lives_in', value: 'Paris' })).toMatchObject({
      ok: false,
      error: 'forbidden',
    });

    expect(storedRows(h).slice(before)).toEqual(['billing_service|Dana|shared']);
    expect(eventsNamed(h.logs, OBSERVER_RUN_EVENT).at(-1)?.bindings).toMatchObject({
      outcome: 'recorded',
      recorded: 1,
      speakerFacts: 2,
    });
  });

  // TASK-1209's security review, TASK-1213: on any agent whose memory is
  // shared, a source this build doesn't know fails closed. A session store's
  // `'unrecognized'`, and a value outside the type.
  it.each(['unrecognized', 'satellite'] as const)(
    "a source this build doesn't recognise (%j) reads shared rows only and gets no /memory view",
    async (source) => {
      const { h, hostRoot, resolveMounts } = await sharedAgentWithExport();
      // Straight into the engine: `remember` would schedule an export of its own.
      await engineRecord(h.bus, h.ctx(), [
        { about: 'launch_plan', relation: 'codename', value: SECRET, when: JAN, ownerUserId: ALICE, audience: 'private' },
        {
          about: 'launch_plan',
          relation: 'date',
          value: PUBLIC,
          when: JAN,
          ownerUserId: ALICE,
          conversationId: 'conv-channel',
          audience: 'shared',
        },
      ]);
      const unknown = h.ctx({
        userId: BOB,
        conversationId: 'conv-odd',
        source: source as AgentContextSource,
        audience: 'shared',
      });

      const reads = await engineReadsDuring(h, async () => {
        expect(values(await h.recall({}, unknown))).toEqual([PUBLIC]);
        const block = await augment(h, unknown);
        expect(block).toContain(PUBLIC);
        expect(block).not.toContain('Nightjar');
      });
      expect(reads.length).toBeGreaterThan(0);
      for (const input of reads) expect(input.audience).toBe('shared');

      // No file view: by the session's own source, or by the turn opening it.
      const bob = h.ctx({ userId: BOB });
      expect(await resolveMounts({ agentId: 'agent-1', userId: BOB, audience: 'shared', source }, bob)).toEqual({
        mounts: [],
      });
      expect(await resolveMounts({ agentId: 'agent-1', userId: BOB, audience: 'shared' }, unknown)).toEqual({
        mounts: [],
      });
      expect(eventsNamed(h.logs, 'memory_mount_withheld')).toHaveLength(2);
      expect(await readdir(hostRoot)).toEqual([]);
    },
  );
});

describe('@ax/memory — the /memory view and export of a shared agent (TASK-1248)', () => {
  it("sandbox:memory-mounts gives someone it is shared with the agent's /memory view, and refuses them once it is Just me again", async () => {
    const { h, hostRoot, resolveMounts, volumeText } = await sharedAgentWithExport();
    await engineRecord(h.bus, h.ctx(), [
      { about: 'launch_plan', relation: 'codename', value: 'Nightjar', when: JAN, ownerUserId: ALICE, audience: 'private' },
      { about: 'office', relation: 'located_in', value: 'Boston', when: JAN, ownerUserId: BOB, audience: 'private' },
    ]);
    const alice = h.ctx({ userId: ALICE });
    const bob = h.ctx({ userId: BOB });

    const bobs = await resolveMounts({ agentId: 'agent-1', userId: BOB }, bob);
    expect(bobs.mounts).toEqual([memoryMountSpec('agent-1', { hostRoot, backing: BACKING })]);
    expect((await resolveMounts({ agentId: 'agent-1', userId: ALICE }, alice)).mounts).toEqual(bobs.mounts);
    // The view is the agent's memory, whoever taught it.
    const shared = await volumeText();
    expect(shared).toContain('Nightjar');
    expect(shared).toContain('Boston');

    h.setShared(false);
    // Refused, never quietly withheld.
    await expect(resolveMounts({ agentId: 'agent-1', userId: BOB }, bob)).rejects.toMatchObject({ code: 'forbidden' });
    expect(eventsNamed(h.logs, 'memory_mount_withheld')).toEqual([]);
    // The creator keeps her view, rewritten to her own rows by her next pass.
    expect((await resolveMounts({ agentId: 'agent-1', userId: ALICE }, alice)).mounts).toHaveLength(1);
    const justMe = await volumeText();
    expect(justMe).toContain('Nightjar');
    expect(justMe).not.toContain('Boston');
  });

  // The export is one file per agent, read by every session that mounts it,
  // so nobody in it reads "you": each person's Profile is a section of its own
  // (as on a team agent), the same whoever triggers the pass.
  it('the /memory export gives each person their own heading, never "you"', async () => {
    const { h, flush, readText } = await sharedAgentWithExport();
    const alice = h.ctx({ userId: ALICE });
    const bob = h.ctx({ userId: BOB });
    await h.remember({ about: 'user', relation: 'lives in', value: 'Seattle' }, alice);
    await h.remember({ about: 'user', relation: 'works at', value: 'Bob Co' }, bob);

    await flush(bob);
    const byBob = await readText(`${ROOT}/profile.md`);
    await flush(alice);
    const byAlice = await readText(`${ROOT}/profile.md`);

    expect(byBob).toBe(byAlice);
    // In key order: Alice's, then Bob's.
    const sections = byAlice.split(/^## /m).slice(1);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatch(/^a teammate\n\n- lives_in: Seattle/);
    expect(sections[1]).toMatch(/^a teammate\n\n- works_at: Bob Co/);
    expect(byAlice).not.toMatch(/\byou\b/i);

    // Just me again: the creator's own Profile, with no headings, and nobody else's rows.
    h.setShared(false);
    await flush(alice);
    const justMe = await readText(`${ROOT}/profile.md`);
    expect(justMe).toContain('- lives_in: Seattle');
    expect(justMe).not.toContain('Bob Co');
    expect(justMe).not.toContain('##');
  });

  // No `auth:get-user` here, so nobody can be named, ever: another person's
  // key reads "a teammate", in the block, in recall and in the export.
  it("another person's key never prints as a raw id: it reads \"a teammate\"", async () => {
    const { h, flush, volumeText } = await sharedAgentWithExport();
    const alice = h.ctx({ userId: ALICE });
    await h.remember({ about: 'user', relation: 'lives in', value: 'Lisbon' }, h.ctx({ userId: BOB, conversationId: 'conv-b' }));

    const block = await augment(h, alice);
    expect(block).toContain('a teammate lives in: Lisbon');
    expect((await h.recall({}, alice)).statements.map((s) => s.aboutText)).toEqual(['a teammate']);

    await flush(alice);
    const files = await volumeText();
    expect(files).toContain('## a teammate');
    expect(files).toContain('Lisbon');
    for (const text of [block, files]) expect(text).not.toContain(BOB);
  });
});

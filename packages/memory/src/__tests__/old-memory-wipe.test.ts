import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  MEMORY_FACTS_EXPORT_ROOT,
  MEMORY_RULES_PATH,
  PluginError,
  validatePurgeSelector,
  type AgentContext,
} from '@ax/core';

import { volumeAgentKey, type MemoryVolumeConfig } from '../export-volume.js';
import {
  OLD_MEMORY_WIPE_COHORT_KEY,
  OLD_MEMORY_WIPE_COMPLETE_KEY,
  OLD_MEMORY_WIPE_KEEP,
  OLD_MEMORY_WIPE_PREFIXES,
  OLD_MEMORY_WIPED_EVENT,
  oldMemoryWipeDoneKey,
  runOldMemoryWipe,
} from '../old-memory-wipe.js';
import { createMemoryPlugin } from '../plugin.js';

/**
 * The one-time wipe is destructive and irreversible, so each test below is
 * written against a specific WRONG implementation and says which one:
 * markers set before the steps, the cohort re-listed on resume, carrying on
 * after a failure, a re-run that touches anything, content in a log line.
 */

const SENTINEL = 'SENTINEL-FACT-CONTENT-4f1c';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Call {
  hook: string;
  agentId: string;
  input: unknown;
}

interface World {
  bus: HookBus;
  store: Map<string, Uint8Array>;
  calls: Call[];
  /** Global order of destructive + marker events, e.g. `purge:agt_a`. */
  seq: string[];
  agentIds: string[];
  purgeReply: (agentId: string) => unknown;
  clearReply: (agentId: string) => unknown;
  failClearFor: Set<string>;
  /** Snapshot: was the agent's volume slot still non-empty at clear time? */
  volumeAtClear: Map<string, number>;
  volumeAtMarker: Map<string, number>;
}

let volDir: string;
let volume: MemoryVolumeConfig;
let lines: string[];

beforeEach(async () => {
  volDir = await mkdtemp(join(tmpdir(), 'ax-old-mem-wipe-'));
  volume = { hostRoot: volDir, backing: { server: 'nfs.internal', exportPath: '/srv/m' } };
  lines = [];
});

afterEach(async () => {
  await rm(volDir, { recursive: true, force: true });
});

function slotFactsDir(agentId: string): string {
  return join(volDir, volumeAgentKey(agentId), ...MEMORY_FACTS_EXPORT_ROOT.split('/'));
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else n += 1;
  }
  return n;
}

async function seedVolume(agentId: string): Promise<void> {
  const facts = slotFactsDir(agentId);
  await mkdir(join(facts, 'about'), { recursive: true });
  await writeFile(join(facts, 'profile.md'), `# profile\n${SENTINEL}\n`);
  await writeFile(join(facts, 'about', 'v-bob.md'), `${SENTINEL} bob\n`);
}

function makeWorld(agentIds: string[] = ['agt_b', 'agt_a']): World {
  const bus = new HookBus();
  const world: World = {
    bus,
    store: new Map(),
    calls: [],
    seq: [],
    agentIds,
    purgeReply: (agentId) => ({
      purged: [`memory/system/agent.md`, `memory/docs/${agentId}\n"odd".md`],
      version: 'v-new',
      pastVersionsChanged: true,
    }),
    clearReply: () => ({ removed: 3 }),
    failClearFor: new Set(),
    volumeAtClear: new Map(),
    volumeAtMarker: new Map(),
  };
  const record = (hook: string, ctx: AgentContext, input: unknown): void => {
    world.calls.push({ hook, agentId: ctx.agentId, input });
  };
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    'stub-storage',
    async (ctx, input) => {
      record('storage:get', ctx, input);
      return { value: world.store.get(input.key) };
    },
  );
  bus.registerService<{ key: string; value: Uint8Array }, void>(
    'storage:set',
    'stub-storage',
    async (ctx, input) => {
      record('storage:set', ctx, input);
      world.seq.push(`set:${input.key}`);
      const done = /^memory:old-memory-wipe:v1:done:(.*)$/.exec(input.key);
      if (done !== null) {
        world.volumeAtMarker.set(done[1]!, await countFiles(slotFactsDir(done[1]!)));
      }
      world.store.set(input.key, input.value);
    },
  );
  bus.registerService<Record<string, never>, { agentIds: string[] }>(
    'agents:list-ids',
    'stub-agents',
    async (ctx, input) => {
      record('agents:list-ids', ctx, input);
      return { agentIds: [...world.agentIds] };
    },
  );
  bus.registerService('workspace:purge', 'stub-workspace', async (ctx, input) => {
    record('workspace:purge', ctx, input);
    world.seq.push(`purge:${ctx.agentId}`);
    return world.purgeReply(ctx.agentId);
  });
  bus.registerService('memory:facts:clear', 'stub-facts', async (ctx, input) => {
    record('memory:facts:clear', ctx, input);
    world.seq.push(`clear:${ctx.agentId}`);
    world.volumeAtClear.set(ctx.agentId, await countFiles(slotFactsDir(ctx.agentId)));
    if (world.failClearFor.has(ctx.agentId)) throw new Error('facts store exploded');
    return world.clearReply(ctx.agentId);
  });
  return world;
}

const run = (world: World, withVolume = true) =>
  runOldMemoryWipe(world.bus, {
    ...(withVolume ? { volume } : {}),
    writeLine: (l) => lines.push(l),
  });

const destructive = (w: World) =>
  w.calls.filter((c) => c.hook === 'workspace:purge' || c.hook === 'memory:facts:clear');

const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('old-memory-wipe constants', () => {
  it('wipes memory/ and the facts export, keeping only the rules file', () => {
    expect(OLD_MEMORY_WIPE_PREFIXES).toEqual(['memory/', 'permanent/memory/facts/']);
    expect(OLD_MEMORY_WIPE_KEEP).toEqual([MEMORY_RULES_PATH]);
    expect(() =>
      validatePurgeSelector({
        prefixes: [...OLD_MEMORY_WIPE_PREFIXES],
        keep: [...OLD_MEMORY_WIPE_KEEP],
      }),
    ).not.toThrow();
  });
});

describe('runOldMemoryWipe — happy path', () => {
  it('wipes every cohort agent in order purge → clear → volume → marker, then completes', async () => {
    const w = makeWorld();
    await seedVolume('agt_a');
    await seedVolume('agt_b');

    const summary = await run(w);

    // Sorted cohort, stored BEFORE anything destructive.
    expect(w.seq).toEqual([
      `set:${OLD_MEMORY_WIPE_COHORT_KEY}`,
      'purge:agt_a',
      'clear:agt_a',
      `set:${oldMemoryWipeDoneKey('agt_a')}`,
      'purge:agt_b',
      'clear:agt_b',
      `set:${oldMemoryWipeDoneKey('agt_b')}`,
      `set:${OLD_MEMORY_WIPE_COMPLETE_KEY}`,
    ]);
    expect(JSON.parse(new TextDecoder().decode(w.store.get(OLD_MEMORY_WIPE_COHORT_KEY)))).toEqual([
      'agt_a',
      'agt_b',
    ]);
    // Volume emptied AFTER the facts clear and BEFORE the marker.
    expect(w.volumeAtClear.get('agt_a')).toBe(2);
    expect(w.volumeAtMarker.get('agt_a')).toBe(0);
    expect(w.volumeAtMarker.get('agt_b')).toBe(0);

    expect(summary).toEqual({ skipped: false, agents: 2, pathsRemoved: 4, factsRemoved: 6 });

    // Exact selector passed to the purge, per agent ctx.
    for (const c of destructive(w).filter((c) => c.hook === 'workspace:purge')) {
      expect(c.input).toEqual({
        prefixes: ['memory/', 'permanent/memory/facts/'],
        keep: ['memory/system/rules.md'],
      });
    }
    expect(destructive(w).find((c) => c.hook === 'memory:facts:clear')?.input).toEqual({});
  });

  it('logs one line per agent with paths and counts, JSON-encoded, never content', async () => {
    const w = makeWorld();
    await seedVolume('agt_a');
    await run(w);

    for (const l of lines) {
      expect(l).not.toContain(SENTINEL);
      expect(l).not.toContain('\n');
    }
    const events = parsed();
    expect(events[0]).toMatchObject({
      msg: 'memory_old_memory_wipe_started',
      cohortSize: 2,
      alreadyDone: 0,
    });
    const wiped = events.filter((e) => e.msg === OLD_MEMORY_WIPED_EVENT);
    expect(wiped).toHaveLength(2);
    expect(wiped[0]).toMatchObject({
      agentId: 'agt_a',
      workspacePathsRemoved: ['memory/system/agent.md', 'memory/docs/agt_a\n"odd".md'],
      workspacePathsRemovedCount: 2,
      pastVersionsChanged: true,
      factsRemoved: 3,
      exportFilesRemoved: 2,
    });
    expect(wiped[1]).toMatchObject({ agentId: 'agt_b', exportFilesRemoved: 0 });
    expect(events.at(-1)).toMatchObject({ msg: 'memory_old_memory_wipe_complete' });
  });

  it('builds each agent ctx from that agent id (never a shared or owner-less id)', async () => {
    const w = makeWorld();
    await run(w);
    expect(destructive(w).map((c) => `${c.hook}:${c.agentId}`)).toEqual([
      'workspace:purge:agt_a',
      'memory:facts:clear:agt_a',
      'workspace:purge:agt_b',
      'memory:facts:clear:agt_b',
    ]);
  });

  it('does not create a volume slot for an agent that never had one', async () => {
    const w = makeWorld(['agt_a']);
    await run(w);
    await expect(readdir(volDir)).resolves.toEqual([]);
  });

  it('works with no export volume configured', async () => {
    const w = makeWorld();
    const summary = await run(w, false);
    expect(summary).toMatchObject({ skipped: false, agents: 2 });
    expect(parsed().find((e) => e.msg === OLD_MEMORY_WIPED_EVENT)).toMatchObject({
      exportFilesRemoved: 0,
    });
  });
});

describe('runOldMemoryWipe — idempotence and resume', () => {
  it('a re-run after completion calls nothing but one storage:get', async () => {
    const w = makeWorld();
    await run(w);
    w.calls.length = 0;
    const summary = await run(w);
    expect(summary).toEqual({ skipped: true });
    expect(w.calls.map((c) => c.hook)).toEqual(['storage:get']);
    expect((w.calls[0]!.input as { key: string }).key).toBe(OLD_MEMORY_WIPE_COMPLETE_KEY);
  });

  it('fails loudly at agent 2 facts clear: agent 1 marked, agent 2 and complete not', async () => {
    const w = makeWorld();
    w.failClearFor.add('agt_b');
    const err = await run(w).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginError);
    const pe = err as PluginError;
    expect(pe.code).toBe('old-memory-wipe-failed');
    expect(pe.plugin).toBe('@ax/memory');
    expect(pe.message).toContain('agt_b');
    expect(pe.message).toContain('facts-clear');
    expect(pe.cause).toBeDefined();
    expect(w.store.has(oldMemoryWipeDoneKey('agt_a'))).toBe(true);
    expect(w.store.has(oldMemoryWipeDoneKey('agt_b'))).toBe(false);
    expect(w.store.has(OLD_MEMORY_WIPE_COMPLETE_KEY)).toBe(false);
  });

  it('stops at the first failing agent and does not continue to later ones', async () => {
    const w = makeWorld(['agt_a', 'agt_b', 'agt_c']);
    w.failClearFor.add('agt_b');
    await expect(run(w)).rejects.toThrow(/agt_b/);
    expect(destructive(w).some((c) => c.agentId === 'agt_c')).toBe(false);
  });

  it('resume wipes only the unfinished agent and never re-purges a done one', async () => {
    const w = makeWorld();
    w.failClearFor.add('agt_b');
    await expect(run(w)).rejects.toThrow();
    w.failClearFor.clear();
    w.calls.length = 0;
    w.seq.length = 0;
    lines = [];

    const summary = await run(w);
    expect(w.seq).toEqual([
      'purge:agt_b',
      'clear:agt_b',
      `set:${oldMemoryWipeDoneKey('agt_b')}`,
      `set:${OLD_MEMORY_WIPE_COMPLETE_KEY}`,
    ]);
    expect(summary).toMatchObject({ skipped: false, agents: 1 });
    expect(parsed()[0]).toMatchObject({ cohortSize: 2, alreadyDone: 1 });
    // The cohort was READ, not re-listed.
    expect(w.calls.some((c) => c.hook === 'agents:list-ids')).toBe(false);
  });

  it('an agent created after the cohort was written is never wiped on resume', async () => {
    const w = makeWorld();
    w.failClearFor.add('agt_b');
    await expect(run(w)).rejects.toThrow();
    w.failClearFor.clear();
    w.agentIds.push('agt_new');
    await run(w);
    expect(destructive(w).some((c) => c.agentId === 'agt_new')).toBe(false);
    expect(w.store.has(OLD_MEMORY_WIPE_COMPLETE_KEY)).toBe(true);
  });
});

describe('runOldMemoryWipe — refuses to guess', () => {
  it.each([
    ['not JSON', 'nope'],
    ['not an array', '{"a":1}'],
    ['a non-string id', '["agt_a", 5]'],
    ['an empty id', '["agt_a", ""]'],
    ['a duplicate id', '["agt_a", "agt_a"]'],
  ])('throws on a malformed stored cohort (%s) before any destructive call', async (_l, raw) => {
    const w = makeWorld();
    w.store.set(OLD_MEMORY_WIPE_COHORT_KEY, enc(raw));
    await expect(run(w)).rejects.toMatchObject({ code: 'old-memory-wipe-failed' });
    expect(destructive(w)).toEqual([]);
    expect(w.calls.some((c) => c.hook === 'agents:list-ids')).toBe(false);
    expect(w.store.has(OLD_MEMORY_WIPE_COMPLETE_KEY)).toBe(false);
  });

  it.each([
    ['not an array', { agentIds: 'agt_a' }],
    ['a blank id', { agentIds: ['agt_a', ' '] }],
    ['a non-string', { agentIds: [1] }],
  ])('throws on a malformed agents:list-ids reply (%s) without storing a cohort', async (_l, reply) => {
    const w2 = makeWorld();
    // Forward everything to the stub world except agents:list-ids.
    const bus = new HookBus();
    for (const hook of ['storage:get', 'storage:set', 'workspace:purge', 'memory:facts:clear']) {
      bus.registerService(hook, 'fwd', async (ctx, input) => w2.bus.call(hook, ctx, input));
    }
    bus.registerService('agents:list-ids', 'bad-agents', async () => reply);
    await expect(runOldMemoryWipe(bus, { writeLine: () => {} })).rejects.toMatchObject({
      code: 'old-memory-wipe-failed',
    });
    expect(w2.store.has(OLD_MEMORY_WIPE_COHORT_KEY)).toBe(false);
    expect(destructive(w2)).toEqual([]);
  });

  it('dedupes and sorts a listed cohort', async () => {
    const w = makeWorld(['agt_b', 'agt_a', 'agt_b']);
    await run(w);
    expect(JSON.parse(new TextDecoder().decode(w.store.get(OLD_MEMORY_WIPE_COHORT_KEY)))).toEqual([
      'agt_a',
      'agt_b',
    ]);
  });

  it.each([
    ['void', undefined],
    ['missing purged', { version: null, pastVersionsChanged: false }],
    ['purged not strings', { purged: [1], version: null, pastVersionsChanged: false }],
    ['version wrong type', { purged: [], version: 3, pastVersionsChanged: false }],
    ['pastVersionsChanged missing', { purged: [], version: 'v' }],
  ])('throws on a malformed workspace:purge reply (%s) and marks nothing', async (_l, reply) => {
    const w = makeWorld();
    w.purgeReply = () => reply;
    await expect(run(w)).rejects.toThrow(/agt_a.*purge|purge.*agt_a/);
    expect(w.calls.some((c) => c.hook === 'memory:facts:clear')).toBe(false);
    expect(w.store.has(oldMemoryWipeDoneKey('agt_a'))).toBe(false);
  });

  it.each([
    ['negative', { removed: -1 }],
    ['non-number', { removed: '3' }],
    ['null', null],
    ['void', undefined],
    ['non-integer', { removed: 1.5 }],
  ])('throws on a malformed memory:facts:clear reply (%s)', async (_l, reply) => {
    const w = makeWorld();
    w.clearReply = () => reply;
    await expect(run(w)).rejects.toThrow(/facts-clear/);
    expect(w.store.has(oldMemoryWipeDoneKey('agt_a'))).toBe(false);
  });

  it('names the export-volume step when the slot cannot be emptied', async () => {
    const w = makeWorld(['agt_a']);
    // A regular FILE where the agent's slot directory should be.
    await writeFile(join(volDir, volumeAgentKey('agt_a')), 'x');
    await expect(run(w)).rejects.toThrow(/agt_a.*export-volume/);
    expect(w.store.has(oldMemoryWipeDoneKey('agt_a'))).toBe(false);
  });

  it('names the marker step when the done marker cannot be written', async () => {
    const w = makeWorld(['agt_a']);
    const bus = new HookBus();
    for (const hook of ['storage:get', 'agents:list-ids', 'workspace:purge', 'memory:facts:clear']) {
      bus.registerService(hook, 'fwd', async (ctx, input) => w.bus.call(hook, ctx, input));
    }
    bus.registerService<{ key: string; value: Uint8Array }, void>(
      'storage:set',
      'flaky',
      async (ctx, input) => {
        if (input.key.includes(':done:')) throw new Error('disk full');
        await w.bus.call('storage:set', ctx, input);
      },
    );
    await expect(runOldMemoryWipe(bus, { writeLine: () => {} })).rejects.toThrow(
      /agt_a.*marker/,
    );
    expect(w.store.has(OLD_MEMORY_WIPE_COMPLETE_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

const MIGRATION_HOOKS = [
  'agents:list-ids',
  'storage:get',
  'storage:set',
  'workspace:purge',
  'memory:facts:clear',
];

function registerToolCatalog(bus: HookBus): void {
  bus.registerService('tool:register', 'stub-tools', async () => ({ ok: true }));
}

describe('createMemoryPlugin — wipeOldMemory', () => {
  it('declares the migration hooks only when enabled', () => {
    const off = createMemoryPlugin({}).manifest.calls;
    for (const h of MIGRATION_HOOKS) expect(off).not.toContain(h);
    const on = createMemoryPlugin({ wipeOldMemory: true }).manifest.calls;
    for (const h of MIGRATION_HOOKS) expect(on).toContain(h);
  });

  it('rejects a non-boolean wipeOldMemory', () => {
    expect(() =>
      createMemoryPlugin({ wipeOldMemory: 'yes' as unknown as boolean }),
    ).toThrow(/wipeOldMemory/);
  });

  it('calls no migration hook when disabled', async () => {
    const w = makeWorld();
    registerToolCatalog(w.bus);
    await createMemoryPlugin({}).init({ bus: w.bus, config: {} });
    expect(w.calls).toEqual([]);
  });

  it('runs the wipe inside init, awaited, emptying the export volume', async () => {
    const w = makeWorld();
    registerToolCatalog(w.bus);
    await seedVolume('agt_a');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let written = '';
    try {
      await createMemoryPlugin({ wipeOldMemory: true, exports: { volume } }).init({
        bus: w.bus,
        config: {},
      });
    } finally {
      written = stderr.mock.calls.map((c) => String(c[0])).join('');
      stderr.mockRestore();
    }
    // init resolved ⇒ the migration finished.
    expect(w.store.has(OLD_MEMORY_WIPE_COMPLETE_KEY)).toBe(true);
    expect(await countFiles(slotFactsDir('agt_a'))).toBe(0);
    expect(written).toContain(OLD_MEMORY_WIPED_EVENT);
    expect(written).not.toContain(SENTINEL);
  });

  it('rejects init when the wipe fails', async () => {
    const w = makeWorld();
    registerToolCatalog(w.bus);
    w.failClearFor.add('agt_b');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        createMemoryPlugin({ wipeOldMemory: true }).init({ bus: w.bus, config: {} }),
      ).rejects.toMatchObject({ code: 'old-memory-wipe-failed' });
    } finally {
      stderr.mockRestore();
    }
    expect(w.store.has(OLD_MEMORY_WIPE_COMPLETE_KEY)).toBe(false);
  });
});

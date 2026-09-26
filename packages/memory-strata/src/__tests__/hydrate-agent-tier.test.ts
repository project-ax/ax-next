import { describe, expect, it } from 'vitest';
import {
  HookBus,
  PluginError,
  asWorkspaceVersion,
  makeAgentContext,
  type AgentContext,
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import { createMemoryStrataPlugin } from '../plugin.js';
import { flushAgentTier, hydrateAgentTier } from '../agent-tier-sync.js';

// ---------------------------------------------------------------------------
// TASK-513: chat:start must not read the agent's whole `memory/**` subtree.
// Every `workspace:read` is ~80 ms on the git-server backend, serialised, on
// the blocking dispatch path — and bootstrap only needs its four seed files.
//
// The seed paths are spelled out here on purpose rather than imported from
// bootstrap.ts: the drift guard for the exported constant lives in
// bootstrap.test.ts, and these tests must say what chat:start reads in terms a
// reader can check without following the import.
// ---------------------------------------------------------------------------

const SEED_TIER_PATHS = [
  'memory/system/agent.md',
  'memory/system/user.md',
  'memory/system/session.md',
  'memory/system/map.md',
] as const;

type Snapshot = Map<string, Uint8Array>;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

interface Calls {
  reads: WorkspaceReadInput[];
  lists: WorkspaceListInput[];
  applies: WorkspaceApplyInput[];
}

/** A single-agent in-memory tier with linear history that honours
 *  `input.version`, records every call, and lets a test run code right after
 *  a read returns (to simulate a concurrent writer advancing the tier). */
function createTier(): {
  bus: HookBus;
  calls: Calls;
  seed: (files: Record<string, string>) => WorkspaceVersion;
  head: () => Snapshot;
  onAfterRead: (fn: ((n: number) => void) | null) => void;
} {
  const bus = new HookBus();
  const snapshots = new Map<WorkspaceVersion, Snapshot>();
  let latest: WorkspaceVersion | null = null;
  let counter = 0;
  const calls: Calls = { reads: [], lists: [], applies: [] };
  let afterRead: ((n: number) => void) | null = null;

  const commit = (changes: FileChange[]): WorkspaceVersion => {
    const base = latest === null ? new Map() : new Map(snapshots.get(latest));
    for (const c of changes) {
      if (c.kind === 'put') base.set(c.path, new Uint8Array(c.content));
      else base.delete(c.path);
    }
    const v = asWorkspaceVersion(`v-${counter++}`);
    snapshots.set(v, base);
    latest = v;
    return v;
  };

  bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    'test-tier',
    async (_ctx, input) => {
      calls.applies.push(input);
      if (input.parent !== latest) {
        throw new PluginError({
          code: 'parent-mismatch',
          plugin: 'test-tier',
          hookName: 'workspace:apply',
          message: 'parent mismatch',
          cause: { actualParent: latest },
        });
      }
      const before = latest;
      const version = commit(input.changes);
      return { version, delta: { before, after: version, changes: [] } };
    },
  );
  bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    'test-tier',
    async (_ctx, input) => {
      calls.reads.push({ ...input });
      const v = input.version ?? latest;
      let out: WorkspaceReadOutput = { found: false };
      if (v !== null) {
        const bytes = snapshots.get(v)?.get(input.path);
        if (bytes !== undefined) out = { found: true, bytes: new Uint8Array(bytes), version: v };
      }
      afterRead?.(calls.reads.length);
      return out;
    },
  );
  bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    'test-tier',
    async (_ctx, input) => {
      calls.lists.push({ ...input });
      const v = input.version ?? latest;
      if (v === null) return { paths: [] };
      return { paths: [...(snapshots.get(v)?.keys() ?? [])].sort() };
    },
  );
  bus.registerService('agents:resolve', 'test-agents', async () => ({
    agent: { model: 'anthropic/claude-haiku-4-5-20251001' },
  }));
  bus.registerService('tool:register', 'test-tools', async () => ({ ok: true as const }));

  return {
    bus,
    calls,
    seed: (files) =>
      commit(Object.entries(files).map(([path, s]) => ({ path, kind: 'put' as const, content: enc(s) }))),
    head: () => (latest === null ? new Map() : new Map(snapshots.get(latest))),
    onAfterRead: (fn) => {
      afterRead = fn;
    },
  };
}

async function withMemoryPlugin(bus: HookBus): Promise<void> {
  const mem = createMemoryStrataPlugin({ consolidatorDebounceMs: 0 });
  await mem.init?.({ bus, config: {} });
}

const ctx: AgentContext = makeAgentContext({
  sessionId: 's1',
  agentId: 'atlas',
  userId: 'u1',
  workspace: { rootPath: '/opt/ax-next/host' },
});

function otherDocs(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`memory/docs/general/doc-${i}.md`] = `doc ${i} body`;
  return out;
}

const isMemoryRead = (r: WorkspaceReadInput): boolean => r.path.startsWith('memory/');
const isIdentityRead = (r: WorkspaceReadInput): boolean => r.path.startsWith('.ax/');

describe('chat:start reads only the bootstrap seed files (TASK-513)', () => {
  it('a warm agent with 50 other docs: exactly the 4 seed reads, zero lists, no identity reads', async () => {
    const tier = createTier();
    const seeded: Record<string, string> = { ...otherDocs(50), '.ax/IDENTITY.md': 'I am Atlas.' };
    for (const p of SEED_TIER_PATHS) seeded[p] = `existing ${p}`;
    tier.seed(seeded);
    await withMemoryPlugin(tier.bus);

    await tier.bus.fire('chat:start', ctx, {});

    expect(tier.calls.lists).toEqual([]);
    expect(tier.calls.reads.filter(isMemoryRead).map((r) => r.path).sort()).toEqual(
      [...SEED_TIER_PATHS].sort(),
    );
    expect(tier.calls.reads.filter(isIdentityRead)).toEqual([]);
    // Everything already existed: nothing to write.
    expect(tier.calls.applies).toEqual([]);
  });

  it('a fresh agent (no memory) still seeds all 4 files, agent.md carrying the composed identity', async () => {
    const tier = createTier();
    tier.seed({ '.ax/IDENTITY.md': 'I am Atlas, a careful deployer.' });
    await withMemoryPlugin(tier.bus);

    await tier.bus.fire('chat:start', ctx, {});

    const head = tier.head();
    for (const p of SEED_TIER_PATHS) expect(head.has(p), p).toBe(true);
    const agentMd = dec(head.get('memory/system/agent.md')!);
    expect(agentMd).toContain('## Identity');
    expect(agentMd).toContain('I am Atlas, a careful deployer.');
  });

  it('a partial seed set: creates only the missing files, never deletes or rewrites other docs', async () => {
    const tier = createTier();
    const docs = otherDocs(50);
    tier.seed({
      ...docs,
      'memory/inbox/2026-09-01T00-00-00.000Z.md': 'an inbox observation',
      'memory/system/agent.md': 'existing agent',
      'memory/system/user.md': 'existing user',
    });
    const before = tier.head();
    await withMemoryPlugin(tier.bus);

    await tier.bus.fire('chat:start', ctx, {});

    expect(tier.calls.applies).toHaveLength(1);
    const changes = tier.calls.applies[0]!.changes;
    expect(changes.filter((c) => c.kind === 'delete')).toEqual([]);
    expect(changes.map((c) => c.path).sort()).toEqual([
      'memory/system/map.md',
      'memory/system/session.md',
    ]);
    const after = tier.head();
    for (const [p, bytes] of before) expect(dec(after.get(p)!), p).toBe(dec(bytes));
  });
});

describe('hydrateAgentTier pins every read to one snapshot (TASK-513)', () => {
  it('full mode: every read after the first found one carries its version; baseVersion equals it', async () => {
    const tier = createTier();
    const v0 = tier.seed({ ...otherDocs(5), 'memory/system/agent.md': 'a' });

    const hydrated = await hydrateAgentTier(tier.bus, ctx);
    try {
      const reads = tier.calls.reads;
      expect(reads.length).toBe(6);
      for (const r of reads.slice(1)) expect(r.version).toBe(v0);
      expect(hydrated.baseVersion).toBe(v0);
    } finally {
      await hydrated.dispose();
    }
  });

  it('a concurrent write between reads does not tear the hydrate: all bytes come from the first snapshot', async () => {
    const tier = createTier();
    const docs = otherDocs(5);
    const v0 = tier.seed(docs);
    // Right after the FIRST read returns, a concurrent writer rewrites every doc.
    tier.onAfterRead((n) => {
      if (n !== 1) return;
      tier.onAfterRead(null);
      tier.seed(Object.fromEntries(Object.keys(docs).map((p) => [p, `CONCURRENT ${p}`])));
    });

    const hydrated = await hydrateAgentTier(tier.bus, ctx);
    try {
      expect(hydrated.baseVersion).toBe(v0);
      expect(hydrated.baseline.size).toBe(5);
      for (const [p, bytes] of hydrated.baseline) expect(dec(bytes), p).toBe(docs[p]);
    } finally {
      await hydrated.dispose();
    }
  });

  it('only mode: skips workspace:list, reads just the named memory paths, pinned; ignores paths outside memory/', async () => {
    const tier = createTier();
    const v0 = tier.seed({
      ...otherDocs(5),
      'memory/system/agent.md': 'a',
      'memory/system/user.md': 'u',
      '.ax/IDENTITY.md': 'not memory',
    });

    const hydrated = await hydrateAgentTier(tier.bus, ctx, {
      only: ['memory/system/agent.md', 'memory/system/user.md', 'memory/system/map.md', '.ax/IDENTITY.md', 'memoryx/evil.md', 'memory/../.ax/IDENTITY.md', 'memory/system/user.md'],
    });
    try {
      expect(tier.calls.lists).toEqual([]);
      expect(tier.calls.reads.map((r) => r.path)).toEqual([
        'memory/system/agent.md',
        'memory/system/user.md',
        'memory/system/map.md',
      ]);
      for (const r of tier.calls.reads.slice(1)) expect(r.version).toBe(v0);
      expect(hydrated.baseVersion).toBe(v0);
      expect([...hydrated.baseline.keys()].sort()).toEqual([
        'memory/system/agent.md',
        'memory/system/user.md',
      ]);
      // A flush of an untouched partial hydrate applies nothing — in particular
      // it never deletes the docs it did not read.
      expect(await flushAgentTier(tier.bus, ctx, hydrated, 'noop')).toBe(false);
    } finally {
      await hydrated.dispose();
    }
  });
});

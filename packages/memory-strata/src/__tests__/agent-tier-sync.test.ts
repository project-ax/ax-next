import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  PluginError,
  asWorkspaceVersion,
  makeAgentContext,
  type AgentContext,
  type AgentOutcome,
  type FileChange,
  type LlmCallInput,
  type LlmCallOutput,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import { createMemoryStrataIndexSqlitePlugin } from '@ax/memory-strata-index-sqlite';
import { createMemoryStrataPlugin, DEFAULT_MEMORY_OPS_MODEL } from '../plugin.js';
import {
  AGENT_TIER_MEMORY_ROOT,
  agentTierAvailable,
  flushAgentTier,
  hydrateAgentTier,
} from '../agent-tier-sync.js';

/**
 * The `llm:call:<provider>` hook the memory operations actually use, DERIVED
 * from the role binding rather than spelled out. These stubs used to hardcode
 * `llm:call:anthropic`; when the memory role moved to another provider they
 * failed with "the Observer wrote nothing", which reads like a broken feature
 * and was really a stub registered on the wrong hook.
 */
const MEMORY_OPS_HOOK = `llm:call:${DEFAULT_MEMORY_OPS_MODEL.slice(0, DEFAULT_MEMORY_OPS_MODEL.indexOf('/'))}`;

// ---------------------------------------------------------------------------
// TASK-182: prove consolidated memory lands per-agent in the `/agent` git tier
// and is readable by a (later) reflection turn — the property the TASK-180
// skill-crystallization walk requires. The trap this fixes: in the k8s preset
// EVERY agent's `ctx.workspace.rootPath` is the SAME shared host CWD, so a
// rootPath-keyed store pools all agents together AND never reaches the runner.
//
// The mock below is keyed per-(userId, agentId), which is stricter than the
// real workspace-git-server tier now is: since TASK-257, `workspaceIdFor`
// hashes `agentId` alone, so the real tier is shared by every user
// authorized to reach the agent. The mock's extra userId axis is still
// exercised harmlessly here (every case below varies agentId too), and
// keeping it stricter than production is a fine, conservative test double —
// it just no longer mirrors the real derivation exactly. It also emits
// `parent-mismatch` + `cause.actualParent` so the CAS rebase-retry path is
// exercised, NOT short-circuited.
// ---------------------------------------------------------------------------

type Snapshot = Map<string, Uint8Array>;

/** Per-agent in-memory workspace tier. One linear-history store per
 *  (userId, agentId) key — the multi-tenant shape the bug violated. */
interface TierProbe {
  /** When set, every `workspace:read` waits on it first (a slow/cold tier). */
  readGate?: Promise<void>;
  /** When set, only reads whose path starts with this wait on `readGate`. */
  readGatePrefix?: string;
  /** Counts `workspace:apply` calls — the tier writes. */
  applies: number;
}

function createPerAgentWorkspace(probe?: TierProbe): { plugin: ReturnType<typeof buildPlugin> } {
  function buildPlugin(): import('@ax/core').Plugin {
    const stores = new Map<
      string,
      { snapshots: Map<WorkspaceVersion, Snapshot>; latest: WorkspaceVersion | null }
    >();
    let counter = 0;
    const keyOf = (ctx: AgentContext): string => `${ctx.userId}\u0000${ctx.agentId}`;
    const storeFor = (ctx: AgentContext) => {
      const k = keyOf(ctx);
      let s = stores.get(k);
      if (s === undefined) {
        s = { snapshots: new Map(), latest: null };
        stores.set(k, s);
      }
      return s;
    };
    const apply = (base: Snapshot, changes: FileChange[]): Snapshot => {
      const next: Snapshot = new Map(base);
      for (const c of changes) {
        if (c.kind === 'put') next.set(c.path, new Uint8Array(c.content));
        else next.delete(c.path);
      }
      return next;
    };
    return {
      manifest: {
        name: 'test-per-agent-workspace',
        version: '0.0.0',
        registers: ['workspace:apply', 'workspace:read', 'workspace:list'],
        calls: [],
        subscribes: [],
      },
      init({ bus }) {
        bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          'test-per-agent-workspace',
          async (ctx, input) => {
            if (probe !== undefined) probe.applies += 1;
            const s = storeFor(ctx);
            if (input.parent !== s.latest) {
              throw new PluginError({
                code: 'parent-mismatch',
                plugin: 'test-per-agent-workspace',
                hookName: 'workspace:apply',
                message: 'parent mismatch',
                cause: { actualParent: s.latest },
              });
            }
            const parentSnap = s.latest === null ? new Map() : s.snapshots.get(s.latest) ?? new Map();
            const nextSnap = apply(parentSnap, input.changes);
            const version = asWorkspaceVersion(`v-${counter++}`);
            s.snapshots.set(version, nextSnap);
            s.latest = version;
            return {
              version,
              delta: { before: input.parent, after: version, changes: [] },
            };
          },
        );
        bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
          'workspace:read',
          'test-per-agent-workspace',
          async (ctx, input) => {
            if (
              probe?.readGate !== undefined &&
              (probe.readGatePrefix === undefined || input.path.startsWith(probe.readGatePrefix))
            ) {
              await probe.readGate;
            }
            const s = storeFor(ctx);
            const v = input.version ?? s.latest;
            if (v === null) return { found: false };
            const snap = s.snapshots.get(v);
            const bytes = snap?.get(input.path);
            if (bytes === undefined) return { found: false };
            return { found: true, bytes: new Uint8Array(bytes), version: v };
          },
        );
        bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
          'workspace:list',
          'test-per-agent-workspace',
          async (ctx, input) => {
            const s = storeFor(ctx);
            const v = input.version ?? s.latest;
            if (v === null) return { paths: [] };
            const snap = s.snapshots.get(v);
            if (snap === undefined) return { paths: [] };
            return { paths: [...snap.keys()].sort() };
          },
        );
      },
    };
  }
  return { plugin: buildPlugin };
}

const SHARED_HOST_CWD = '/opt/ax-next/host'; // the pooling trap: same for all agents

async function buildBus(observations: Record<string, string>, probe?: TierProbe): Promise<{
  bus: HookBus;
  settleObserver: (agentId: string) => Promise<void>;
  settleConsolidation: (agentId: string) => Promise<void>;
}> {
  const bus = new HookBus();
  bus.registerService<{ agentId: string; userId: string }, { agent: { model: string } }>(
    'agents:resolve',
    'test-agents',
    async (_ctx, input) => {
      void input;
      // PR 2: agent models are `provider/model-id` refs; the plugin routes on
      // the `anthropic/` half and sends the bare id to the memory-ops provider hook.
      return { agent: { model: 'anthropic/claude-haiku-4-5-20251001' } };
    },
  );
  // The LLM returns whichever observation list the test seeded for the agentId
  // embedded in the prompt — so agent A and agent B extract DIFFERENT facts.
  bus.registerService<LlmCallInput, LlmCallOutput>(MEMORY_OPS_HOOK, 'test-llm', async (ctx) => {
    const text = observations[ctx.agentId] ?? '[]';
    return { text, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } };
  });
  bus.registerService('tool:register', 'test-tool-dispatcher', async () => ({ ok: true as const }));

  // The per-agent workspace tier (the fix's target).
  const { plugin } = createPerAgentWorkspace(probe);
  const wsPlugin = plugin();
  await wsPlugin.init?.({ bus, config: {} });

  let settleObserver!: (agentId: string) => Promise<void>;
  let settleConsolidation!: (agentId: string) => Promise<void>;
  const mem = createMemoryStrataPlugin({
    consolidatorDebounceMs: 0,
    testHooks: {
      onObserverSettleReady: (fn) => { settleObserver = fn; },
      onConsolidationSettleReady: (fn) => { settleConsolidation = fn; },
    },
  });
  // Await init — it registers the chat:start/chat:end subscribers AFTER an
  // `await registerMemorySearch(...)`. Firing events before init settles would
  // miss the subscribers entirely (the bug that made this suite flake).
  await mem.init?.({ bus, config: {} });

  return { bus, settleObserver, settleConsolidation };
}

function ctxFor(agentId: string, userId: string, source?: 'user' | 'routine'): AgentContext {
  return makeAgentContext({
    sessionId: `${agentId}-session`,
    agentId,
    userId,
    // The pooling trap: every agent shares the SAME host workspace root.
    workspace: { rootPath: SHARED_HOST_CWD },
    ...(source !== undefined ? { source } : {}),
  });
}

const completeTurn = (text: string): AgentOutcome => ({
  kind: 'complete',
  messages: [
    { role: 'user', content: `please remember: ${text}` },
    { role: 'assistant', content: 'noted' },
  ],
});

/** Read every `memory/**` path out of an agent's tier — simulates what a
 *  reflection runner sees in its materialized `/agent`. */
async function readTierMemory(
  bus: HookBus,
  ctx: AgentContext,
): Promise<Map<string, string>> {
  const listed = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    ctx,
    {},
  );
  const out = new Map<string, string>();
  for (const p of listed.paths) {
    if (!p.startsWith(`${AGENT_TIER_MEMORY_ROOT}/`)) continue;
    const r = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', ctx, {
      path: p,
    });
    if (r.found) out.set(p, new TextDecoder().decode(r.bytes));
  }
  return out;
}

let identityRoot: string;
beforeEach(async () => {
  identityRoot = await mkdtemp(join(tmpdir(), 'mem-tier-id-'));
});
afterEach(async () => {
  await rm(identityRoot, { recursive: true, force: true });
});

describe('agent-tier sync (TASK-182)', () => {
  it('agentTierAvailable is true only when the three workspace hooks are registered', async () => {
    const bare = new HookBus();
    expect(agentTierAvailable(bare)).toBe(false);
    const { bus } = await buildBus({});
    expect(agentTierAvailable(bus)).toBe(true);
  });

  it('writes a high-confidence preference into the agent tier as memory/docs + recent.md, readable later', async () => {
    const obs = JSON.stringify([
      { fact: 'Always deploy via the canary script first.', subject: 'deploy-flow', factType: 'preference', confidence: 0.95 },
    ]);
    const { bus, settleObserver, settleConsolidation } = await buildBus({ atlas: obs });

    const ctx = ctxFor('atlas', 'user-1');
    await bus.fire('chat:start', ctx, {});
    // Turn 1: the observer writes the inbox observation to the tier. The
    // consolidator that also fires on this chat:end may race the observer's
    // flush (production-realistic), so we drive a SECOND turn to consolidate.
    await bus.fire('chat:end', ctx, { outcome: completeTurn('canary first') });
    await settleObserver('atlas');
    await settleConsolidation('atlas');
    // Turn 2: consolidation now hydrates the tier WITH the flushed inbox,
    // promotes the high-confidence preference, and flushes docs + recent.md.
    await bus.fire('chat:end', ctx, { outcome: completeTurn('canary first again') });
    await settleObserver('atlas');
    await settleConsolidation('atlas');

    const mem = await readTierMemory(bus, ctx);
    // recent.md (the cached consolidation view the reflection reads first).
    expect(mem.has(`${AGENT_TIER_MEMORY_ROOT}/system/recent.md`)).toBe(true);
    // A promoted doc carrying the fact.
    const docEntry = [...mem.entries()].find(
      ([p, body]) => p.startsWith(`${AGENT_TIER_MEMORY_ROOT}/docs/`) && body.includes('canary script'),
    );
    expect(docEntry).toBeDefined();
  });

  it('does NOT pool across tenants: agent A memory is invisible to agent B, despite a SHARED host workspace root', async () => {
    const { bus, settleObserver, settleConsolidation } = await buildBus({
      atlas: JSON.stringify([
        { fact: 'Atlas-only marker: prefers tabs for indentation.', subject: 'atlas-style', factType: 'preference', confidence: 0.95 },
      ]),
      zephyr: JSON.stringify([
        { fact: 'Zephyr-only marker: prefers spaces for indentation.', subject: 'zephyr-style', factType: 'preference', confidence: 0.95 },
      ]),
    });

    const atlasCtx = ctxFor('atlas', 'user-1');
    const zephyrCtx = ctxFor('zephyr', 'user-2');

    await bus.fire('chat:start', atlasCtx, {});
    await bus.fire('chat:end', atlasCtx, { outcome: completeTurn('tabs') });
    await settleObserver('atlas');
    await settleConsolidation('atlas');
    await bus.fire('chat:end', atlasCtx, { outcome: completeTurn('tabs again') });
    await settleObserver('atlas');
    await settleConsolidation('atlas');

    await bus.fire('chat:start', zephyrCtx, {});
    await bus.fire('chat:end', zephyrCtx, { outcome: completeTurn('spaces') });
    await settleObserver('zephyr');
    await settleConsolidation('zephyr');
    await bus.fire('chat:end', zephyrCtx, { outcome: completeTurn('spaces again') });
    await settleObserver('zephyr');
    await settleConsolidation('zephyr');

    const atlasMem = [...(await readTierMemory(bus, atlasCtx)).values()].join('\n');
    const zephyrMem = [...(await readTierMemory(bus, zephyrCtx)).values()].join('\n');

    // Each agent sees its own fact.
    expect(atlasMem).toContain('Atlas-only marker');
    expect(zephyrMem).toContain('Zephyr-only marker');
    // Neither sees the other's — the no-cross-tenant-pooling property.
    expect(atlasMem).not.toContain('Zephyr-only marker');
    expect(zephyrMem).not.toContain('Atlas-only marker');
  });

  it('routine-source turns do not write memory (reflection-eats-itself guard still holds on the tier path)', async () => {
    const { bus, settleObserver, settleConsolidation } = await buildBus({
      atlas: JSON.stringify([
        { fact: 'Should not be recorded.', subject: 'x', factType: 'preference', confidence: 0.95 },
      ]),
    });
    const ctx = ctxFor('atlas', 'user-1', 'routine');
    await bus.fire('chat:start', ctx, {});
    await bus.fire('chat:end', ctx, { outcome: completeTurn('ignore me') });
    await settleObserver('atlas');
    await settleConsolidation('atlas');

    const mem = await readTierMemory(bus, ctx);
    // chat:start still bootstraps the system files, but NO inbox/doc from the
    // routine turn — the observer + consolidator skip source==='routine'.
    const hasObservation = [...mem.values()].some((b) => b.includes('Should not be recorded'));
    expect(hasObservation).toBe(false);
  });

  it('system-prompt:augment reads the injected memory block from the agent tier (not the host CWD)', async () => {
    const { bus, settleObserver, settleConsolidation } = await buildBus({
      atlas: JSON.stringify([
        { fact: 'Always deploy via the canary script first.', subject: 'deploy-flow', factType: 'preference', confidence: 0.95 },
      ]),
    });
    const ctx = ctxFor('atlas', 'user-1');
    await bus.fire('chat:start', ctx, {});
    await bus.fire('chat:end', ctx, { outcome: completeTurn('canary first') });
    await settleObserver('atlas');
    await settleConsolidation('atlas');
    await bus.fire('chat:end', ctx, { outcome: completeTurn('canary first again') });
    await settleObserver('atlas');
    await settleConsolidation('atlas');

    // The injector reads recent.md from the TIER (owner-routed by ctx), even
    // though ctx.workspace.rootPath is the shared host CWD that holds nothing.
    const augment = await bus.call<Record<string, never>, { contributions: Array<{ source: string; body: string }> }>(
      'system-prompt:augment',
      ctx,
      {},
    );
    const block = augment.contributions.map((c) => c.body).join('\n');
    // recent.md's "Recent Changes" lists the promoted doc id (deploy-flow).
    expect(block).toContain('Recent');
    expect(block.length).toBeGreaterThan(0);
  });
});

describe('flushAgentTier CAS retry (TASK-182)', () => {
  it('retries against the tier actual head on a parent-mismatch (concurrent advance), last-write-wins', async () => {
    const { bus } = await buildBus({});
    const ctx = ctxFor('atlas', 'user-1');

    // Hydrate an empty tier (baseVersion null).
    const hydrated = await hydrateAgentTier(bus, ctx);
    expect(hydrated.baseVersion).toBeNull();

    // A CONCURRENT writer advances the tier between our hydrate and flush.
    await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes: [{ path: 'memory/other.md', kind: 'put', content: new TextEncoder().encode('concurrent') }],
      parent: null,
      reason: 'concurrent',
    });

    // Write a memory file into the scratch, then flush. parent=null is now a
    // CAS miss → flush retries against the advanced head and succeeds.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const docDir = join(hydrated.scratchRoot, 'permanent', 'memory', 'docs', 'general');
    await mkdir(docDir, { recursive: true });
    await writeFile(join(docDir, 'mine.md'), 'mine');

    const applied = await flushAgentTier(bus, ctx, hydrated, 'memory-consolidate');
    expect(applied).toBe(true);
    await hydrated.dispose();

    // Both the concurrent file and our file survive (disjoint paths merge).
    const mem = await readTierMemory(bus, ctx);
    expect(mem.has('memory/docs/general/mine.md')).toBe(true);
    expect(mem.has('memory/other.md')).toBe(true);
  });

  it('returns false (no apply) when the scratch memory tree is unchanged from baseline', async () => {
    const { bus } = await buildBus({});
    const ctx = ctxFor('atlas', 'user-1');
    const hydrated = await hydrateAgentTier(bus, ctx);
    const applied = await flushAgentTier(bus, ctx, hydrated, 'noop');
    await hydrated.dispose();
    expect(applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK-186: the host-side memory tools (memory_note, memory_read_section) and
// the memory_search index must ALSO be per-agent in tier deployments — TASK-182
// only routed the observer/consolidator/inject. These prove the three remaining
// surfaces no longer pool across agents on the shared host CWD.
// ---------------------------------------------------------------------------

describe('host-tool + index per-agent keying on the tier path (TASK-186)', () => {
  it('memory_note writes the inbox observation into the per-agent tier, not the shared host CWD', async () => {
    const { bus } = await buildBus({});
    const ctx = ctxFor('atlas', 'user-1');

    const out = await bus.call('tool:execute:memory_note', ctx, {
      id: 'c1',
      name: 'memory_note',
      input: { subject: 'deploy', content: 'Atlas note: always canary first.' },
    });
    expect(out).toMatchObject({ ok: true });

    // The note landed in the agent's `/agent` tier under memory/inbox/…
    const mem = await readTierMemory(bus, ctx);
    const inboxEntry = [...mem.entries()].find(
      ([p, body]) => p.startsWith(`${AGENT_TIER_MEMORY_ROOT}/inbox/`) && body.includes('always canary first'),
    );
    expect(inboxEntry).toBeDefined();
  });

  it('memory_note isolates per agent: agent B never sees agent A\'s note', async () => {
    const { bus } = await buildBus({});
    const atlasCtx = ctxFor('atlas', 'user-1');
    const zephyrCtx = ctxFor('zephyr', 'user-2');

    await bus.call('tool:execute:memory_note', atlasCtx, {
      id: 'a', name: 'memory_note',
      input: { subject: 'style', content: 'Atlas-only marker: prefers tabs.' },
    });
    await bus.call('tool:execute:memory_note', zephyrCtx, {
      id: 'b', name: 'memory_note',
      input: { subject: 'style', content: 'Zephyr-only marker: prefers spaces.' },
    });

    const atlasMem = [...(await readTierMemory(bus, atlasCtx)).values()].join('\n');
    const zephyrMem = [...(await readTierMemory(bus, zephyrCtx)).values()].join('\n');
    expect(atlasMem).toContain('Atlas-only marker');
    expect(zephyrMem).toContain('Zephyr-only marker');
    // The pooling bug: a shared host CWD would have leaked one into the other.
    expect(atlasMem).not.toContain('Zephyr-only marker');
    expect(zephyrMem).not.toContain('Atlas-only marker');
  });

  it('memory_note still rejects credentials BEFORE any tier I/O', async () => {
    const { bus } = await buildBus({});
    const ctx = ctxFor('atlas', 'user-1');
    const out = await bus.call('tool:execute:memory_note', ctx, {
      id: 'c', name: 'memory_note',
      input: { subject: 'creds', content: 'key sk-ant-XXXXXXXXXXXXXXXXXXXXX' },
    });
    expect(out).toMatchObject({ rejected: true, reason: 'sensitive' });
    // Nothing was flushed to the tier.
    const mem = await readTierMemory(bus, ctx);
    const hasInbox = [...mem.keys()].some((p) => p.startsWith(`${AGENT_TIER_MEMORY_ROOT}/inbox/`));
    expect(hasInbox).toBe(false);
  });

  it('memory_read_section reads a doc from the per-agent tier (not the shared host CWD)', async () => {
    const { bus } = await buildBus({});
    const ctx = ctxFor('atlas', 'user-1');

    // Seed a doc directly into the agent's tier (simulating a prior
    // consolidation flush) and read a section back through the tool.
    const docBody = '## Facts\n\nAtlas always deploys via the canary script.\n\n## Notes\n\nrunbook lives in ops.\n';
    const docFile = [
      '---',
      'id: preference/deploy',
      'type: docs/preference',
      'summary: deploy flow',
      'factType: preference',
      'source_observations: []',
      '---',
      docBody,
    ].join('\n');
    await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes: [{
        path: `${AGENT_TIER_MEMORY_ROOT}/docs/preference/deploy.md`,
        kind: 'put',
        content: new TextEncoder().encode(docFile),
      }],
      parent: null,
      reason: 'seed',
    });

    const section = await bus.call('tool:execute:memory_read_section', ctx, {
      id: 'r1', name: 'memory_read_section',
      input: { docId: 'preference/deploy', header: 'Facts' },
    });
    expect(section).toEqual({ body: 'Atlas always deploys via the canary script.' });

    // Whole-body read (no header) also works on the tier path.
    const whole = await bus.call('tool:execute:memory_read_section', ctx, {
      id: 'r2', name: 'memory_read_section',
      input: { docId: 'preference/deploy' },
    });
    expect(whole).toMatchObject({ body: expect.stringContaining('canary script') });
  });

  it('memory_read_section returns doc-not-found for a doc that lives only in ANOTHER agent\'s tier', async () => {
    const { bus } = await buildBus({});
    const atlasCtx = ctxFor('atlas', 'user-1');
    const zephyrCtx = ctxFor('zephyr', 'user-2');

    const docFile = [
      '---', 'id: preference/secret', 'type: docs/preference', 'summary: s',
      'factType: preference', 'source_observations: []', '---', '## Facts\n\nAtlas secret.\n',
    ].join('\n');
    await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', atlasCtx, {
      changes: [{
        path: `${AGENT_TIER_MEMORY_ROOT}/docs/preference/secret.md`,
        kind: 'put',
        content: new TextEncoder().encode(docFile),
      }],
      parent: null,
      reason: 'seed',
    });

    // Zephyr asks for Atlas's docId — the tier is owner-routed, so Zephyr's
    // read resolves against ZEPHYR's empty repo → not found. No cross-tenant leak.
    const out = await bus.call('tool:execute:memory_read_section', zephyrCtx, {
      id: 'r', name: 'memory_read_section',
      input: { docId: 'preference/secret', header: 'Facts' },
    });
    expect(out).toEqual({ error: 'doc-not-found' });
  });

  it('memory_read_section still rejects a traversal docId before any tier read', async () => {
    const { bus } = await buildBus({});
    const ctx = ctxFor('atlas', 'user-1');
    const out = await bus.call('tool:execute:memory_read_section', ctx, {
      id: 'r', name: 'memory_read_section',
      input: { docId: '../../etc/passwd' },
    });
    expect(out).toEqual({ error: 'invalid-docId' });
  });

  it('consolidation populates the per-agent search index from the tier, and search is isolated per agent', async () => {
    // Wire a real sqlite index alongside the per-agent workspace + memory-strata
    // so `memory_search` (retriever → memory:index:search) exercises the
    // TASK-186 keying end-to-end. Before the fix the index never populated on
    // the tier path (consolidator omitted bus/ctx → no memory:doc:written).
    const bus = new HookBus();
    bus.registerService<{ agentId: string; userId: string }, { agent: { model: string } }>(
      // PR 2: agent models are `provider/model-id` refs.
      'agents:resolve', 'test-agents', async () => ({ agent: { model: 'anthropic/claude-haiku-4-5-20251001' } }),
    );
    const observations: Record<string, string> = {
      atlas: JSON.stringify([
        { fact: 'Atlas canary marker: deploy via the canary script.', subject: 'deploy', factType: 'preference', confidence: 0.95 },
      ]),
      zephyr: JSON.stringify([
        { fact: 'Zephyr rollback marker: roll back with the undo command.', subject: 'rollback', factType: 'preference', confidence: 0.95 },
      ]),
    };
    bus.registerService<LlmCallInput, LlmCallOutput>(MEMORY_OPS_HOOK, 'test-llm', async (ctx) => ({
      text: observations[ctx.agentId] ?? '[]', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 },
    }));
    bus.registerService('tool:register', 'test-tool-dispatcher', async () => ({ ok: true as const }));

    const wsPlugin = createPerAgentWorkspace().plugin();
    await wsPlugin.init?.({ bus, config: {} });

    // In-memory sqlite index (shared store across agents — the surface keying protects).
    const idx = createMemoryStrataIndexSqlitePlugin({ databasePath: ':memory:' });
    await idx.init?.({ bus, config: {} });

    let settleObserver!: (a: string) => Promise<void>;
    let settleConsolidation!: (a: string) => Promise<void>;
    const mem = createMemoryStrataPlugin({
      consolidatorDebounceMs: 0,
      testHooks: {
        onObserverSettleReady: (fn) => { settleObserver = fn; },
        onConsolidationSettleReady: (fn) => { settleConsolidation = fn; },
      },
    });
    await mem.init?.({ bus, config: {} });

    const atlasCtx = ctxFor('atlas', 'user-1');
    const zephyrCtx = ctxFor('zephyr', 'user-2');

    const drive = async (ctx: AgentContext, a: string) => {
      await bus.fire('chat:start', ctx, {});
      await bus.fire('chat:end', ctx, { outcome: completeTurn('turn1') });
      await settleObserver(a); await settleConsolidation(a);
      await bus.fire('chat:end', ctx, { outcome: completeTurn('turn2') });
      await settleObserver(a); await settleConsolidation(a);
    };
    await drive(atlasCtx, 'atlas');
    await drive(zephyrCtx, 'zephyr');

    const search = async (ctx: AgentContext, query: string) =>
      bus.call<{ query: string; topK: number }, { results: Array<{ docId: string; summary: string }> }>(
        'memory:index:search', ctx, { query, topK: 10 },
      );

    // Atlas searching "marker" finds ONLY its own doc; Zephyr only its own.
    const atlasHits = await search(atlasCtx, 'marker');
    const atlasSummaries = atlasHits.results.map((r) => r.summary).join(' | ');
    expect(atlasSummaries).toContain('Atlas canary marker');
    expect(atlasSummaries).not.toContain('Zephyr rollback marker');

    const zephyrHits = await search(zephyrCtx, 'marker');
    const zephyrSummaries = zephyrHits.results.map((r) => r.summary).join(' | ');
    expect(zephyrSummaries).toContain('Zephyr rollback marker');
    expect(zephyrSummaries).not.toContain('Atlas canary marker');

    await idx.shutdown?.();
  });
});

/**
 * TASK-552 — a chat:start bootstrap the bus has given up on stops before it
 * writes. chat:start is fired with a subscriber bound; past it the turn moves
 * on and the bus aborts the subscriber's signal. Before this, a bootstrap
 * stuck on a slow tier kept going and flushed into the agent's tier after the
 * turn it belonged to had already started without it.
 */
describe('chat:start bootstrap honours the bus abort signal (TASK-552)', () => {
  const capture = (sink: Array<{ msg: string; bindings: Record<string, unknown> }>) => {
    const logger: import('@ax/core').Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg, bindings) => {
        sink.push({ msg, bindings: bindings ?? {} });
      },
      error: (msg, bindings) => {
        sink.push({ msg, bindings: bindings ?? {} });
      },
      child: () => logger,
    };
    return logger;
  };

  const run = async (subscriberTimeoutMs: number | undefined, readGatePrefix?: string) => {
    let release!: () => void;
    const probe: TierProbe = {
      readGate: new Promise<void>((r) => {
        release = r;
      }),
      ...(readGatePrefix !== undefined ? { readGatePrefix } : {}),
      applies: 0,
    };
    const { bus } = await buildBus({}, probe);
    const logged: Array<{ msg: string; bindings: Record<string, unknown> }> = [];
    const ctx = makeAgentContext({
      sessionId: 'slow-session',
      agentId: 'slow-agent',
      userId: 'u',
      workspace: { rootPath: SHARED_HOST_CWD },
      logger: capture(logged),
    });
    const fired = bus.fire(
      'chat:start',
      ctx,
      {},
      subscriberTimeoutMs === undefined ? undefined : { subscriberTimeoutMs },
    );
    return { bus, ctx, probe, logged, fired, release };
  };

  it('stops before the tier flush when its bound elapses mid-hydrate', async () => {
    const { bus, ctx, probe, logged, fired, release } = await run(20);
    // The fire returns at the bound while the tier read is still stuck.
    await expect(fired).resolves.toMatchObject({ rejected: false });
    expect(logged.map((l) => l.msg)).toContain('hook_subscriber_timed_out');
    // Now the tier recovers. The abandoned bootstrap must notice it was told
    // to stop and write nothing.
    release();
    await vi.waitFor(() => {
      expect(logged.map((l) => l.msg)).toContain('memory_strata_bootstrap_aborted');
    });
    expect(logged.find((l) => l.msg === 'memory_strata_bootstrap_aborted')!.bindings).toEqual({
      agentId: 'slow-agent',
      stage: 'hydrated',
    });
    expect(probe.applies, 'no tier write after the bus gave up').toBe(0);
    expect((await readTierMemory(bus, ctx)).size).toBe(0);
  });

  it('stops at the last check — right before the flush — when the bound elapses after hydrate', async () => {
    // Only the identity reads (`.ax/…`, after the hydrate) are slow, so the
    // hydrate check passes and the seed is written to the scratch; the check
    // guarding the shared-storage flush is the one that must catch it.
    const { bus, ctx, probe, logged, fired, release } = await run(20, '.ax/');
    await expect(fired).resolves.toMatchObject({ rejected: false });
    release();
    await vi.waitFor(() => {
      expect(logged.map((l) => l.msg)).toContain('memory_strata_bootstrap_aborted');
    });
    expect(logged.find((l) => l.msg === 'memory_strata_bootstrap_aborted')!.bindings).toEqual({
      agentId: 'slow-agent',
      stage: 'seeded',
    });
    expect(probe.applies, 'no tier write after the bus gave up').toBe(0);
    expect((await readTierMemory(bus, ctx)).size).toBe(0);
  });

  it('control: the same slow tier with no bound DOES flush the seed', async () => {
    // Without this, the case above could pass because bootstrap never writes
    // on this fixture at all.
    const { bus, ctx, probe, logged, fired, release } = await run(undefined);
    release();
    await fired;
    expect(probe.applies).toBeGreaterThan(0);
    expect((await readTierMemory(bus, ctx)).size).toBeGreaterThan(0);
    expect(logged.map((l) => l.msg)).not.toContain('memory_strata_bootstrap_aborted');
  });
});

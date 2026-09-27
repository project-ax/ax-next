// TASK-523 decisions 4 and 5: the store's vectors carry ONE model's geometry,
// and a store whose vectors went missing gets them back without anyone having
// to call `memory:facts:reindex`.
//
// Two model spaces in one `vec0` table is the failure this file exists for.
// Nothing errors when it happens: a query vector from model B is compared
// against document vectors from model A, every distance is a real number, and
// the dense channel confidently returns nonsense. So every test here asserts
// on the STORE (row counts, the recorded fingerprint, which vectors are
// there), not on a recall's answer, which would look plausible either way.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { HookBus, makeAgentContext } from '@ax/core';
import type { AgentContext } from '@ax/core';
import type { RecordInput, RecordOutput } from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin, type MemoryFactsSqliteConfig } from '../plugin.js';
import { openDatabase, EMBEDDING_META_TABLE, FTS_TABLE, TABLE, VEC_TABLE } from '../schema.js';
import { denseChannel, factStatementText } from '../recall.js';
import { agentScopeKey } from '../agent-scope-key.js';
import { EMBED_HOOK, hashVector } from './hash-embedder.js';
import type { EmbedInput, EmbedOutput } from '../producers.js';
import { EMBEDDING_RECIPE_GENERATION } from '../plugin.js';

/** Appends the current recipe generation, matching `embeddingFingerprint` in `plugin.ts`. */
function withGeneration(fingerprint: string): string {
  return `${fingerprint}#${EMBEDDING_RECIPE_GENERATION}`;
}

const JAN = '2023-01-01T00:00:00.000Z';
const JUN = '2023-06-01T00:00:00.000Z';
const SEP = '2023-09-01T00:00:00.000Z';

const KHALID = { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN };
const BOSTON = { about: 'user', relation: 'lives_in', value: 'Boston', when: JUN };
const ACME = { about: 'user', relation: 'works_at', value: 'Acme', when: SEP };

const AGENT_A = agentScopeKey({ agentId: 'a' });

/**
 * A vector that depends on the MODEL as well as the text: model `A` is the
 * hash embedder as-is, any other model reverses it. Same norm, same
 * dimensionality, entirely different geometry — which is exactly what a real
 * model swap looks like to `vec0`.
 */
function modelVector(model: string | undefined, text: string): number[] {
  const base = hashVector(text);
  return model === 'A' ? base : [...base].reverse();
}

interface ModelEmbedder {
  calls: EmbedInput[];
  /** When set, any call whose texts include this substring waits on {@link release}. */
  gateOn?: string;
  release: () => void;
  mode: 'ok' | 'fail';
}

function registerModelEmbedder(bus: HookBus): ModelEmbedder {
  let open: () => void = () => {};
  let gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state: ModelEmbedder = {
    calls: [],
    release: () => {
      open();
      gate = Promise.resolve();
    },
    mode: 'ok',
  };
  bus.registerService<EmbedInput, EmbedOutput>(
    EMBED_HOOK,
    'test:model-embedder',
    async (_ctx, input) => {
      state.calls.push(input);
      if (state.mode === 'fail') throw new Error('producer down');
      if (state.gateOn !== undefined && input.texts.some((t) => t.includes(state.gateOn!))) {
        await gate;
      }
      return { vectors: input.texts.map((text) => modelVector(input.model, text)) };
    },
  );
  return state;
}

function ctxOf(agentId = 'a'): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId,
    userId: 'u',
    workspace: { rootPath: '/tmp' },
  });
}

describe('@ax/memory-facts-sqlite — embedding-model fingerprint + re-embed', () => {
  let dir: string;
  let databasePath: string;
  const plugins: Array<ReturnType<typeof createMemoryFactsSqlitePlugin>> = [];
  const toClose: BetterSqliteDb[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-fingerprint-'));
    databasePath = join(dir, 'facts.db');
  });

  afterEach(async () => {
    for (const plugin of plugins.splice(0)) await plugin.shutdown?.();
    for (const db of toClose.splice(0)) if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(
    config: Partial<MemoryFactsSqliteConfig> = {},
  ): Promise<{
    bus: HookBus;
    embedder: ModelEmbedder;
    plugin: ReturnType<typeof createMemoryFactsSqlitePlugin>;
    background: Array<Promise<void>>;
  }> {
    const bus = new HookBus();
    const embedder = registerModelEmbedder(bus);
    const background: Array<Promise<void>> = [];
    const plugin = createMemoryFactsSqlitePlugin({
      databasePath,
      onBackgroundWork: (work) => {
        background.push(work);
      },
      ...config,
    });
    plugins.push(plugin);
    await plugin.init({ bus, config: {} });
    return { bus, embedder, plugin, background };
  }

  async function stop(plugin: ReturnType<typeof createMemoryFactsSqlitePlugin>): Promise<void> {
    await plugin.shutdown?.();
    plugins.splice(plugins.indexOf(plugin), 1);
  }

  function record(bus: HookBus, statements: RecordInput['statements']): Promise<RecordOutput> {
    return bus.call<RecordInput, RecordOutput>('memory:facts:record', ctxOf(), { statements });
  }

  function peek(): BetterSqliteDb {
    const opened = openDatabase(databasePath);
    toClose.push(opened.driver);
    return opened.driver;
  }

  function vecCount(db: BetterSqliteDb): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number }).n;
  }

  function storedFingerprint(db: BetterSqliteDb): string | undefined {
    return (
      db.prepare(`SELECT value FROM ${EMBEDDING_META_TABLE} WHERE key = 'model'`).get() as
        | { value: string }
        | undefined
    )?.value;
  }

  function idOf(db: BetterSqliteDb, value: string): string {
    return (db.prepare(`SELECT id FROM ${TABLE} WHERE value = ?`).get(value) as { id: string }).id;
  }

  /** Seed the store under model A: two facts, two model-A vectors. */
  async function seedUnderModelA(): Promise<void> {
    const { bus, plugin } = await start({ embedder: { hook: EMBED_HOOK, model: 'A' } });
    await record(bus, [KHALID, BOSTON]);
    await stop(plugin);
    const db = peek();
    expect(vecCount(db)).toBe(2);
    expect(storedFingerprint(db)).toBe(withGeneration('A'));
    db.close();
  }

  it('wipes every vector when the configured model changes, and records the new one', async () => {
    await seedUnderModelA();

    await start({ embedder: { hook: EMBED_HOOK, model: 'B' } });

    const db = peek();
    expect(vecCount(db)).toBe(0);
    expect(storedFingerprint(db)).toBe(withGeneration('B'));
    // Nothing model-A is left for a model-B query to be compared against —
    // including the exact vector that would have been Khalid's nearest match.
    const scope = { agentKey: AGENT_A, activeOnly: true, limit: 40 };
    expect(denseChannel(db, scope, modelVector('A', factStatementText('user', 'likes_artist', 'Khalid')))).toEqual([]);
  });

  it('a successful record under the new model re-embeds the agent in the background, with the new model', async () => {
    await seedUnderModelA();
    const { bus, embedder, background } = await start({
      embedder: { hook: EMBED_HOOK, model: 'B' },
    });

    await record(bus, [ACME]);
    expect(background).toHaveLength(1);
    await Promise.all(background);

    const db = peek();
    expect(vecCount(db)).toBe(3);
    // Every call after the reopen asked for model B — the record's and the
    // backfill's alike.
    expect(embedder.calls.length).toBeGreaterThanOrEqual(2);
    expect(embedder.calls.every((c) => c.model === 'B')).toBe(true);
    // And the backfilled vector really is model B's: Khalid's model-B vector
    // finds Khalid first.
    const scope = { agentKey: AGENT_A, activeOnly: true, limit: 40 };
    const khalidText = factStatementText('user', 'likes_artist', 'Khalid');
    expect(denseChannel(db, scope, modelVector('B', khalidText))[0]).toBe(idOf(db, 'Khalid'));
  });

  it('leaves vectors untouched when the model is unchanged', async () => {
    await seedUnderModelA();
    const before = peek();
    const khalidBlob = before
      .prepare(`SELECT embedding FROM ${VEC_TABLE} WHERE id = ?`)
      .get(idOf(before, 'Khalid')) as { embedding: Buffer };
    before.close();

    await start({ embedder: { hook: EMBED_HOOK, model: 'A' } });

    const db = peek();
    expect(vecCount(db)).toBe(2);
    expect(storedFingerprint(db)).toBe(withGeneration('A'));
    const after = db
      .prepare(`SELECT embedding FROM ${VEC_TABLE} WHERE id = ?`)
      .get(idOf(db, 'Khalid')) as { embedding: Buffer };
    expect(Buffer.compare(after.embedding, khalidBlob.embedding)).toBe(0);
  });

  /** A pre-TASK-523 store: vectors from an unknown model, no fingerprint at all. */
  async function seedLegacyVectors(): Promise<void> {
    await seedUnderModelA();
    const db = peek();
    db.exec(`DROP TABLE ${EMBEDDING_META_TABLE}`);
    db.close();
  }

  it('wipes vectors a pre-fingerprint store holds, since their model is unknown', async () => {
    await seedLegacyVectors();

    await start({ embedder: { hook: EMBED_HOOK, model: 'A' } });

    const db = peek();
    // Even though the configured model happens to be the one that wrote them:
    // the store cannot know that, and guessing is how spaces get mixed.
    expect(vecCount(db)).toBe(0);
    expect(storedFingerprint(db)).toBe(withGeneration('A'));
  });

  /**
   * A pre-TASK-590 store: the fingerprint was recorded as the BARE model id
   * (what `embeddingFingerprint` returned before the generation suffix
   * existed), with vectors that are actually query-embedded — OpenRouter
   * dropped `task` on every call, so every stored fact was embedded as a
   * query, not a document.
   */
  async function seedPreTask590(): Promise<void> {
    await seedUnderModelA();
    const db = peek();
    db.prepare(`UPDATE ${EMBEDDING_META_TABLE} SET value = ? WHERE key = 'model'`).run('A');
    db.close();
  }

  it('wipes vectors recorded under the bare model id (pre-TASK-590), and records the generation-suffixed fingerprint', async () => {
    await seedPreTask590();
    const before = peek();
    expect(storedFingerprint(before)).toBe('A');
    before.close();

    await start({ embedder: { hook: EMBED_HOOK, model: 'A' } });

    const db = peek();
    // Same model id, but the recipe generation changed underneath it — the
    // bare-id fingerprint mismatches the new `A#<generation>` exactly once.
    expect(vecCount(db)).toBe(0);
    expect(storedFingerprint(db)).toBe(withGeneration('A'));
  });

  it('re-embeds a pre-TASK-590 wipe as documents on the next successful record, restoring every vector', async () => {
    await seedPreTask590();
    const { bus, embedder, background } = await start({
      embedder: { hook: EMBED_HOOK, model: 'A' },
    });

    await record(bus, [ACME]);
    expect(background).toHaveLength(1);
    await Promise.all(background);

    const db = peek();
    // Khalid + Boston (backfilled) + Acme (recorded) — every fact has a
    // vector again, none of them query-embedded this time.
    expect(vecCount(db)).toBe(3);
    expect(embedder.calls.length).toBeGreaterThanOrEqual(2);
    expect(embedder.calls.every((c) => c.task === 'document')).toBe(true);
  });

  it('touches nothing when no embedder is configured', async () => {
    await seedLegacyVectors();

    await start();

    const db = peek();
    expect(vecCount(db)).toBe(2);
    expect(storedFingerprint(db)).toBeUndefined();
  });

  it('fingerprints a model-less embedder by its hook name', async () => {
    await start({ embedder: { hook: EMBED_HOOK } });
    const db = peek();
    expect(storedFingerprint(db)).toBe(withGeneration(`hook-default:${EMBED_HOOK}`));
  });

  it('starts no background work when the recording embed failed', async () => {
    await seedUnderModelA();
    const { bus, embedder, background } = await start({
      embedder: { hook: EMBED_HOOK, model: 'B' },
    });
    embedder.mode = 'fail';

    await record(bus, [ACME]);

    expect(background).toHaveLength(0);
    expect(embedder.calls).toHaveLength(1);
    expect(vecCount(peek())).toBe(0);
  });

  it('a fact stored without a vector while the producer was down is re-embedded after the next healthy record', async () => {
    const { bus, embedder, background } = await start({
      embedder: { hook: EMBED_HOOK, model: 'B' },
    });
    // Healthy record: its probe finds nothing missing, so the agent is known
    // complete and later healthy records skip the probe.
    await record(bus, [ACME]);
    await Promise.all(background);
    expect(vecCount(peek())).toBe(1);

    embedder.mode = 'fail';
    await record(bus, [BOSTON]);
    expect(vecCount(peek())).toBe(1);

    embedder.mode = 'ok';
    const before = background.length;
    await record(bus, [KHALID]);
    expect(background.length).toBe(before + 1);
    await Promise.all(background);

    expect(vecCount(peek())).toBe(3);
  });

  it('runs one backfill per agent at a time, however many records land while it runs', async () => {
    await seedUnderModelA();
    const { bus, embedder, background } = await start({
      embedder: { hook: EMBED_HOOK, model: 'B' },
    });
    // Records embed their OWN text only, so they pass; the backfill embeds
    // Khalid's (missing since the wipe) and parks on the gate.
    embedder.gateOn = 'Khalid';

    await record(bus, [ACME]);
    await record(bus, [{ ...ACME, value: 'Initech' }]);
    await record(bus, [{ ...ACME, value: 'Globex' }]);

    expect(background).toHaveLength(1);
    // Detached, not awaited: all three records returned while the backfill is
    // still parked on the gate.
    const settled = await Promise.race([
      background[0]!.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(settled).toBe('pending');
    embedder.release();
    await Promise.all(background);

    const khalidCalls = embedder.calls.filter((c) => c.texts.some((t) => t.includes('Khalid')));
    expect(khalidCalls).toHaveLength(1);
    const db = peek();
    expect(vecCount(db)).toBe(5);
  });

  it('a backfill that loses a race with memory:facts:clear writes nothing back', async () => {
    await seedUnderModelA();
    const { bus, embedder, background } = await start({
      embedder: { hook: EMBED_HOOK, model: 'B' },
    });
    embedder.gateOn = 'Khalid';

    await record(bus, [ACME]);
    expect(background).toHaveLength(1);
    await bus.call('memory:facts:clear', ctxOf(), {});
    embedder.release();
    await Promise.all(background);

    const db = peek();
    expect(vecCount(db)).toBe(0);
    // "Forget this" must not be undone by a job that started before it.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get() as { n: number }).n,
    ).toBe(0);
  });

  it('a backfill caught mid-flight by shutdown settles quietly, with no unhandled rejection', async () => {
    await seedUnderModelA();
    const { bus, embedder, plugin, background } = await start({
      embedder: { hook: EMBED_HOOK, model: 'B' },
    });
    embedder.gateOn = 'Khalid';

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await record(bus, [ACME]);
      expect(background).toHaveLength(1);

      await stop(plugin);
      embedder.release();

      await expect(background[0]).resolves.toBeUndefined();
      // One macrotask so a stray rejection would have been reported.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    // And the job really did stop at the closed store: Khalid never got a vector.
    const db = peek();
    expect(vecCount(db)).toBe(1);
  });
});

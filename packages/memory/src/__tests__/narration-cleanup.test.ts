// TASK-1151: the one-off cleanup of the assistant's saved narration,
// `packages/memory/scripts/clean-assistant-narration.mjs`.
//
// It runs the script exactly as the runbook in its header does: this
// package's `self-report.ts`, then the script, as ONE program on stdin to
// `node --input-type=module-typescript -`. So the rows it deletes are the
// rows the observer's own `classifyAgentFact` drops, and anything that breaks
// that pipe (an import or non-erasable syntax in `self-report.ts`, or a
// top-level name the two files share) fails here first.
//
// The database is a real `@ax/memory-facts-sqlite` store, with FTS5 and vec0
// rows, and the engine stays open while the script runs, the way the host
// holds it in the pod. Every value carries a `V-<label>` sentinel, so "it
// prints counts only" is checked rather than assumed.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext, type Logger, type Plugin } from '@ax/core';
import type {
  Provenance,
  RecallInput,
  RecallOutput,
  RecordInput,
  RecordOutput,
} from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '@ax/memory-facts-sqlite';

const SELF_REPORT = readFileSync(new URL('../self-report.ts', import.meta.url), 'utf8');
const SCRIPT = readFileSync(
  new URL('../../scripts/clean-assistant-narration.mjs', import.meta.url),
  'utf8',
);

/** sqlite-vec, resolved through the engine: `@ax/memory` doesn't depend on it. */
const VEC_EXTENSION = (
  createRequire(createRequire(import.meta.url).resolve('@ax/memory-facts-sqlite'))(
    'sqlite-vec',
  ) as { getLoadablePath(): string }
).getLoadablePath();
const VEC_ARG = `--vec-extension=${VEC_EXTENSION}`;

const WHEN = '2026-11-01T00:00:00.000Z';
const DIMENSIONS = 384;

type Label =
  | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7'
  | 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'K8' | 'K9' | 'K10';

interface SeedRow {
  label: Label;
  about: string;
  relation: string;
  value: string;
  /** `agent-1` when absent. */
  agentId?: string;
  /** `extracted` (the observer's door) when absent. */
  provenance?: Provenance;
}

const SEED: readonly SeedRow[] = [
  // Deleted: the four classes the observer drops, in every agent.
  { label: 'D1', about: 'assistant', relation: 'created_artifact', value: 'the Q3 revenue dashboard V-D1' },
  { label: 'D2', about: 'Assistant', relation: 'Published Artifact', value: 'the Q3 revenue dashboard V-D2' },
  { label: 'D3', about: 'the_assistant', relation: 'ran_tests', value: 'all 42 passed V-D3' },
  { label: 'D4', about: 'assistant', relation: 'stated_limitation', value: 'cannot browse the internet V-D4' },
  { label: 'D5', about: 'assistant', relation: 'could_not_save_memory', value: 'the standup time V-D5' },
  {
    label: 'D6',
    about: 'assistant',
    relation: 'stated',
    value:
      'No rules have been given by the user; the only instructions came from the system bootstrap prompt V-D6',
  },
  { label: 'D7', agentId: 'agent-2', about: 'assistant', relation: 'fixed_bug', value: 'in the date parser V-D7' },
  // Kept: who it is, and what it supplied.
  { label: 'K1', about: 'assistant', relation: 'has_name', value: 'Ember V-K1' },
  { label: 'K2', about: 'assistant', relation: 'saved_standing_preference', value: 'reply in bullet points V-K2' },
  { label: 'K3', about: 'assistant', relation: 'recommended', value: 'the Fenway walking tour V-K3' },
  { label: 'K4', about: 'assistant', relation: 'listed', value: 'the 10 hiking trails near Denver V-K4' },
  // Untouched: not the assistant, or saved on purpose.
  { label: 'K5', about: 'user:alice', relation: 'lives_in', value: 'Denver V-K5' },
  { label: 'K6', about: 'agent', relation: 'published_artifact', value: 'the listing on Zillow V-K6' },
  { label: 'K7', provenance: 'agent', about: 'assistant', relation: 'created_artifact', value: 'the launch checklist V-K7' },
  { label: 'K8', provenance: 'human', about: 'assistant', relation: 'ran_tests', value: 'all passed V-K8' },
  // Kept although the observer drops them: TASK-612's check reads `agent` as
  // the agent too, but here it's a real-estate agent, and the delete is for good.
  {
    label: 'K9',
    about: 'the_agent',
    relation: 'received',
    value: 'no instructions from the seller about the counteroffer V-K9',
  },
  { label: 'K10', about: 'agent', relation: 'has_no_rules', value: 'about pets in the unit V-K10' },
];

const DOOMED: readonly Label[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
const KEPT: readonly Label[] = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10'];

/** The seed, counted the way the script counts it, in its output's key order. */
const SEED_COUNTS = {
  // Every `extracted` row: all but K7 (agent) and K8 (human).
  examined: 15,
  delete: { context: 1, 'own-narration': 1, 'action-narration': 4, capability: 1 },
  // K5 and K6 aren't the agent, so they're counted in neither. K9 and K10
  // are TASK-612's `agent` rows, kept on purpose.
  keep: { identity: 2, other: 2, 'agent-context': 2 },
  ftsRows: 7,
  vecRows: 7,
  keptClosedByDeleted: 0,
};

/** The one line the script prints for `report`. */
function line(report: object): string {
  return `${JSON.stringify(report)}\n`;
}

function oneHot(index: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

interface Snapshot {
  base: string[];
  fts: string[];
  vec: string[];
}

describe('the one-off narration cleanup (TASK-1151)', () => {
  let dir: string;
  let databasePath: string;
  let bus: HookBus;
  let engine: Plugin;
  let background: Array<Promise<void>>;
  let engineErrors: string[];
  let ids: Record<Label, string>;

  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg) => {
      engineErrors.push(msg);
    },
    child: () => logger,
  };

  function ctxFor(agentId: string): AgentContext {
    return makeAgentContext({
      sessionId: 's',
      agentId,
      userId: 'user-1',
      logger,
      workspace: { rootPath: '/tmp' },
    });
  }

  /**
   * The runbook's pipeline. `classifier` is what goes in front of the script:
   * `self-report.ts` (the default), nothing, or a stand-in's source. No
   * separator is added, exactly like `cat a b`.
   */
  function run(
    args: readonly string[],
    { classifier = true, env = {} }: { classifier?: boolean | string; env?: Record<string, string> } = {},
  ): SpawnSyncReturns<string> {
    const prefix = classifier === true ? SELF_REPORT : classifier === false ? '' : classifier;
    return spawnSync(process.execPath, ['--input-type=module-typescript', '-', ...args], {
      input: prefix + SCRIPT,
      env: { ...process.env, AX_MEMORY_FACTS_DB_PATH: databasePath, ...env },
      encoding: 'utf8',
    });
  }

  /**
   * Nothing a row holds reaches stdout OR stderr: no value (each carries
   * `V-`), no id, and no `_`, which most seeded predicates and
   * `the_assistant` have (the output's own words use hyphens).
   */
  function expectCountsOnly(result: SpawnSyncReturns<string>): void {
    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain('_');
      expect(text).not.toContain('V-');
      for (const id of Object.values(ids)) expect(text).not.toContain(id);
    }
  }

  /** Every id in the base table and both search tables, from a separate connection. */
  function snapshot(): Snapshot {
    const db = new Database(databasePath, {
      readonly: true,
      allowExtension: true,
    } as ConstructorParameters<typeof Database>[1]);
    try {
      db.loadExtension(VEC_EXTENSION);
      const column = (table: string): string[] =>
        (db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>)
          .map((row) => row.id)
          .sort();
      return {
        base: column('memory_facts_v1'),
        fts: column('memory_facts_v1_fts'),
        vec: column('memory_facts_v1_vec'),
      };
    } finally {
      db.close();
    }
  }

  function idsOf(labels: readonly Label[]): string[] {
    return labels.map((label) => ids[label]).sort();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narration-cleanup-'));
    databasePath = join(dir, 'facts.db');
    background = [];
    engineErrors = [];
    bus = new HookBus();
    bus.registerService<{ texts: string[] }, { vectors: number[][] }>(
      'test:embed',
      'test',
      async (_ctx, input) => ({
        vectors: input.texts.map((text) => oneHot(text.length % DIMENSIONS)),
      }),
    );
    engine = createMemoryFactsSqlitePlugin({
      databasePath,
      embedder: { hook: 'test:embed' },
      onBackgroundWork: (work) => {
        background.push(work);
      },
    });
    await engine.init({ bus, config: {} });
    const seeded: Partial<Record<Label, string>> = {};
    for (const row of SEED) {
      const out = await bus.call<RecordInput, RecordOutput>(
        'memory:facts:record',
        ctxFor(row.agentId ?? 'agent-1'),
        {
          statements: [
            {
              about: row.about,
              relation: row.relation,
              value: row.value,
              when: WHEN,
              ownerUserId: 'user-1',
              ...(row.provenance !== undefined ? { provenance: row.provenance } : {}),
            },
          ],
        },
      );
      seeded[row.label] = out.records[0]!.id;
    }
    ids = seeded as Record<Label, string>;
    await Promise.all(background);
  });

  afterEach(async () => {
    await Promise.all(background);
    await engine?.shutdown?.();
    await rm(dir, { recursive: true, force: true });
  });

  it('a dry run changes nothing and prints counts only', () => {
    const before = snapshot();
    // Precondition: every row is indexed both ways, so "unchanged" means something.
    const all = idsOf([...DOOMED, ...KEPT]);
    expect(before).toEqual({ base: all, fts: all, vec: all });

    const result = run([VEC_ARG]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(line({ mode: 'dry-run', ...SEED_COUNTS, deleted: 0, refused: null }));
    expectCountsOnly(result);
    expect(snapshot()).toEqual(before);
  });

  it('apply deletes exactly the narration rows, with their search rows', () => {
    const result = run(['--apply', VEC_ARG]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(line({ mode: 'apply', ...SEED_COUNTS, deleted: 7, refused: null }));
    expectCountsOnly(result);
    const kept = idsOf(KEPT);
    // D1–D7 are gone from all three tables, and K1–K8 keep every row they had.
    expect(snapshot()).toEqual({ base: kept, fts: kept, vec: kept });
  });

  it('an engine that stayed open across the cleanup recalls survivors and never a deleted row', async () => {
    const recall = async (): Promise<string[]> =>
      (
        await bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctxFor('agent-1'), {
          query: 'Fenway walking tour artifact tests',
          limit: 50,
        })
      ).statements.map((statement) => statement.id);
    // Precondition: through this same open engine, a doomed row WAS recallable.
    expect(await recall()).toContain(ids.D1);

    expect(run(['--apply', VEC_ARG]).status).toBe(0);

    const after = await recall();
    expect(after).toContain(ids.K3);
    const kept = idsOf(KEPT);
    for (const id of after) expect(kept).toContain(id);
    expect(engineErrors).toEqual([]);
  });

  it('a second apply deletes nothing', () => {
    expect(run(['--apply', VEC_ARG]).status).toBe(0);

    const again = run(['--apply', VEC_ARG]);

    expect(again.status).toBe(0);
    expect(again.stdout).toBe(
      line({
        mode: 'apply',
        examined: 8,
        delete: { context: 0, 'own-narration': 0, 'action-narration': 0, capability: 0 },
        keep: { identity: 2, other: 2, 'agent-context': 2 },
        ftsRows: 0,
        vecRows: 0,
        keptClosedByDeleted: 0,
        deleted: 0,
        refused: null,
      }),
    );
  });

  it('apply refuses without the vector extension when vectors exist, and changes nothing', () => {
    const before = snapshot();
    const refusal = line({
      mode: 'apply',
      ...SEED_COUNTS,
      vecRows: null,
      deleted: 0,
      refused: 'vectors-need-extension',
    });

    const missing = run(['--apply']);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe(refusal);
    expectCountsOnly(missing);

    // A wrong path is the same as none: the rows' vectors can't be deleted.
    const wrong = run(['--apply', `--vec-extension=${join(dir, 'no-such-vec0.so')}`]);
    expect(wrong.status).toBe(2);
    expect(wrong.stdout).toBe(refusal);
    expectCountsOnly(wrong);

    expect(snapshot()).toEqual(before);

    const dry = run([]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toBe(
      line({ mode: 'dry-run', ...SEED_COUNTS, vecRows: null, deleted: 0, refused: null }),
    );
  });

  it('apply refuses when a kept row was closed by a row it would delete', () => {
    const writer = new Database(databasePath);
    try {
      writer.prepare('UPDATE memory_facts_v1 SET closed_by = ? WHERE id = ?').run(ids.D1, ids.K1);
    } finally {
      writer.close();
    }
    const before = snapshot();

    const dry = run([VEC_ARG]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toBe(
      line({ mode: 'dry-run', ...SEED_COUNTS, keptClosedByDeleted: 1, deleted: 0, refused: null }),
    );

    const refused = run(['--apply', VEC_ARG]);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe(
      line({
        mode: 'apply',
        ...SEED_COUNTS,
        keptClosedByDeleted: 1,
        deleted: 0,
        refused: 'kept-rows-closed-by-deleted',
      }),
    );
    expectCountsOnly(refused);
    expect(snapshot()).toEqual(before);
  });

  it('refuses an unknown argument, a missing classifier and a missing database path', () => {
    const before = snapshot();
    const missingFile = join(dir, 'missing.db');
    const cases: Array<[SpawnSyncReturns<string>, string]> = [
      [run(['--aply']), 'unknown-argument'],
      [run(['--apply', '--vec-extension=']), 'unknown-argument'],
      [run([VEC_ARG, VEC_ARG]), 'unknown-argument'],
      [run([], { classifier: false }), 'classifier-missing'],
      [run([], { env: { AX_MEMORY_FACTS_DB_PATH: '' } }), 'no-database-path'],
      // Nothing there: an apply must not create an empty database in its place.
      [run(['--apply', VEC_ARG], { env: { AX_MEMORY_FACTS_DB_PATH: missingFile } }), 'no-database-path'],
    ];
    for (const [result, refused] of cases) {
      expect(result.status).toBe(2);
      expect(result.stdout).toBe(line({ refused }));
    }
    expect(existsSync(missingFile)).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('fails without changing anything, and names only a generic error', () => {
    // A database with no facts table: SQLite's message would name the table.
    const empty = join(dir, 'empty.db');
    new Database(empty).close();
    const noTable = run(['--apply', VEC_ARG], { env: { AX_MEMORY_FACTS_DB_PATH: empty } });
    expect(noTable.status).toBe(1);
    expect(noTable.stdout).toBe('');
    expect(noTable.stderr).toBe('narration-cleanup: failed: SQL logic error\n');

    // A classifier that answers a class the script doesn't know: stop, don't guess.
    const before = snapshot();
    const unknownClass = run(['--apply', VEC_ARG], {
      classifier: 'function classifyAgentFact() {\n  return "mystery";\n}\n',
    });
    expect(unknownClass.status).toBe(1);
    expect(unknownClass.stdout).toBe('');
    expect(unknownClass.stderr).toBe('narration-cleanup: failed: unknown-class\n');
    expect(snapshot()).toEqual(before);
  });

  it('rolls back, with a fixed reason, when the full-text index fails its integrity check', () => {
    // Damage the index on purpose: rewrite a kept row's stored text under its
    // index entries. SQLite's defensive mode refuses that, so only this test
    // connection turns it off; the engine and the script never do.
    const writer = new Database(databasePath);
    try {
      writer.unsafeMode(true);
      writer.prepare("UPDATE memory_facts_v1_fts_content SET c3 = 'tampered' WHERE c0 = ?").run(ids.K3);
    } finally {
      writer.close();
    }
    const before = snapshot();

    const result = run(['--apply', VEC_ARG]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('narration-cleanup: failed: fts-integrity-check-failed\n');
    expectCountsOnly(result);
    // The deletes ran, then rolled back with the failed check.
    expect(snapshot()).toEqual(before);
  });

  it('its runbook pipes it after self-report.ts and names a context on every kubectl line', () => {
    const kubectlLines = SCRIPT.split('\n').filter((text) => text.includes('kubectl'));
    expect(kubectlLines.length).toBeGreaterThanOrEqual(3);
    for (const text of kubectlLines) expect(text).toContain('--context "$KCTX"');
    expect(SCRIPT).toContain(
      'cat packages/memory/src/self-report.ts packages/memory/scripts/clean-assistant-narration.mjs',
    );
    expect(SCRIPT).toContain('node --input-type=module-typescript -');
    expect(SCRIPT).toContain('bash deploy/gke/backups.sh status --context "$KCTX"');
    // The runbook's `sqlite-vec-linux-*/…/vec0.so` glob rests on sqlite-vec's
    // layout: one `sqlite-vec-<os>-<arch>` package holding `vec0.<ext>`.
    expect(SCRIPT).toContain('sqlite-vec-linux-*/node_modules/sqlite-vec-linux-*/vec0.so');
    expect(basename(dirname(VEC_EXTENSION))).toMatch(/^sqlite-vec-[a-z]+-[a-z0-9]+$/);
    expect(basename(VEC_EXTENSION)).toMatch(/^vec0\.(?:so|dylib|dll)$/);
  });

  // An apply holds the store's write lock from its first read to its commit,
  // and the live host's driver waits only 5 s for a lock before a memory write
  // fails. FTS5's `id` is UNINDEXED, so finding a fact's search row by id
  // scans the whole table. Once per deleted fact (to count, then to delete),
  // that took 5.1 s at 20,000 rows and 1,000 deletions (measured); one pass
  // took 0.13 s. The store here is twice that size, so a scan per deletion in
  // EITHER step costs about four times as much and can't hide under the bound.
  it('keeps the write lock short on a big store: one pass over the search table, not one per deletion', () => {
    const writer = new Database(databasePath);
    try {
      const fact = writer.prepare(
        `INSERT INTO memory_facts_v1 (id, agent_key, about, relation, value, provenance, valid_start, transaction_time)
         VALUES (?, 'bulk', ?, ?, ?, 'extracted', ?, ?)`,
      );
      const search = writer.prepare(
        'INSERT INTO memory_facts_v1_fts (id, about, relation, value) VALUES (?, ?, ?, ?)',
      );
      writer.transaction(() => {
        for (let i = 0; i < 40_000; i += 1) {
          const [about, relation, value] =
            i < 2_000
              ? ['assistant', 'created_artifact', `the dashboard for week ${i}`]
              : ['user', 'lives_in', `a town numbered ${i}`];
          fact.run(`bulk-${i}`, about, relation, value, WHEN, WHEN);
          search.run(`bulk-${i}`, about, relation, value);
        }
      })();
    } finally {
      writer.close();
    }

    const started = performance.now();
    const result = run(['--apply', VEC_ARG]);
    const elapsed = performance.now() - started;

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ftsRows: 2_007, vecRows: 7, deleted: 2_007 });
    const reader = new Database(databasePath, { readonly: true });
    try {
      const count = (table: string): number =>
        (reader.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('memory_facts_v1')).toBe(SEED.length - 7 + 38_000);
      expect(count('memory_facts_v1_fts')).toBe(SEED.length - 7 + 38_000);
    } finally {
      reader.close();
    }
    // The whole process, Node's start-up included.
    expect(elapsed).toBeLessThan(2_000);
  });
});

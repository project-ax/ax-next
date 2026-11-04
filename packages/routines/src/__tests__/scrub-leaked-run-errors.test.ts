import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore, RUN_CLOSED, RUN_INTERRUPTED } from '../store.js';
import { BRIEF_DIDNT_LOAD, BRIEF_TOO_LONG, BRIEF_UNCONFIRMED } from '../brief.js';
import { runFailedText } from '../fire.js';
import { createInput } from './store-fixture.js';

// TASK-1036. The one-off scrub of old run errors (deploy/GKE.md, "4g. Scrub old run errors"),
// run as the operator runs it: the real file, through psql, against a migrated database.

const SCRUB = readFileSync(new URL('../../sql/scrub-leaked-run-errors.sql', import.meta.url), 'utf8');
const FIXED = runFailedText(undefined); // 'This run failed because of a problem on our side.'
/** BRIEF_TOO_LONG's two older wordings (1cf119aec, 1a6055fa9): runs before f0bad64a1 stored them. */
const OLDER_TOO_LONG = [
  'This task’s instructions are too long to load, so the check-in didn’t run. Shorten “What to do” and the next check-in will run.',
  'This task’s instructions are too long to load, so the check-in didn’t run. Shorten “What should … do?” in the agent’s settings and the next check-in will run.',
];
/** Every shape a current writer records, and an older host sentence: the scrub must leave each alone. */
const KEPT = [
  RUN_CLOSED, RUN_INTERRUPTED, 'This app update could not run.', 'This app update could not run. Try a new delivery.',
  'This app update was cancelled because the job changed.', 'the run finished without reporting a result',
  BRIEF_DIDNT_LOAD, BRIEF_TOO_LONG, BRIEF_UNCONFIRMED,
  ...OLDER_TOO_LONG,
  'This routine is disabled.', FIXED,
  runFailedText(new PluginError({ plugin: 'test', code: 'timeout', message: 'PRIVATE' })),
  runFailedText(Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' })),
  'terminated: chat-run-timeout',
  'terminated: ClaudeSdkTurnError: runner text', // kept on purpose (TASK-1036 decisions)
];
/** What writers before TASK-1031 (#1116) stored: a hook's or database's own text. */
const LEAKED = [
  "unknown: service hook 'conversations:create' threw: PRIVATE connection detail",
  "timeout: service hook 'agents:resolve' exceeded 30000ms",
  'PRIVATE bare database message',
  'Error: PRIVATE thrown value',
  '',
];
const CURLY = [BRIEF_DIDNT_LOAD, BRIEF_TOO_LONG, BRIEF_UNCONFIRMED, ...OLDER_TOO_LONG];
/**
 * Sentences a later release might write that the keep-list doesn't know. They read like ours, so
 * the scrub's guard counts them, and apply refuses to write while it counts any (TASK-1036 review).
 */
const NEW_SENTENCES = ['This is a brand new host sentence.', 'We could not start this task for a brand new reason!'] as const;
/**
 * More of our sentence shapes the guard must count (TASK-1036 review 2): a lowercase phrase with no
 * full stop, like fire.ts's `the run finished without reporting a result`; a question; a contraction
 * as the first word; first words in any case; It, A and An.
 */
const MORE_SENTENCES = [
  'the run stopped without a reply',
  'You can’t run this task right now?',
  'We’re still setting this task up.',
  'IT STOPPED BEFORE IT STARTED!',
  'an app update is already running',
  'A routine with this name already exists.',
] as const;
/** What psql prints before the counts: two SETs, BEGIN, the lock_timeout SET, the keep-list and guard functions. */
const PREAMBLE = ['SET', 'SET', 'BEGIN', 'SET', 'CREATE FUNCTION', 'CREATE FUNCTION'];
const STOPPED = 'Stopped: some rows look like a sentence this script does not know. A developer should look at them: they may be our own sentences missing from its keep-list, or old messages that only look like sentences.';

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }) });
  await runRoutinesMigration(db);
}, 120_000);
afterAll(async () => {
  await db?.destroy();
  if (container) await stopPostgresContainer(container);
}, 60_000);
beforeEach(async () => {
  await sql`TRUNCATE routines_v1_task_events,routines_v1_deliveries,routines_v1_retired_agents,routines_v1_definitions,routines_v1_fires,routines_v1_requests,routines_v1_dispatches,routines_v1_credential_cleanup,routines_v1_replies,agent_default_routine_overrides_v1`.execute(db);
});

/** Runs the real file with the container's own psql, as the runbook's pod does. */
async function runScrub(flags: string[] = [], env: Record<string, string> = {}) {
  await container.copyContentToContainer([{ content: SCRUB, target: '/tmp/scrub.sql' }]);
  return container.exec(['psql', '-X', '-v', 'ON_ERROR_STOP=1', ...flags, '-U', container.getUsername(),
    '-d', container.getDatabase(), '-f', '/tmp/scrub.sql'], { env });
}

/** {@link runScrub}, which must succeed: its stdout. */
async function scrub(flags: string[] = [], env: Record<string, string> = {}): Promise<string> {
  const r = await runScrub(flags, env);
  expect(r.exitCode, r.output).toBe(0);
  return r.stdout;
}

const lines = (out: string) => out.trimEnd().split('\n');

/** A run of `agentId`'s routine `r` that ended `status` with `error`: its id. */
async function addFire(status: 'ok' | 'silenced' | 'error', error: string | null, agentId = 'a', source: 'tick' | 'webhook' = 'tick'): Promise<string> {
  const inserted = await sql<{ id: string }>`INSERT INTO routines_v1_fires (agent_id, routine_id, trigger_source, status, error)
    VALUES (${agentId}, 'r', ${source}, ${status}, ${error}) RETURNING id`.execute(db);
  return inserted.rows[0]!.id;
}

/** A routine of agent `a` whose last run ended `status` with `error`: its routine id. */
async function addRoutine(name: string, status: 'ok' | 'error', error: string): Promise<string> {
  const routine = await createRoutinesStore(db).createAuthored({
    ...createInput(name.toLowerCase().replaceAll(' ', '-')), definition: { ...createInput().definition, name },
  });
  await sql`UPDATE routines_v1_definitions SET last_status=${status}, last_error=${error}
    WHERE agent_id=${routine.agentId} AND routine_id=${routine.routineId}`.execute(db);
  return routine.routineId;
}

/**
 * One failed run per KEPT and per LEAKED text (LEAKED[0]'s from a webhook), three runs that
 * must never be touched, and two routines whose last run failed: one with old text, one with
 * RUN_INTERRUPTED. All of agent `a`.
 */
async function seed(): Promise<{ leakedFires: Set<string>; leakedRoutine: string; keptRoutine: string }> {
  for (const error of KEPT) await addFire('error', error);
  const leakedFires = new Set<string>();
  for (const [i, error] of LEAKED.entries()) leakedFires.add(await addFire('error', error, 'a', i === 0 ? 'webhook' : 'tick'));
  await addFire('ok', null);
  await addFire('silenced', null);
  await addFire('error', null);
  const leakedRoutine = await addRoutine('Scrub leaked', 'error', LEAKED[0]!);
  const keptRoutine = await addRoutine('Scrub kept', 'error', RUN_INTERRUPTED);
  return { leakedFires, leakedRoutine, keptRoutine };
}

/** Every run's id, status and error, and every routine's last run and the fields an edit or a queued app update keys on. */
async function snapshot() {
  const fires = (await sql<{ id: string; status: string; error: string | null }>`
    SELECT id, status, error FROM routines_v1_fires ORDER BY id`.execute(db)).rows;
  const routines = (await sql<{ routine_id: string; last_status: string | null; last_error: string | null; revision: string; updated_at: string }>`
    SELECT routine_id, last_status, last_error, revision, updated_at::text AS updated_at
      FROM routines_v1_definitions ORDER BY routine_id`.execute(db)).rows;
  return { fires, routines };
}

/** psql sessions (the scrub) waiting for a lock right now. */
async function scrubsWaitingForALock(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE application_name = 'psql' AND wait_event_type = 'Lock'`.execute(db);
  return r.rows[0]!.n;
}

describe('scrub-leaked-run-errors.sql (TASK-1036)', () => {
  it.each<[string[]]>([[[]], [['-v', 'apply=0']]])('a dry run (%j) counts the old rows and changes nothing', async flags => {
    await seed();
    const before = await snapshot();
    const out = await scrub(flags);
    expect(lines(out)).toEqual([...PREAMBLE,
      'run-history rows with old error text: 5',
      'routines with old error text: 1',
      'old rows that look like a host sentence: 0',
      'Dry run: nothing was changed. Run again with -v apply=1 to rewrite them.',
      'ROLLBACK',
    ]);
    expect(await snapshot()).toEqual(before);
    expect(out).not.toContain('PRIVATE');
  });

  it('apply rewrites only the old rows, routines first, and a dry run afterwards finds none', async () => {
    const seeded = await seed();
    const before = await snapshot();
    expect(before.fires).toHaveLength(KEPT.length + LEAKED.length + 3);
    expect(seeded.leakedFires.size).toBe(LEAKED.length);
    const out = await scrub(['-v', 'apply=1']);
    // psql's own UPDATE tags give the order: the one routine, then the five runs. That is the
    // order purgeAgent (store.ts) locks them in. The two counts still print run history first.
    expect(lines(out)).toEqual([...PREAMBLE,
      'run-history rows with old error text: 5',
      'routines with old error text: 1',
      'old rows that look like a host sentence: 0',
      'UPDATE 1',
      'UPDATE 5',
      'run-history rows rewritten: 5',
      'routines rewritten: 1',
      'COMMIT',
    ]);
    expect(out).not.toContain('PRIVATE');
    const after = await snapshot();
    // Every LEAKED run now says FIXED; every KEPT run and the three null or non-error runs are as they were.
    expect(after.fires).toEqual(before.fires.map(row => (seeded.leakedFires.has(row.id) ? { ...row, error: FIXED } : row)));
    // The leaked routine's last error only: its revision and updated_at stay, and the kept routine is as it was.
    expect(after.routines).toEqual(before.routines.map(row => (row.routine_id === seeded.leakedRoutine ? { ...row, last_error: FIXED } : row)));
    expect(after.routines.find(row => row.routine_id === seeded.keptRoutine)).toMatchObject({ last_status: 'error', last_error: RUN_INTERRUPTED });

    const again = await scrub();
    expect(again).toContain('run-history rows with old error text: 0');
    expect(again).toContain('routines with old error text: 0');
    expect(again).toContain('old rows that look like a host sentence: 0');
  });

  it('a client that is not UTF-8 still keeps the curly-quoted sentences', async () => {
    await seed();
    const before = await snapshot();
    const curly = before.fires.filter(row => row.error !== null && CURLY.includes(row.error));
    expect(curly).toHaveLength(CURLY.length);
    const out = await scrub(['-v', 'apply=1'], { PGCLIENTENCODING: 'LATIN1' });
    const after = await snapshot();
    expect(after.fires.filter(row => curly.some(kept => kept.id === row.id))).toEqual(curly);
    expect(out).toContain('run-history rows rewritten: 5');
  });

  it.each([
    ['a failed run', 'fires', NEW_SENTENCES[0]],
    ['a routine’s last error', 'routines', NEW_SENTENCES[1]],
  ] as const)('stops before writing anything when %s reads like a host sentence it does not know', async (_where, table, text) => {
    await seed();
    if (table === 'fires') await addFire('error', text);
    else await addRoutine('Scrub new sentence', 'error', text);
    const before = await snapshot();

    const dry = await scrub();
    expect(dry).toContain(`run-history rows with old error text: ${table === 'fires' ? 6 : 5}`);
    expect(dry).toContain(`routines with old error text: ${table === 'routines' ? 2 : 1}`);
    expect(dry).toContain('old rows that look like a host sentence: 1');

    const r = await runScrub(['-v', 'apply=1']);
    expect(r.exitCode, r.output).toBe(3); // psql's code for an error under ON_ERROR_STOP
    expect(lines(r.stdout).slice(-2)).toEqual(['old rows that look like a host sentence: 1', STOPPED]);
    expect(r.output).not.toContain('UPDATE');
    expect(r.output).not.toContain('rewritten:');
    expect(await snapshot()).toEqual(before);
    // Counts only, in both modes: neither the new sentence nor any old text is printed.
    for (const out of [dry, r.output]) {
      expect(out).not.toContain(text);
      expect(out).not.toContain('PRIVATE');
    }
  });

  it('counts every shape of our sentences as one it does not know, and none of the leaked samples', async () => {
    await seed();
    for (const text of MORE_SENTENCES) await addFire('error', text);
    const dry = await scrub();
    expect(dry).toContain(`run-history rows with old error text: ${LEAKED.length + MORE_SENTENCES.length}`);
    expect(dry).toContain(`old rows that look like a host sentence: ${MORE_SENTENCES.length}`);
    const before = await snapshot();
    const r = await runScrub(['-v', 'apply=1']);
    expect(r.exitCode, r.output).toBe(3);
    expect(lines(r.stdout).at(-1)).toBe(STOPPED);
    expect(await snapshot()).toEqual(before);
  });

  it('never rewrites a sentence it does not know that lands between the guard and the rewrite', async () => {
    // READ COMMITTED: the counts and each UPDATE read separate snapshots, so a row can change after
    // the guard counted 0. Here a run finishing (finishDispatch's shape: it locks the routine, sets
    // its last error and adds a run) holds the old routine while the scrub's first UPDATE waits on it,
    // and commits a sentence the keep-list doesn't know into both tables.
    const seeded = await seed();
    const finish = new pg.Client({ connectionString: container.getConnectionUri() });
    await finish.connect();
    let run: ReturnType<typeof runScrub> | undefined;
    try {
      await finish.query('BEGIN');
      await finish.query(`UPDATE routines_v1_definitions SET last_error = $1 WHERE routine_id = $2`, [NEW_SENTENCES[1], seeded.leakedRoutine]);
      run = runScrub(['-v', 'apply=1']);
      await expect.poll(scrubsWaitingForALock).toBe(1);
      await finish.query(`INSERT INTO routines_v1_fires (agent_id, routine_id, trigger_source, status, error)
        VALUES ('a', 'r', 'tick', 'error', $1)`, [NEW_SENTENCES[0]]);
      await finish.query('COMMIT');

      const r = await run;
      expect(r.exitCode, r.output).toBe(0);
      // The guard counted 0 before either sentence existed; both UPDATEs still pass them by.
      expect(lines(r.stdout).slice(-6)).toEqual(['old rows that look like a host sentence: 0',
        'UPDATE 0', `UPDATE ${LEAKED.length}`, `run-history rows rewritten: ${LEAKED.length}`, 'routines rewritten: 0', 'COMMIT']);
      const after = await snapshot();
      expect(after.routines.find(row => row.routine_id === seeded.leakedRoutine)?.last_error).toBe(NEW_SENTENCES[1]);
      expect(after.fires.filter(row => row.error === NEW_SENTENCES[0])).toHaveLength(1);
      expect(after.fires.filter(row => seeded.leakedFires.has(row.id)).every(row => row.error === FIXED)).toBe(true);
    } finally {
      await finish.end();
      await run?.catch(() => undefined);
    }
  });

  it('leaves runs and routines that did not fail alone, whatever their error text says', async () => {
    // The fixed sentence says the run failed, so only failed runs are rewritten (TASK-1036 decisions).
    // These rows are not counted, not rewritten, and not held against the guard either.
    const seeded = await seed();
    const okFires = [await addFire('ok', LEAKED[0]!), await addFire('ok', NEW_SENTENCES[0])];
    const okRoutines = [await addRoutine('Scrub ok', 'ok', LEAKED[1]!), await addRoutine('Scrub ok sentence', 'ok', NEW_SENTENCES[1])];
    const before = await snapshot();
    expect(before.fires.filter(row => okFires.includes(row.id)).map(row => [row.status, row.error]))
      .toEqual([['ok', LEAKED[0]], ['ok', NEW_SENTENCES[0]]]);
    expect(before.routines.filter(row => okRoutines.includes(row.routine_id)).map(row => [row.last_status, row.last_error]).sort())
      .toEqual([['ok', LEAKED[1]], ['ok', NEW_SENTENCES[1]]].sort());

    const dry = await scrub();
    expect(dry).toContain('run-history rows with old error text: 5');
    expect(dry).toContain('routines with old error text: 1');
    expect(dry).toContain('old rows that look like a host sentence: 0');

    const out = await scrub(['-v', 'apply=1']);
    expect(out).toContain('run-history rows rewritten: 5');
    expect(out).toContain('routines rewritten: 1');
    const after = await snapshot();
    expect(after.fires).toEqual(before.fires.map(row => (seeded.leakedFires.has(row.id) ? { ...row, error: FIXED } : row)));
    expect(after.routines).toEqual(before.routines.map(row => (row.routine_id === seeded.leakedRoutine ? { ...row, last_error: FIXED } : row)));
  });

  it('waits for an agent purge that holds its routines, instead of deadlocking with it', async () => {
    await seed();
    const otherAgent = await addFire('error', LEAKED[2]!, 'b');
    // purgeAgent (store.ts) locks an agent's routines, then deletes its run history. This is that
    // order, paused while it holds the routines. A scrub that rewrote run history first would hold
    // agent a's old runs by then, so the purge's delete and the scrub would wait on each other.
    const purge = new pg.Client({ connectionString: container.getConnectionUri() });
    await purge.connect();
    let run: ReturnType<typeof runScrub> | undefined;
    try {
      await purge.query('BEGIN');
      await purge.query(`SELECT 1 FROM routines_v1_definitions WHERE agent_id = 'a' FOR UPDATE`);
      run = runScrub(['-v', 'apply=1']);
      await expect.poll(scrubsWaitingForALock).toBe(1);
      await purge.query(`DELETE FROM routines_v1_definitions WHERE agent_id = 'a'`);
      await purge.query(`DELETE FROM routines_v1_fires WHERE agent_id = 'a'`);
      await purge.query('COMMIT');

      const r = await run;
      expect(r.exitCode, r.output).toBe(0);
      // The purged agent's routine and runs are gone; the other agent's old run is rewritten.
      expect(lines(r.stdout).slice(-5)).toEqual(['UPDATE 0', 'UPDATE 1', 'run-history rows rewritten: 1', 'routines rewritten: 0', 'COMMIT']);
      expect(await snapshot()).toEqual({ fires: [{ id: otherAgent, status: 'error', error: FIXED }], routines: [] });
    } finally {
      await purge.end();
      await run?.catch(() => undefined);
    }
  });

  it('gives up on a row that stays locked, writes nothing, and can simply run again', async () => {
    const seeded = await seed();
    const before = await snapshot();
    const holder = new pg.Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    let held = true;
    const release = async () => {
      if (held) { held = false; await holder.query('ROLLBACK'); }
    };
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM routines_v1_fires WHERE id = $1 FOR UPDATE', [[...seeded.leakedFires][0]]);
      // With no lock_timeout the scrub waits as long as the holder does; let go after 15s so this ends.
      const letGo = setTimeout(() => { void release(); }, 15_000);
      const r = await runScrub(['-v', 'apply=1']);
      clearTimeout(letGo);
      expect(r.exitCode, r.output).toBe(3);
      expect(r.stderr).toContain('canceling statement due to lock timeout');
      // The routines UPDATE ran first (its tag printed), then run history's waited on the held row.
      expect(lines(r.stdout).slice(-2)).toEqual(['old rows that look like a host sentence: 0', 'UPDATE 1']);
      expect(r.output).not.toContain('rewritten:');
      expect(r.output).not.toContain('PRIVATE');
      await release();
      // The routine's rewrite ran first, and it was rolled back with the rest.
      expect(await snapshot()).toEqual(before);

      const again = await scrub(['-v', 'apply=1']);
      expect(again).toContain('run-history rows rewritten: 5');
      expect(again).toContain('routines rewritten: 1');
    } finally {
      await release();
      await holder.end();
    }
  });
});

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
async function scrub(flags: string[] = [], env: Record<string, string> = {}): Promise<string> {
  await container.copyContentToContainer([{ content: SCRUB, target: '/tmp/scrub.sql' }]);
  const r = await container.exec(['psql', '-X', '-v', 'ON_ERROR_STOP=1', ...flags, '-U', container.getUsername(),
    '-d', container.getDatabase(), '-f', '/tmp/scrub.sql'], { env });
  expect(r.exitCode, r.output).toBe(0);
  return r.stdout;
}

/**
 * One failed run per KEPT and per LEAKED text (LEAKED[0]'s from a webhook), three runs that
 * must never be touched, and two routines whose last run failed: one with old text, one with
 * RUN_INTERRUPTED.
 */
async function seed(): Promise<{ leakedFires: Set<string>; leakedRoutine: string; keptRoutine: string }> {
  const fires: Array<{ status: 'ok' | 'silenced' | 'error'; error: string | null; source: 'tick' | 'webhook'; leaked?: true }> = [
    ...KEPT.map(error => ({ status: 'error' as const, error, source: 'tick' as const })),
    ...LEAKED.map((error, i) => ({ status: 'error' as const, error, source: i === 0 ? 'webhook' as const : 'tick' as const, leaked: true as const })),
    { status: 'ok', error: null, source: 'tick' },
    { status: 'silenced', error: null, source: 'tick' },
    { status: 'error', error: null, source: 'tick' },
  ];
  const leakedFires = new Set<string>();
  for (const fire of fires) {
    const inserted = await sql<{ id: string }>`INSERT INTO routines_v1_fires (agent_id, routine_id, trigger_source, status, error)
      VALUES ('a', 'r', ${fire.source}, ${fire.status}, ${fire.error}) RETURNING id`.execute(db);
    if (fire.leaked) leakedFires.add(inserted.rows[0]!.id);
  }
  const store = createRoutinesStore(db);
  const leaked = await store.createAuthored({ ...createInput('scrub-leaked'), definition: { ...createInput().definition, name: 'Scrub leaked' } });
  const kept = await store.createAuthored({ ...createInput('scrub-kept'), definition: { ...createInput().definition, name: 'Scrub kept' } });
  await sql`UPDATE routines_v1_definitions SET last_status='error', last_error=${LEAKED[0]}
    WHERE agent_id=${leaked.agentId} AND routine_id=${leaked.routineId}`.execute(db);
  await sql`UPDATE routines_v1_definitions SET last_status='error', last_error=${RUN_INTERRUPTED}
    WHERE agent_id=${kept.agentId} AND routine_id=${kept.routineId}`.execute(db);
  return { leakedFires, leakedRoutine: leaked.routineId, keptRoutine: kept.routineId };
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

describe('scrub-leaked-run-errors.sql (TASK-1036)', () => {
  it.each<[string[]]>([[[]], [['-v', 'apply=0']]])('a dry run (%j) counts the old rows and changes nothing', async flags => {
    await seed();
    const before = await snapshot();
    const out = await scrub(flags);
    expect(out).toContain('run-history rows with old error text: 5');
    expect(out).toContain('routines with old error text: 1');
    expect(out).toContain('Dry run: nothing was changed.');
    expect(out).not.toContain('rewritten:');
    expect(await snapshot()).toEqual(before);
    expect(out).not.toContain('PRIVATE');
  });

  it('apply rewrites only the old rows, and a dry run afterwards finds none', async () => {
    const seeded = await seed();
    const before = await snapshot();
    expect(before.fires).toHaveLength(KEPT.length + LEAKED.length + 3);
    expect(seeded.leakedFires.size).toBe(LEAKED.length);
    const out = await scrub(['-v', 'apply=1']);
    expect(out).toContain('run-history rows rewritten: 5');
    expect(out).toContain('routines rewritten: 1');
    expect(out).not.toContain('Dry run');
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
});

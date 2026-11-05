import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, defaultDefinition, now } from './store-fixture.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';

// TASK-913: a stored routine row today's contract refuses (saved under older
// rules, or by a later version before a rollback) is skipped by every reader
// that handles many rows at once, and said so in ids and codes, so it can't sink
// the batch it sits in.
const f = fixture();
afterEach(() => { vi.restoreAllMocks(); });
const task = (requestId: string) => ({ ...createInput(requestId), definition: RoutineDefinitionSchema.parse({
  name: 'Inbox', promptBody: 'Keep the inbox under control.', trigger: { kind: 'interval', every: '15m' }, kind: 'stay-on-top', goodWhen: 'Nothing waits more than a day.' }) });
/** The card's way in: code from before TASK-906 set a task to check in every 5 minutes. */
const underTheFloor = (routineId: string) => sql`UPDATE routines_v1_definitions SET schedule_spec = ${JSON.stringify({ kind: 'interval', every: '5m' })}::jsonb WHERE routine_id = ${routineId}`.execute(f.db);
const columns = async (routineId: string) => (await sql<{ next_run_at: Date | null; last_run_at: Date | null }>`SELECT next_run_at, last_run_at FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0]!;
const skippedLines = () => captureExpectedStderr(m => m.startsWith('[ax/routines] routine ')).messages;
const claim = (at: Date, limit = 10) => f.store.claimDue({ now: at, limit, claimWindowMinutes: 5 });
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

describe('the tick and a run’s finish beside a row that no longer reads (TASK-913)', () => {
  it("claimDue hands over every due row that reads and skips the one that doesn't, in one line of ids and codes", async () => {
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const broken = await f.store.createAuthored(task('task'));
    await underTheFloor(broken.routineId);
    const lines = skippedLines();
    expect((await claim(minutes(60))).map(row => row.routineId)).toEqual([repeat.routineId]);
    expect(lines).toEqual([`[ax/routines] routine a/${broken.routineId} no longer reads (schedule.every: custom), so the tick skipped it\n`]);
    // The one that reads keeps the claim's own push, from its stored time; the skipped one is pushed from now.
    expect((await columns(repeat.routineId)).next_run_at).toEqual(new Date(repeat.nextRunAt!.getTime() + 5 * 60_000));
    expect((await columns(broken.routineId)).next_run_at).toEqual(minutes(65));
  });

  it('claimDue tries a skipped routine again a claim window from now, not from its stored time, and fires it once it reads', async () => {
    const broken = await f.store.createAuthored(task('task'));
    await underTheFloor(broken.routineId);
    // A host that was down for three days.
    await sql`UPDATE routines_v1_definitions SET next_run_at = ${minutes(-3 * 24 * 60)} WHERE routine_id = ${broken.routineId}`.execute(f.db);
    const lines = skippedLines();
    expect(await claim(now)).toEqual([]);
    expect(await claim(new Date(now.getTime() + 5_000))).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(await claim(minutes(5))).toEqual([]);
    expect(lines).toHaveLength(2);
    // Once it reads again (a roll forward, a repair), the next claim hands it over.
    await sql`UPDATE routines_v1_definitions SET schedule_spec = ${JSON.stringify({ kind: 'interval', every: '15m' })}::jsonb WHERE routine_id = ${broken.routineId}`.execute(f.db);
    expect((await claim(minutes(10))).map(row => row.routineId)).toEqual([broken.routineId]);
    expect(lines).toHaveLength(2);
  });

  it('a claim batch filled with rows that no longer read holds back a readable routine only until each has been skipped once', async () => {
    const broken = await f.store.createAuthored(task('task'));
    await underTheFloor(broken.routineId);
    await sql`UPDATE routines_v1_definitions SET next_run_at = ${minutes(-24 * 60)} WHERE routine_id = ${broken.routineId}`.execute(f.db);
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const lines = skippedLines();
    // The most overdue is claimed first, so a batch of one holds only the row that doesn't read.
    expect(await claim(minutes(2), 1)).toEqual([]);
    expect((await claim(new Date(minutes(2).getTime() + 5_000), 1)).map(row => row.routineId)).toEqual([repeat.routineId]);
    expect(lines).toHaveLength(1);
  });

  it("claimDue moves a skipped default routine's last run to now, so it waits out its interval instead of coming back every tick", async () => {
    await f.store.upsertDefault(defaultDefinition());
    await f.store.materializeMissing({ agents: [{ agentId: 'a', ownerUserId: 'owner' }], now });
    const copy = (await f.store.list({ agentId: 'a' })).find(row => row.definitionId !== null && row.name === 'Check in')!;
    // A name a later rule refuses: what a stricter contract does to a routine saved before it.
    await sql`UPDATE routines_v1_definitions SET name = ${'x'.repeat(129)} WHERE routine_id = ${copy.routineId}`.execute(f.db);
    const lines = skippedLines();
    const at = new Date(now.getTime() + 61_000);
    // Other seeded defaults may be claimed beside it: only the copy is this test's.
    expect((await claim(at)).map(row => row.routineId)).not.toContain(copy.routineId);
    expect(lines).toEqual([`[ax/routines] routine a/${copy.routineId} no longer reads (name: too_big), so the tick skipped it\n`]);
    // A default's due time is its last run plus its interval, and its next run stays NULL (routines_v1_default_next_run_at_chk).
    expect(await columns(copy.routineId)).toEqual({ next_run_at: null, last_run_at: at });
    expect((await claim(new Date(at.getTime() + 5_000))).map(row => row.routineId)).not.toContain(copy.routineId);
    expect(lines).toHaveLength(1);
  });
});

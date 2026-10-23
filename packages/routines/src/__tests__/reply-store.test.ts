import { describe, it, expect } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { RoutineDefinitionSchema, type RoutineUpdateInput } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import type { RoutinesDatabase } from '../migrations.js';

// TASK-931: a person's replies on a task. Only the task's owner may add one,
// decided under the agent fence and the routine's row lock. The same requestId
// again keeps the first reply. A read returns only the replies the routine's
// owner now wrote, and only to them. Replies outlive a kind change and an owner
// change, and go with their routine or agent. addReply refuses anyone but the
// owner, so another person's reply is written with SQL, and what's stored is
// read back with SQL too.
const f = fixture();

const at = (ms: number) => new Date(now.getTime() + ms);
const TASK = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
type Key = { agentId: string; routineId: string };
type Revisioned = Key & { revision: string };
/** A task 'owner' owns ('editor' made it). Each create needs its own request id: createInput's default would replay. */
const createTask = (requestId: string, agentId = 'a') => f.store.createAuthored({ ...createInput(requestId), agentId, definition: TASK });
// Async, so even a missing method rejects rather than throws: a race test must reach its `finally`.
const reply = async (key: Key, requestId: string, text: string, over: { actorUserId?: string; now?: Date } = {}) => f.store.addReply({
  agentId: key.agentId, routineId: key.routineId, actorUserId: over.actorUserId ?? 'owner', requestId, text, now: over.now ?? now,
});
/** addReply's answer when it stored or found a reply; a refusal fails the test. */
const replied = async (...args: Parameters<typeof reply>) => {
  const result = await reply(...args);
  if (typeof result === 'string') throw new Error(`addReply answered ${result}`);
  return result;
};
/** What a read of the task's replies gets, for `as` (the owner unless named). */
const recent = (key: Key, { limit = 20, as = 'owner' }: { limit?: number; as?: string } = {}) =>
  f.store.recentReplies({ agentId: key.agentId, routineId: key.routineId, actorUserId: as, limit });
/** Drift repair's move of every routine of agent 'a' to `ownerUserId`, as resolveRoutineAccess and the tick run it. */
const moveTo = (ownerUserId: string) => f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId }] });
const storedReplies = async () => (await sql<{ agent_id: string; routine_id: string; author_user_id: string; request_id: string; body: string }>`
  SELECT agent_id, routine_id, author_user_id, request_id, body FROM routines_v1_replies ORDER BY created_at, reply_id`.execute(f.db)).rows;
/** A reply written straight to the table, as addReply never would: another person's, or at an id the test picks. */
const insertReply = (r: { replyId: string; routineId: string; author?: string; requestId?: string; body?: string; at?: Date }) => sql`
  INSERT INTO routines_v1_replies (reply_id, agent_id, routine_id, author_user_id, request_id, body, created_at)
  VALUES (${r.replyId}, 'a', ${r.routineId}, ${r.author ?? 'owner'}, ${r.requestId ?? r.replyId}, ${r.body ?? 'A reply.'}, ${r.at ?? now})`.execute(f.db);
const update = (row: Revisioned, requestId: string, patch: RoutineUpdateInput['patch']) => f.store.updateAuthored({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', requestId, patch, now: at(1000), stopOnly: false,
});
const deleteTask = (row: Revisioned) => f.store.deleteAuthored({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: `delete-${row.routineId}`, actorUserId: 'owner', now,
});
/** The routine's row, read under its lock: what deleteAuthored and addReply each hold until they commit. */
const lockRow = (trx: Transaction<RoutinesDatabase>, key: Key) => trx.selectFrom('routines_v1_definitions').select('routine_id')
  .where('agent_id', '=', key.agentId).where('routine_id', '=', key.routineId).forUpdate().execute();
/** Backends waiting on a lock in a statement on routines' definitions table. */
const waitingOnRoutineRow = async () => Number((await sql<{ n: string }>`
  SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%routines_v1_definitions%'`.execute(f.db)).rows[0]!.n);
type Step = (trx: Transaction<RoutinesDatabase>) => Promise<unknown>;
/** Runs `before` in a transaction that then stays open, holding its locks, until `release()`; then runs `after` and commits. */
async function openTransaction(before: Step, after: Step = async () => {}) {
  let release!: () => void; let began!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { began = resolve; });
  const done = f.db.transaction().execute(async trx => { await before(trx); began(); await hold; await after(trx); });
  await Promise.race([ready, done]);
  return { release, done };
}

describe('replies (store, TASK-931)', () => {
  it('the owner adds a reply, and replies read back newest first', async () => {
    const task = await createTask('task');
    const first = await replied(task, 'r1', 'First.');
    expect(first).toEqual({
      outcome: 'added', replyId: expect.stringMatching(/^reply_/),
      row: expect.objectContaining({ routineId: task.routineId, revision: task.revision, kind: 'stay-on-top', ownerUserId: 'owner', enabled: true }),
    });
    const second = await replied(task, 'r2', 'Second.\n\nOn two lines.', { now: at(60_000) });
    expect(await recent(task)).toEqual([
      { replyId: second.replyId, authorUserId: 'owner', text: 'Second.\n\nOn two lines.', sentAt: at(60_000) },
      { replyId: first.replyId, authorUserId: 'owner', text: 'First.', sentAt: now },
    ]);
  });

  it('replies sent in the same instant read back in one order, by reply id', async () => {
    const task = await createTask('task');
    // Neither the order written nor its reverse.
    for (const replyId of ['reply_b', 'reply_c', 'reply_a']) await insertReply({ replyId, routineId: task.routineId });
    expect((await recent(task)).map(r => r.replyId)).toEqual(['reply_c', 'reply_b', 'reply_a']);
  });

  it('a retry with the same requestId answers replayed with the first id and keeps the first text', async () => {
    const task = await createTask('task');
    const first = await replied(task, 'r1', 'First.');
    expect(await reply(task, 'r1', 'Changed.', { now: at(5000) })).toEqual({
      outcome: 'replayed', replyId: first.replyId, row: expect.objectContaining({ routineId: task.routineId, revision: task.revision }),
    });
    // A replay answers with the routine as it is now: paused, at its new revision.
    const paused = await update(task, 'pause', { enabled: false });
    expect(await reply(task, 'r1', 'First.')).toEqual({
      outcome: 'replayed', replyId: first.replyId, row: expect.objectContaining({ revision: paused.revision, enabled: false }),
    });
    // A paused task still takes new replies.
    expect(await reply(task, 'r2', 'While paused.', { now: at(2000) })).toMatchObject({ outcome: 'added', row: { enabled: false } });
    expect((await storedReplies()).map(r => [r.request_id, r.body])).toEqual([['r1', 'First.'], ['r2', 'While paused.']]);
  });

  it('the same requestId on another task, or from another person, is another reply', async () => {
    const task = await createTask('task');
    const other = await createTask('other');
    // Another person's reply under the same requestId (an earlier owner's, say). It comes first in every
    // order a read-back could take (written first, the newest, its author sorts first), so a read-back
    // that ignored the author would find it.
    await insertReply({ replyId: 'reply_theirs', routineId: task.routineId, author: 'earlier-owner', requestId: 'same', body: 'Theirs.', at: at(60_000) });
    const mine = await replied(task, 'same', 'Mine.');
    expect(mine.outcome).toBe('added');
    expect(mine.replyId).not.toBe('reply_theirs');
    expect(await reply(task, 'same', 'Mine.')).toMatchObject({ outcome: 'replayed', replyId: mine.replyId });
    const onOther = await replied(other, 'same', 'On the other task.');
    expect(onOther.outcome).toBe('added');
    // Both stand under the one requestId, each its own reply. A read returns only the owner's own (the next test).
    expect((await storedReplies()).filter(r => r.routine_id === task.routineId).map(r => [r.author_user_id, r.request_id, r.body]))
      .toEqual([['owner', 'same', 'Mine.'], ['earlier-owner', 'same', 'Theirs.']]);
    expect(await recent(task)).toEqual([{ replyId: mine.replyId, authorUserId: 'owner', text: 'Mine.', sentAt: now }]);
    expect(await recent(other)).toEqual([{ replyId: onOther.replyId, authorUserId: 'owner', text: 'On the other task.', sentAt: now }]);
  });

  it("a read returns only replies the routine's owner now wrote, and only to them; another person's stay stored, unread", async () => {
    const task = await createTask('task');
    const mine = await replied(task, 'r1', 'Mine.');
    // Another person's, written while the task was theirs (it moved to them and back, say). The newest of
    // all, so a read that dropped it only after taking its limit would come back short.
    await insertReply({ replyId: 'reply_theirs', routineId: task.routineId, author: 'earlier-owner', body: 'Theirs.', at: at(60_000) });
    expect(await recent(task)).toEqual([{ replyId: mine.replyId, authorUserId: 'owner', text: 'Mine.', sentAt: now }]);
    expect(await recent(task, { limit: 1 })).toEqual([{ replyId: mine.replyId, authorUserId: 'owner', text: 'Mine.', sentAt: now }]);
    // Read for anyone but the owner, there are none: not the owner's, and not their own.
    for (const as of ['earlier-owner', 'someone-else']) expect(await recent(task, { as }), as).toEqual([]);
    expect(await storedReplies()).toHaveLength(2);
  });

  it('a task moved to a new owner reads none of the earlier owner’s replies, theirs only once they write some, and the earlier ones again only if it moves back', async () => {
    const task = await createTask('task');
    const first = await replied(task, 'r1', 'From the first owner.');
    expect(await moveTo('new-owner')).toBe(1);
    // Neither person reads the first owner's reply now: one no longer owns the task, the other didn't write it.
    expect(await recent(task, { as: 'new-owner' })).toEqual([]);
    expect(await recent(task)).toEqual([]);
    const theirs = await replied(task, 'r2', 'From the new owner.', { actorUserId: 'new-owner', now: at(60_000) });
    const fromNewOwner = { replyId: theirs.replyId, authorUserId: 'new-owner', text: 'From the new owner.', sentAt: at(60_000) };
    expect(await recent(task, { as: 'new-owner' })).toEqual([fromNewOwner]);
    expect(await recent(task)).toEqual([]);
    // Nothing was deleted, and the first owner's reply reads again only once the task is theirs again.
    expect((await storedReplies()).map(r => [r.author_user_id, r.body])).toEqual([['owner', 'From the first owner.'], ['new-owner', 'From the new owner.']]);
    expect(await moveTo('owner')).toBe(1);
    expect(await recent(task)).toEqual([{ replyId: first.replyId, authorUserId: 'owner', text: 'From the first owner.', sentAt: now }]);
    expect(await recent(task, { as: 'new-owner' })).toEqual([]);
  });

  it('anyone but the owner is forbidden, and nothing is stored', async () => {
    const task = await createTask('task');
    expect(await reply(task, 'r1', 'Hello.', { actorUserId: 'editor' })).toBe('forbidden');
    expect(await reply(task, 'r2', 'Hello.', { actorUserId: 'someone-else' })).toBe('forbidden');
    expect(await storedReplies()).toEqual([]);
  });

  it('a repeat routine, a missing routine and a retired agent are not-found, and nothing is stored', async () => {
    const repeat = await f.store.createAuthored(createInput('repeat'));
    expect(await reply(repeat, 'r1', 'Hello.')).toBe('not-found');
    // The kind is decided before the owner.
    expect(await reply(repeat, 'r2', 'Hello.', { actorUserId: 'someone-else' })).toBe('not-found');
    expect(await reply({ agentId: 'a', routineId: 'rtn_missing' }, 'r3', 'Hello.')).toBe('not-found');
    const task = await createTask('task');
    // The agent fence alone: the agent is retired, though the task's row is still there.
    await sql`INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.execute(f.db);
    expect(await f.store.findOne(task)).toMatchObject({ routineId: task.routineId });
    expect(await reply(task, 'r4', 'Hello.')).toBe('not-found');
    expect(await storedReplies()).toEqual([]);
  });

  it('recentReplies clamps its limit to 1-50 and reads one routine only', async () => {
    const task = await createTask('task');
    const other = await createTask('other');
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push((await replied(task, `r${i}`, `Reply ${i}.`, { now: at(i * 1000) })).replyId);
    // The newest reply of all is on the other task, so a read that ignored the routine would lead with it.
    await replied(other, 'r-other', 'Elsewhere.', { now: at(3_600_000) });
    const newestFirst = [...ids].reverse();
    const read = async (limit: number) => (await recent(task, { limit })).map(r => r.replyId);
    expect(await read(0)).toEqual(newestFirst.slice(0, 1));
    expect(await read(51)).toEqual(newestFirst.slice(0, 50));
    expect(await read(3)).toEqual(newestFirst.slice(0, 3));
  });

  it("purgeAgent removes that agent's replies only", async () => {
    const onA = await createTask('task-a');
    const onB = await createTask('task-b', 'b');
    await replied(onA, 'r1', 'On a.');
    await replied(onB, 'r1', 'On b.');
    await f.store.purgeAgent('a');
    expect((await storedReplies()).map(r => [r.agent_id, r.body])).toEqual([['b', 'On b.']]);
    expect((await recent(onB)).map(r => r.text)).toEqual(['On b.']);
  });

  it("deleteAuthored removes that routine's replies only", async () => {
    const kept = await createTask('kept');
    const dropped = await createTask('dropped');
    await replied(kept, 'r1', 'Kept.');
    await replied(dropped, 'r1', 'Dropped.');
    expect(await deleteTask(dropped)).toEqual({ deleted: true, cleanupPending: false });
    expect((await storedReplies()).map(r => [r.routine_id, r.body])).toEqual([[kept.routineId, 'Kept.']]);
  });

  it('replies survive a change of kind', async () => {
    const task = await createTask('task');
    const sent = await replied(task, 'r1', 'Keep going.');
    const kept = [{ replyId: sent.replyId, authorUserId: 'owner', text: 'Keep going.', sentAt: now }];
    const repeat = await update(task, 'to-repeat', { kind: 'repeat', goodWhen: null });
    expect(repeat.kind).toBe('repeat');
    expect(await recent(task)).toEqual(kept);
    const back = await update(repeat, 'to-task', { kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.' });
    expect(back.kind).toBe('stay-on-top');
    expect(await recent(task)).toEqual(kept);
  });

  it('a reply racing a delete stores nothing', async () => {
    const task = await createTask('task');
    // The delete holds the routine's row lock until it commits, as deleteAuthored does from lockRoutine on.
    const deleting = await openTransaction(trx => lockRow(trx, task),
      trx => trx.deleteFrom('routines_v1_definitions').where('agent_id', '=', 'a').where('routine_id', '=', task.routineId).execute());
    const racing = reply(task, 'r1', 'Are you still on this?');
    racing.catch(() => {}); // awaited below, after the delete is let go
    try {
      // addReply really waits on the row. Without this the delete could commit before addReply reads the
      // row, and an addReply that never locks it would pass too.
      await expect.poll(waitingOnRoutineRow, { timeout: 15_000 }).toBe(1);
    } finally {
      deleting.release();
      await deleting.done;
    }
    expect(await racing).toBe('not-found');
    expect(await storedReplies()).toEqual([]);
  });

  it('a reply that lands while a delete waits goes with its routine', async () => {
    const task = await createTask('task');
    // addReply's own transaction, held open after its write: the routine's row lock, then the reply.
    const replying = await openTransaction(async trx => {
      await lockRow(trx, task);
      await trx.insertInto('routines_v1_replies').values({
        reply_id: 'reply_late', agent_id: 'a', routine_id: task.routineId, author_user_id: 'owner', request_id: 'r1', body: 'Late.', created_at: now,
      }).execute();
    });
    const deleting = deleteTask(task);
    deleting.catch(() => {}); // awaited below, after the reply is let go
    try {
      // The delete waits on the routine's row, so it reads the routine's replies only once this one is in.
      await expect.poll(waitingOnRoutineRow, { timeout: 15_000 }).toBe(1);
    } finally {
      replying.release();
      await replying.done;
    }
    expect(await deleting).toEqual({ deleted: true, cleanupPending: false });
    expect(await storedReplies()).toEqual([]);
  });
});

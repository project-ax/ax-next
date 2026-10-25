import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { HookBus, makeAgentContext, PluginError, SafeToolError, type AgentContext } from '@ax/core';
import { RoutineDefinitionSchema, TASK_AUTO_PAUSE_AFTER_MISSES, type RoutineRecentRepliesOutput, type RoutineReplyOutput } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { logged } from './support/report-log.js';
import { registerRoutineServices, REPLY_CHECK_IN_RESTARTS } from '../services.js';
import type { RoutinesStore } from '../store.js';
import type { AcceptedDispatch, StoredRoutine } from '../types.js';

// TASK-931: `routines:reply` and `routines:recent-replies`, over routines' real
// store and Postgres. Only a task's owner may reply. The reply is stored first.
// Then, when the task runs and the caller may start its check-ins, it starts one,
// keyed on the reply: a retry starts no second one while the first runs or once it
// ended on its own, and a retry after a partial failure starts the one the first
// try never did. TASK-937: a retry after a host restart cut the check-in off
// before it reported starts one more. Only the owner reads them back, and only
// the ones they wrote: an earlier owner's stay unread.
const f = fixture();

const TASK = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
type Key = { agentId: string; routineId: string };
type Revisioned = Key & { revision: string };
const at = (ms: number) => new Date(now.getTime() + ms);
const keyOf = (row: Key): Key => ({ agentId: row.agentId, routineId: row.routineId });
/** A task 'owner' owns ('editor' made it). Each create needs its own request id: createInput's default would replay. */
const createTask = (requestId = 'task') => f.store.createAuthored({ ...createInput(requestId), definition: TASK });
const pause = (row: Revisioned) => f.store.updateAuthored({
  ...keyOf(row), expectedRevision: row.revision, actorUserId: 'owner', requestId: `pause-${row.routineId}`, patch: { enabled: false }, now, stopOnly: false,
});
const replyTo = (row: Key, requestId: string, text: string) => ({ ...keyOf(row), requestId, text });
/** A reply stored straight through the store, at a time the test picks. */
const added = async (row: Key, requestId: string, text: string, sentAt = now) => {
  const result = await f.store.addReply({ ...keyOf(row), actorUserId: 'owner', requestId, text, now: sentAt });
  if (typeof result === 'string') throw new Error(`addReply answered ${result}`);
  return result;
};
/** A reply written with SQL, as addReply never would: an earlier owner's, or one whose routine is gone. */
const insertReply = (r: { replyId: string; routineId: string; author: string; body: string; sentAt: Date }) => sql`
  INSERT INTO routines_v1_replies (reply_id, agent_id, routine_id, author_user_id, request_id, body, created_at)
  VALUES (${r.replyId}, 'a', ${r.routineId}, ${r.author}, ${r.replyId}, ${r.body}, ${r.sentAt})`.execute(f.db);
const storedReplies = async () => (await sql<{ reply_id: string; routine_id: string; author_user_id: string; request_id: string; body: string }>`
  SELECT reply_id, routine_id, author_user_id, request_id, body FROM routines_v1_replies ORDER BY created_at, reply_id`.execute(f.db)).rows;
/** Every accepted check-in's receipt: who started it, under which request id. */
const dispatchReceipts = async () => (await sql<{ owner_user_id: string; request_id: string }>`
  SELECT owner_user_id, request_id FROM routines_v1_requests WHERE operation = 'dispatch' ORDER BY request_id`.execute(f.db)).rows;

/**
 * The two hooks on a bus whose agents:resolve refuses anyone outside `reach`, over
 * the real store with `store`'s methods swapped in. `dispatched` holds each
 * check-in a reply started; `order` records agents:resolve and each reply write
 * and read, as they run.
 */
function services({ reach = ['owner', 'editor', 'teammate'], allowed = true, store: swapped = {}, dispatch = true, admitDispatch }: {
  reach?: readonly string[]; allowed?: boolean; store?: Partial<RoutinesStore>; dispatch?: boolean;
  admitDispatch?: <T>(effect: () => Promise<T>) => Promise<T>;
} = {}) {
  const order: string[] = [];
  const dispatched: AcceptedDispatch[] = [];
  const bus = new HookBus();
  bus.registerService<{ agentId: string; userId: string }, unknown>('agents:resolve', 'test', async (_ctx, input) => {
    order.push('agents:resolve');
    if (!reach.includes(input.userId)) throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'not yours' });
    // A team agent: a personal one would make reconcileOwners rewrite every routine's owner.
    return { agent: { id: 'a', ownerType: 'team', ownerId: 'team-1' } };
  });
  bus.registerService('agents:can-manage-routines', 'test', async () => ({ allowed }));
  const store = f.store;
  registerRoutineServices({
    bus, now: () => now,
    store: {
      ...store,
      async addReply(input) { order.push('addReply'); return store.addReply(input); },
      async recentReplies(input) { order.push('recentReplies'); return store.recentReplies(input); },
      ...swapped,
    },
    ...(dispatch ? { dispatch: async (accepted: AcceptedDispatch) => { dispatched.push(accepted); return { status: 'ok' as const }; } } : {}),
    ...(admitDispatch === undefined ? {} : { admitDispatch }),
  });
  // Each context keeps its own log lines, so a run prints none.
  const as = (userId: string) => logged(makeAgentContext({ userId, agentId: 'a', sessionId: 's' })).ctx;
  const reply = (input: unknown, ctx: AgentContext = as('owner')) => bus.call<unknown, RoutineReplyOutput>('routines:reply', ctx, input);
  const recent = (input: unknown, userId = 'owner') => bus.call<unknown, RoutineRecentRepliesOutput>('routines:recent-replies', as(userId), input);
  return { order, dispatched, reply, recent, as };
}
const STARTED_ID = expect.stringMatching(/^reply_/);

describe('routines:reply (TASK-931)', () => {
  it('a reply on a running task is stored and starts one manual check-in, keyed on the reply', async () => {
    const task = await createTask();
    const s = services();
    const out = await s.reply(replyTo(task, 'q1', 'Refunds under $100 are fine.'));
    expect(out).toStrictEqual({ replyId: STARTED_ID, checkIn: 'started' });
    expect(s.order).toEqual(['agents:resolve', 'addReply']);
    expect(await storedReplies()).toEqual([
      { reply_id: out.replyId, routine_id: task.routineId, author_user_id: 'owner', request_id: 'q1', body: 'Refunds under $100 are fine.' },
    ]);
    expect(s.dispatched).toEqual([expect.objectContaining({
      source: 'manual', row: expect.objectContaining({ agentId: 'a', routineId: task.routineId, revision: task.revision }),
    })]);
    // Keyed on the reply, not on the caller's requestId, so it never shares a receipt with a Check now press.
    expect(await dispatchReceipts()).toEqual([{ owner_user_id: 'owner', request_id: `reply:${out.replyId}` }]);
  });

  it('a retry with the same requestId answers replayed with the same id and starts nothing more', async () => {
    const task = await createTask();
    const s = services();
    const first = await s.reply(replyTo(task, 'q1', 'First.'));
    expect(first.checkIn).toBe('started');
    expect(await s.reply(replyTo(task, 'q1', 'First.'))).toStrictEqual({ replyId: first.replyId, checkIn: 'replayed' });
    expect(s.dispatched).toHaveLength(1);
    expect(await storedReplies()).toHaveLength(1);
  });

  it('a retry after the first try stored the reply but never started its check-in starts it, once', async () => {
    const task = await createTask();
    const real = f.store;
    let failures = 1;
    const s = services({ store: {
      async acceptDispatch(input) {
        if (failures-- > 0) throw new Error('connection reset');
        return real.acceptDispatch(input);
      },
    } });
    const input = replyTo(task, 'q1', 'Are the refunds still stuck?');
    await expect(s.reply(input)).rejects.toMatchObject({ message: expect.stringContaining('connection reset') });
    const [stored] = await storedReplies();
    expect(stored).toMatchObject({ request_id: 'q1', body: 'Are the refunds still stuck?' });
    expect(s.dispatched).toEqual([]);
    // The retry finds the stored reply and starts the check-in the first try never did.
    expect(await s.reply(input)).toStrictEqual({ replyId: stored!.reply_id, checkIn: 'started' });
    expect(s.dispatched).toHaveLength(1);
    expect(await s.reply(input)).toStrictEqual({ replyId: stored!.reply_id, checkIn: 'replayed' });
    expect(s.dispatched).toHaveLength(1);
    expect(await storedReplies()).toHaveLength(1);
  });

  it('a retry after the task changed answers replayed and starts no second check-in', async () => {
    const task = await createTask();
    const s = services();
    const first = await s.reply(replyTo(task, 'q1', 'First.'));
    expect(first.checkIn).toBe('started');
    const edited = await f.store.updateAuthored({
      ...keyOf(task), expectedRevision: task.revision, actorUserId: 'owner', requestId: 'edit', patch: { goodWhen: 'Nothing waits a day.' }, now, stopOnly: false,
    });
    expect(edited.revision).not.toBe(task.revision);
    // The retry's walk finds the check-in's receipt, taken at the old revision, and answers before any accept.
    expect(await s.reply(replyTo(task, 'q1', 'First.'))).toStrictEqual({ replyId: first.replyId, checkIn: 'replayed' });
    expect(s.dispatched).toHaveLength(1);
    expect(await dispatchReceipts()).toHaveLength(1);
  });

  it('a paused task stores the reply and starts nothing', async () => {
    const task = await pause(await createTask());
    const s = services();
    expect(await s.reply(replyTo(task, 'q1', 'When you resume, start with refunds.'))).toStrictEqual({ replyId: STARTED_ID, checkIn: 'paused' });
    expect(s.dispatched).toEqual([]);
    expect(await dispatchReceipts()).toEqual([]);
    expect((await s.recent(keyOf(task))).replies.map(r => r.text)).toEqual(['When you resume, start with refunds.']);
  });

  it("an owner who can't manage the agent's tasks gets not-allowed, paused or not", async () => {
    const running = await createTask('running');
    const paused = await pause(await createTask('paused'));
    const s = services({ allowed: false });
    // Never `paused`: that promises a resume they can't make.
    for (const row of [running, paused]) {
      expect(await s.reply(replyTo(row, 'q1', 'Hello.')), row.routineId).toStrictEqual({ replyId: STARTED_ID, checkIn: 'not-allowed' });
    }
    expect(s.dispatched).toEqual([]);
    expect(await dispatchReceipts()).toEqual([]);
    expect(await storedReplies()).toHaveLength(2);
  });

  it('the routine changing between the reply and its check-in: gone, paused, moved to another owner, or edited', async () => {
    const task = await createTask();
    const row = (await f.store.findOne(keyOf(task)))!;
    // Each is how the check-in's accept finds the routine, then how it reads again.
    const later: StoredRoutine = { ...row, revision: 'rev_later' };
    const cases: Array<[label: string, fresh: StoredRoutine | null, answer: { checkIn: string } | { toolCode: string; field?: string }]> = [
      ['deleted', null, { toolCode: 'not-found', field: 'routineId' }],
      ['paused', { ...later, enabled: false }, { checkIn: 'paused' }],
      // Nobody but the new owner may start its check-ins now, paused or not.
      ['moved', { ...later, ownerUserId: 'new-owner' }, { checkIn: 'not-allowed' }],
      ['moved and paused', { ...later, ownerUserId: 'new-owner', enabled: false }, { checkIn: 'not-allowed' }],
      // Still running at a new revision: the reply is stored, and a resend starts its check-in.
      ['edited', later, { toolCode: 'unavailable' }],
    ];
    let n = 0;
    for (const [label, fresh, answer] of cases) {
      const s = services({ store: { acceptDispatch: async () => null, findOne: async () => fresh } });
      const sent = s.reply(replyTo(task, `q${++n}`, `While ${label}.`));
      if ('checkIn' in answer) expect(await sent, label).toStrictEqual({ replyId: STARTED_ID, checkIn: answer.checkIn });
      else await expect(sent, label).rejects.toMatchObject(answer);
      expect(s.dispatched, label).toEqual([]);
    }
    // The reply is stored whatever its check-in did.
    expect((await storedReplies()).map(r => r.body).sort()).toEqual(cases.map(([label]) => `While ${label}.`).sort());
  });

  it("nobody but the task's owner may reply, not even who made it", async () => {
    const task = await createTask();
    const s = services();
    for (const person of ['teammate', 'editor']) {
      await expect(s.reply(replyTo(task, 'q1', 'Hello.'), s.as(person)), person).rejects.toMatchObject({ toolCode: 'forbidden' });
    }
    expect(await storedReplies()).toEqual([]);
    expect(s.dispatched).toEqual([]);
  });

  it('a repeat routine and a missing routine are not-found', async () => {
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const s = services();
    await expect(s.reply(replyTo(repeat, 'q1', 'Hello.'))).rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
    await expect(s.reply(replyTo({ agentId: 'a', routineId: 'rtn_missing' }, 'q2', 'Hello.'))).rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
    expect(await storedReplies()).toEqual([]);
    expect(s.dispatched).toEqual([]);
  });

  it("agents:resolve runs first, and a caller it refuses stores nothing, though they own the task", async () => {
    const task = await createTask();
    // The task's owner, who can no longer reach the agent.
    const s = services({ reach: [] });
    await expect(s.reply(replyTo(task, 'q1', 'Hello.'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.order).toEqual(['agents:resolve']);
    expect(await storedReplies()).toEqual([]);
  });

  it('refused text never reaches the store', async () => {
    const task = await createTask();
    const s = services();
    const refused: Array<[label: string, text: string]> = [
      ['empty', ''],
      ['blank', ' \n\t '],
      ['2,001 characters', 'x'.repeat(2001)],
      ['an invisible character', `ok${String.fromCodePoint(0x200b)}then`],
      ['a broken character', `ok${String.fromCharCode(0xd800)}`],
    ];
    let n = 0;
    for (const [label, text] of refused) await expect(s.reply(replyTo(task, `q${++n}`, text)), label).rejects.toMatchObject({ toolCode: 'validation' });
    expect(s.order).toEqual([]);
    expect(await storedReplies()).toEqual([]);
  });

  it('without dispatch, a reply is refused before anything is stored', async () => {
    const task = await createTask();
    const s = services({ dispatch: false });
    await expect(s.reply(replyTo(task, 'q1', 'Hello.'))).rejects.toMatchObject({ toolCode: 'unavailable' });
    expect(s.order).toEqual(['agents:resolve']);
    expect(await storedReplies()).toEqual([]);
  });

  it('while the host shuts down, a reply is refused before anything is stored', async () => {
    const task = await createTask();
    const s = services({ admitDispatch: async () => { throw new SafeToolError('unavailable', 'input'); } });
    await expect(s.reply(replyTo(task, 'q1', 'Hello.'))).rejects.toMatchObject({ toolCode: 'unavailable' });
    expect(s.order).toEqual([]);
    expect(await storedReplies()).toEqual([]);
  });

  it('logs one line per reply, ids and closed words only', async () => {
    const task = await createTask();
    const s = services();
    const KEYS = ['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'checkIn', 'replayed'];
    const text = 'The refund code is QX7731.';
    const entries = (lines: readonly string[]) => lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.msg === 'routines_reply_added');
    const first = logged(s.as('owner'));
    await s.reply(replyTo(task, 'q1', text), first.ctx);
    const retry = logged(s.as('owner'));
    await s.reply(replyTo(task, 'q1', text), retry.ctx);
    expect(entries(first.lines)).toEqual([expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId, checkIn: 'started', replayed: false })]);
    expect(entries(retry.lines)).toEqual([expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId, checkIn: 'replayed', replayed: true })]);
    for (const entry of [...entries(first.lines), ...entries(retry.lines)]) {
      for (const key of Object.keys(entry)) expect(KEYS, key).toContain(key);
    }
    expect([...first.lines, ...retry.lines].join('\n')).not.toContain('QX7731');
  });

  it("logs one ids-only warn line when a stored reply's check-in step throws, and rethrows", async () => {
    const task = await createTask();
    const row = (await f.store.findOne(keyOf(task)))!;
    const KEYS = ['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'replyId', 'toolCode'];
    const text = 'The refund code is QX7731.';
    const cases: Array<[label: string, store: Partial<RoutinesStore>, toolCode: string | null]> = [
      ['the accept throws', { acceptDispatch: async () => { throw new Error('connection reset QX7731'); } }, null],
      ['edited meanwhile', { acceptDispatch: async () => null, findOne: async () => ({ ...row, revision: 'rev_later' }) }, 'unavailable'],
      ['deleted meanwhile', { acceptDispatch: async () => null, findOne: async () => null }, 'not-found'],
    ];
    let n = 0;
    for (const [label, swapped, toolCode] of cases) {
      const s = services({ store: swapped });
      const log = logged(s.as('owner'));
      const sent = s.reply(replyTo(task, `w${++n}`, text), log.ctx);
      if (toolCode === null) await expect(sent, label).rejects.toThrow('connection reset');
      else await expect(sent, label).rejects.toMatchObject({ toolCode });
      const entries = log.lines.map(line => JSON.parse(line) as Record<string, unknown>);
      expect(entries.filter(entry => entry.msg === 'routines_reply_check_in_failed'), label).toEqual([
        expect.objectContaining({ level: 'warn', agentId: 'a', routineId: task.routineId, replyId: expect.stringMatching(/^reply_/), toolCode: toolCode ?? 'unknown' }),
      ]);
      for (const entry of entries) for (const key of Object.keys(entry)) expect(KEYS, `${label}: ${key}`).toContain(key);
      expect(log.lines.join('\n'), label).not.toContain('QX7731');
    }
    // Stored all the same.
    expect(await storedReplies()).toHaveLength(cases.length);
  });

  it('a refusal before the reply is stored logs no check-in failure', async () => {
    const task = await createTask();
    const s = services();
    const log = logged(s.as('teammate'));
    await expect(s.reply(replyTo(task, 'q1', 'Hello.'), log.ctx)).rejects.toMatchObject({ toolCode: 'forbidden' });
    expect(log.lines.join('\n')).not.toContain('routines_reply_check_in_failed');
  });
});

describe('routines:reply after a host restart cut its check-in off (TASK-937)', () => {
  /** A running task, the hooks over it, and a reply whose first try started its check-in, still open. */
  const firstTry = async () => {
    const task = await createTask();
    const s = services();
    const input = replyTo(task, 'q1', 'Are the refunds still stuck?');
    const first = await s.reply(input);
    expect(first).toStrictEqual({ replyId: STARTED_ID, checkIn: 'started' });
    expect(s.dispatched).toHaveLength(1);
    // fire.ts binds the run to its conversation before the agent runs, so a run cut off mid-turn has one.
    await f.store.bindDispatchConversation({ dispatchId: s.dispatched[0]!.dispatchId, conversationId: 'c1' });
    return { task, s, input, first, dispatchId: s.dispatched[0]!.dispatchId };
  };

  it('a retry starts one more check-in, keyed on the reply and the one cut off, and a retry after that replays it', async () => {
    const { task, s, input, first, dispatchId: cutOff } = await firstTry();
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    const retry = logged(s.as('owner'));
    expect(await s.reply(input, retry.ctx)).toStrictEqual({ replyId: first.replyId, checkIn: 'started' });
    expect(s.dispatched).toHaveLength(2);
    expect(s.dispatched[1]).toMatchObject({ source: 'manual', row: expect.objectContaining({ routineId: task.routineId, revision: task.revision }) });
    expect(await dispatchReceipts()).toEqual([
      { owner_user_id: 'owner', request_id: `reply:${first.replyId}` },
      { owner_user_id: 'owner', request_id: `reply:${first.replyId}:after:${cutOff}` },
    ]);
    // The reply replayed; its check-in started.
    expect(retry.lines.map(line => JSON.parse(line) as Record<string, unknown>))
      .toContainEqual(expect.objectContaining({ msg: 'routines_reply_added', checkIn: 'started', replayed: true }));
    // The new one is still running, so the next retry replays it.
    expect(await s.reply(input)).toStrictEqual({ replyId: first.replyId, checkIn: 'replayed' });
    expect(s.dispatched).toHaveLength(2);
    expect(await storedReplies()).toHaveLength(1);
  });

  it('two retries at once start one check-in between them', async () => {
    const { s, input } = await firstTry();
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    const answers = await Promise.all([s.reply(input), s.reply(input)]);
    expect(answers.map(a => a.checkIn).sort()).toEqual(['replayed', 'started']);
    expect(s.dispatched).toHaveLength(2);
    expect(await dispatchReceipts()).toHaveLength(2);
  });

  it('two retries that both read no check-in under the new key start one between them: the second accept replays the first', async () => {
    const task = await createTask();
    const real = f.store;
    // Each retry's read of the new key waits until both have read it empty, so both go on to the accept.
    let emptyReads = 0;
    let bothRead!: () => void;
    const bothReadEmpty = new Promise<void>(resolve => { bothRead = resolve; });
    // A serialized pair never gets a second empty read: fail here, named, not at the 60 s test timeout.
    // The clock starts at the first empty read, so a slow setup can't spend it.
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    let serialized!: (err: Error) => void;
    const noBarrier = new Promise<never>((_, reject) => { serialized = reject; });
    const both = Promise.race([bothReadEmpty, noBarrier]);
    both.catch(() => undefined);
    const s = services({ store: {
      async acceptedDispatchId(input) {
        const found = await real.acceptedDispatchId(input);
        if (found === null && input.requestId.includes(':after:')) {
          if (++emptyReads === 1) giveUp = setTimeout(() => serialized(new Error('the second retry never read the new key: the two retries were serialized')), 5_000);
          if (emptyReads === 2) bothRead();
          await both;
        }
        return found;
      },
    } });
    const input = replyTo(task, 'q1', 'Are the refunds still stuck?');
    expect((await s.reply(input)).checkIn).toBe('started');
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    const answers = await Promise.all([s.reply(input), s.reply(input)]).finally(() => clearTimeout(giveUp));
    expect(emptyReads).toBe(2);
    expect(answers.map(a => a.checkIn).sort()).toEqual(['replayed', 'started']);
    expect(s.dispatched).toHaveLength(2);
    expect(await dispatchReceipts()).toHaveLength(2);
  });

  it("a retry whose accept finds the reply's check-in taken at another revision answers replayed", async () => {
    const { task, input, first } = await firstTry();
    await f.store.updateAuthored({
      ...keyOf(task), expectedRevision: task.revision, actorUserId: 'owner', requestId: 'edit', patch: { goodWhen: 'Nothing waits a day.' }, now, stopOnly: false,
    });
    // The stub forces the accept-side branch. In production that is a stale try meeting a check-in
    // another try accepted at a newer revision: its receipt under `reply:<id>` conflicts with this accept.
    const real = f.store;
    const accepts: unknown[] = [];
    const s = services({ store: {
      acceptedDispatchId: async () => null,
      acceptDispatch: async accept => {
        try { return await real.acceptDispatch(accept); } catch (err) { accepts.push(err); throw err; }
      },
    } });
    expect(await s.reply(input)).toStrictEqual({ replyId: first.replyId, checkIn: 'replayed' });
    // The accept itself hit the conflict, so a change that makes it replay can't pass this unseen.
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toBeInstanceOf(SafeToolError);
    expect(accepts[0]).toMatchObject({ toolCode: 'request-conflict' });
    expect(s.dispatched).toEqual([]);
    expect(await dispatchReceipts()).toEqual([{ owner_user_id: 'owner', request_id: `reply:${first.replyId}` }]);
  });

  const endedOnItsOwn: Array<[label: string, end: (dispatchId: string) => Promise<void>]> = [
    ['finished', async dispatchId => {
      expect(await f.store.finishDispatch({ dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: null, warning: null } })).toBe(true);
    }],
    ['failed on its own', async dispatchId => {
      expect(await f.store.finishDispatch({ dispatchId, outcome: {
        status: 'error', conversationId: null, error: 'The check-in ran out of time.', renderedPrompt: null, warning: null, miss: 'failed',
      } })).toBe(true);
    }],
    ['reported, then cut off', async dispatchId => {
      // firstTry already bound the run to 'c1'.
      expect(await f.store.recordReport({
        agentId: 'a', dispatchId, conversationId: 'c1', actorUserId: 'owner', report: { status: 'on-track', update: 'Read your reply.', ask: null }, now,
      })).toBe('recorded');
      expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    }],
  ];
  it.each(endedOnItsOwn)('a check-in that %s: a retry replays it and starts none', async (_label, end) => {
    const { s, input, first, dispatchId } = await firstTry();
    await end(dispatchId);
    expect(await s.reply(input)).toStrictEqual({ replyId: first.replyId, checkIn: 'replayed' });
    expect(s.dispatched).toHaveLength(1);
    expect(await dispatchReceipts()).toHaveLength(1);
  });

  it('a cut-off check-in starts one more even after the task changed since', async () => {
    const { task, s, input, first } = await firstTry();
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    const edited = await f.store.updateAuthored({
      ...keyOf(task), expectedRevision: task.revision, actorUserId: 'owner', requestId: 'edit', patch: { goodWhen: 'Nothing waits a day.' }, now, stopOnly: false,
    });
    expect(edited.revision).not.toBe(task.revision);
    expect(await s.reply(input)).toStrictEqual({ replyId: first.replyId, checkIn: 'started' });
    expect(s.dispatched).toHaveLength(2);
    expect(s.dispatched[1]!.row.revision).toBe(edited.revision);
  });

  it('stops after REPLY_CHECK_IN_RESTARTS restarts: the retry after that replays', async () => {
    // Every cut-off check-in is a missed one. Below the auto-pause, so the last answer is the bound's, not a pause's.
    expect(REPLY_CHECK_IN_RESTARTS + 1).toBeLessThan(TASK_AUTO_PAUSE_AFTER_MISSES);
    const { s, input, first } = await firstTry();
    for (let restart = 1; restart <= REPLY_CHECK_IN_RESTARTS; restart++) {
      expect(await f.store.interruptAbandonedDispatches(), `restart ${restart}`).toBe(1);
      expect(await s.reply(input), `restart ${restart}`).toStrictEqual({ replyId: first.replyId, checkIn: 'started' });
    }
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    expect(await s.reply(input)).toStrictEqual({ replyId: first.replyId, checkIn: 'replayed' });
    expect(s.dispatched).toHaveLength(REPLY_CHECK_IN_RESTARTS + 1);
  });
});

describe('routines:recent-replies (TASK-931)', () => {
  it('the owner reads their own replies newest first; an earlier owner’s are not among them', async () => {
    const task = await createTask();
    const first = await added(task, 'r1', 'First.');
    const second = await added(task, 'r2', 'Second.\n\nOn two lines.', at(60_000));
    // Written before the routine moved to its owner now: kept, and read for nobody while it isn't theirs.
    await insertReply({ replyId: 'reply_earlier', routineId: task.routineId, author: 'earlier-owner', body: 'Before the move.', sentAt: at(-60_000) });
    const s = services();
    expect(await s.recent(keyOf(task))).toStrictEqual({ replies: [
      { replyId: second.replyId, authorUserId: 'owner', text: 'Second.\n\nOn two lines.', sentAt: '2031-01-01T00:01:00.000Z' },
      { replyId: first.replyId, authorUserId: 'owner', text: 'First.', sentAt: '2031-01-01T00:00:00.000Z' },
    ] });
    expect((await s.recent({ ...keyOf(task), limit: 1 })).replies.map(r => r.replyId)).toEqual([second.replyId]);
    expect(await storedReplies()).toHaveLength(3);
  });

  it('after the task moves to a new owner, they read none of the earlier owner’s replies, only their own', async () => {
    const task = await createTask();
    await added(task, 'r1', 'Before the move.');
    // What resolveRoutineAccess (and the tick) do once a personal agent has a new owner. These hooks'
    // agent is a team agent, which they never move, so the store moves it here.
    expect(await f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'new-owner' }] })).toBe(1);
    const s = services({ reach: ['owner', 'new-owner'] });
    expect(await s.recent(keyOf(task), 'new-owner')).toStrictEqual({ replies: [] });
    // Nor does the earlier owner, their own included: the task isn't theirs now.
    expect(await s.recent(keyOf(task), 'owner')).toStrictEqual({ replies: [] });
    // A reply the new owner sends is the only one they read.
    const theirs = await s.reply(replyTo(task, 'n1', 'After the move.'), s.as('new-owner'));
    expect(theirs.checkIn).toBe('started');
    expect((await s.recent(keyOf(task), 'new-owner')).replies.map(r => [r.replyId, r.authorUserId, r.text]))
      .toEqual([[theirs.replyId, 'new-owner', 'After the move.']]);
    expect(await storedReplies()).toHaveLength(2);
  });

  it('without a limit, the latest 20', async () => {
    const task = await createTask();
    for (let i = 0; i < 21; i++) await added(task, `r${i}`, `Reply ${i}.`, at(i * 1000));
    const s = services();
    expect((await s.recent(keyOf(task))).replies.map(r => r.text)).toEqual(Array.from({ length: 20 }, (_, i) => `Reply ${20 - i}.`));
  });

  it("an owner who can't manage the agent's tasks still reads their own", async () => {
    const task = await createTask();
    await added(task, 'r1', 'Mine.');
    const s = services({ allowed: false });
    expect((await s.recent(keyOf(task))).replies.map(r => r.text)).toEqual(['Mine.']);
  });

  it("anyone else, and a routine that's gone, gets none", async () => {
    const task = await createTask();
    await added(task, 'r1', 'Mine.');
    // Replies whose routine has no row: none would be left after a delete, but a read must not lean on that.
    await insertReply({ replyId: 'reply_orphan', routineId: 'rtn_gone', author: 'owner', body: 'Orphaned.', sentAt: now });
    const s = services();
    expect(await s.recent(keyOf(task), 'teammate')).toStrictEqual({ replies: [] });
    expect(await s.recent(keyOf(task), 'editor')).toStrictEqual({ replies: [] });
    expect(await s.recent({ agentId: 'a', routineId: 'rtn_gone' })).toStrictEqual({ replies: [] });
  });

  it('agents:resolve runs first, and a caller it refuses reads nothing', async () => {
    const task = await createTask();
    await added(task, 'r1', 'Mine.');
    // The task's owner, who can no longer reach the agent.
    const s = services({ reach: [] });
    await expect(s.recent(keyOf(task))).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.order).toEqual(['agents:resolve']);
  });
});

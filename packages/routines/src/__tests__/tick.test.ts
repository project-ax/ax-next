import { afterEach, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { createLogger } from '@ax/core';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { failQueries } from './support/fail-query.js';
import { fixture, createInput, now } from './store-fixture.js';
import { systemClock } from '../clock.js';
import { runTickLoop, runTickOnce } from '../tick.js';
import type { AcceptedDispatch } from '../types.js';
const f = fixture();
afterEach(() => vi.restoreAllMocks());
const due = new Date(now.getTime() + 60000);
const result = { status: 'ok' as const, error: null, renderedPrompt: 'done', recordedAtTurnEnd: true };
function tick(over: Partial<Parameters<typeof runTickOnce>[0]> = {}) {
  return runTickOnce({ store: f.store, fire: vi.fn(async (_d: AcceptedDispatch) => result), now: due, claimBatchSize: 50, claimWindowMinutes: 5, ...over });
}
const edit = (row: {
  agentId: string;
  routineId: string;
  revision: string;
}) => ({ ...row, expectedRevision: row.revision, actorUserId: 'editor', requestId: 'edit', now, stopOnly: false });
/** TASK-1038: errors whose reading throws. A plugin's error reaches a caller as it was thrown (hook-bus.ts). */
const HOSTILE = [
  ['a message getter that throws', () => Object.defineProperty(new Error('PRIVATE'), 'message', { get() { throw new Error('getter'); } })],
  ['a Proxy whose instanceof check throws', () => new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } })],
  ['a value whose toString throws', () => ({ toString() { throw new Error('toString'); } })],
  ['a value with no prototype', () => Object.create(null) as unknown],
] as const;
/** TASK-1041: a core logger that keeps its JSON lines; entries() drops ts and reqId. */
function recordingLogger() {
  const lines: string[] = [];
  const logger = createLogger({ reqId: 'tick-test', writer: line => { lines.push(line); } });
  const entries = () => lines.map(line => { const { ts: _ts, reqId: _reqId, ...entry } = JSON.parse(line) as Record<string, unknown>; return entry; });
  return { logger, entries, text: () => lines.join('\n') };
}
describe('DB scheduler', () => {
  it('keeps a capped Repeat schedule due and starts it when capacity returns', async () => {
    const row=await f.store.createAuthored(createInput());
    const active=[];
    for(let i=0;i<3;i++)active.push((await f.store.acceptDispatch({...row,actorUserId:'owner',expectedRevision:row.revision,source:'manual',requestId:`occupy-${i}`,now}))!);
    const fire=vi.fn(async()=>result);
    await tick({fire});
    expect(fire).not.toHaveBeenCalled();
    expect(await f.store.findOne(row)).toMatchObject({nextRunAt:due,lastRunAt:null});
    await f.store.finishDispatch({dispatchId:active[0]!.accepted.dispatchId,outcome:{status:'ok',error:null,conversationId:null,renderedPrompt:null,warning:null}});
    await tick({fire});
    expect(fire).toHaveBeenCalledTimes(1);
    expect((await f.store.findOne(row))!.nextRunAt).toEqual(new Date(due.getTime()+60000));
  });
  it('preserves the due target on a prompt edit and dispatches the current revision once', async () => {
    const row = await f.store.createAuthored(createInput());
    const changed = await f.store.updateAuthored({ ...edit(row), patch: { promptBody: 'new' } });
    expect(changed.nextRunAt).toEqual(due);
    const fire = vi.fn(async (accepted: AcceptedDispatch) => { expect(accepted.row.promptBody).toBe('new'); return result; });
    await tick({ fire });
    await tick({ fire });
    expect(fire).toHaveBeenCalledTimes(1);
    expect((await f.store.findOne(row))!.nextRunAt).toEqual(new Date(due.getTime() + 60000));
    expect(await f.store.recentFires(row)).toEqual([]); // acceptance is not a completed turn
  });
  it.each(['edit', 'delete'] as const)('rejects a stale claim after %s and cannot advance the edited schedule', async (kind) => {
    const row = await f.store.createAuthored(createInput());
    const store = f.store;
    const claim = store.claimDue.bind(store);
    store.claimDue = async (input) => {
      const rows = await claim(input);
      if (kind === 'edit')
        await store.updateAuthored({ ...edit(row), patch: { trigger: { kind: 'interval', every: '1h' } } });
      else
        await store.deleteAuthored(edit(row));
      return rows;
    };
    const fire = vi.fn(async () => result);
    await tick({ store, fire });
    expect(fire).not.toHaveBeenCalled();
    if (kind === 'edit')
      expect((await store.findOne(row))!.nextRunAt).toEqual(new Date(now.getTime() + 3600000));
  });
  it('does not claim disabled rows and enabling schedules a future occurrence', async () => {
    const row = await f.store.createAuthored({ ...createInput(), definition: { ...createInput().definition, enabled: false } });
    const fire = vi.fn(async () => result);
    await tick({ fire });
    expect(fire).not.toHaveBeenCalled();
    const enabled = await f.store.updateAuthored({ ...edit(row), now: due, patch: { enabled: true } });
    expect(enabled.nextRunAt).toEqual(new Date(due.getTime() + 60000));
  });
  it('defers outside active hours with the claimed revision, without overwriting an edit', async () => {
    const row = await f.store.createAuthored({ ...createInput(), definition: { ...createInput().definition, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } } });
    const store = f.store;
    const claim = store.claimDue.bind(store);
    store.claimDue = async (input) => { const rows = await claim(input); await store.updateAuthored({ ...edit(row), patch: { trigger: { kind: 'interval', every: '1h' } } }); return rows; };
    const fire = vi.fn(async () => result);
    await tick({ store, fire });
    expect(fire).not.toHaveBeenCalled();
    expect((await store.findOne(row))!.nextRunAt).toEqual(new Date(now.getTime() + 3600000));
  });
  it('continues the batch after purging an agent that owns multiple claimed routines', async () => {
    await f.store.createAuthored(createInput());
    await f.store.createAuthored({ ...createInput('second'), definition: { ...createInput().definition, name: 'Second' } });
    await f.store.createAuthored({ ...createInput('other'), agentId: 'b' });
    const fire = vi.fn(async (accepted: AcceptedDispatch) => {
      if (accepted.row.agentId === 'a')
        await f.store.purgeAgent('a');
      return result;
    });
    const cleanup = vi.fn(async () => { });
    await tick({ fire, cleanup });
    expect(fire.mock.calls.map(([d]) => d.row.agentId).sort()).toEqual(['a', 'b']);
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it.each([90000, 600000])('advances interval scheduling without drift or replaying missed intervals at %s ms', async (offset) => {
    const row = await f.store.createAuthored(createInput());
    const at = new Date(now.getTime() + offset);
    await tick({ now: at });
    expect((await f.store.findOne(row))!.nextRunAt).toEqual(new Date(now.getTime() + (offset === 90000 ? 120000 : 660000)));
  });
  it('uses the cron engine and records an unexpected dispatcher error once', async () => {
    const row = await f.store.createAuthored({ ...createInput(), definition: { ...createInput().definition, schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC' } } });
    const diagnostic = captureExpectedStderr(message => message === `[ax/routines] fire failed for ${row.agentId}/${row.routineId}: PRIVATE dispatch failed\n`);
    await tick({ fire: async () => { throw new Error('PRIVATE dispatch failed'); } });
    expect((await f.store.findOne(row))!.nextRunAt).toEqual(new Date(due.getTime() + 60000));
    // TASK-1031: the owner reads fixed words; the message goes only to the log.
    expect((await f.store.recentFires(row))[0]).toMatchObject({ status: 'error', error: 'This run failed because of a problem on our side.' });
    expect(diagnostic.messages).toHaveLength(1);
  });
  it('still claims authored routines if owner enumeration fails', async () => {
    await f.store.createAuthored(createInput());
    const fire = vi.fn(async () => result);
    const diagnostic = captureExpectedStderr(message => message === '[ax/routines] materialize/refresh error: directory unavailable\n');
    await tick({ fire, getAgents: async () => { throw new Error('directory unavailable'); } });
    expect(fire).toHaveBeenCalledOnce();
    expect(diagnostic.messages).toHaveLength(1);
  });
  it.each(HOSTILE)('still claims authored routines when owner enumeration fails with %s', async (_name, make) => {
    await f.store.createAuthored(createInput());
    const fire = vi.fn(async () => result);
    const diagnostic = captureExpectedStderr(message => message === '[ax/routines] materialize/refresh error: (unreadable error)\n');
    await tick({ fire, getAgents: async () => { throw make(); } });
    expect(fire).toHaveBeenCalledOnce();
    expect(diagnostic.messages).toHaveLength(1);
  });
  it.each(HOSTILE)('records the run and fires the rest of the batch when a fire fails with %s', async (_name, make) => {
    const failing = await f.store.createAuthored(createInput());
    await f.store.createAuthored({ ...createInput('second'), definition: { ...createInput().definition, name: 'Second' } });
    const fire = vi.fn(async (accepted: AcceptedDispatch) => { if (accepted.row.routineId === failing.routineId) throw make(); return result; });
    const diagnostic = captureExpectedStderr(message => message === `[ax/routines] fire failed for ${failing.agentId}/${failing.routineId}: (unreadable error)\n`);
    await tick({ fire });
    expect(fire).toHaveBeenCalledTimes(2);
    expect((await f.store.recentFires(failing))[0]).toMatchObject({ status: 'error', error: 'This run failed because of a problem on our side.' });
    expect(diagnostic.messages).toHaveLength(1);
  });
  // The scheduler loop itself: a tick that fails with an unreadable error must be logged and survived, or the replica stops scheduling.
  it.each(HOSTILE)('keeps the scheduler loop running when a tick fails with %s', async (_name, make) => {
    const controller = new AbortController();
    let sleeps = 0;
    const cleanup = vi.fn(async () => { throw make(); });
    const diagnostic = captureExpectedStderr(message => message === '[ax/routines] tick error: (unreadable error)\n');
    const log = recordingLogger();
    await runTickLoop({
      db: f.db, fire: vi.fn(async () => result), cleanup, logger: log.logger,
      clock: { now: () => due, sleep: async () => { if (++sleeps >= 2) controller.abort(); } },
      signal: controller.signal, tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(diagnostic.messages).toHaveLength(2);
    expect(log.entries()).toEqual([]);
  });
  it('logs a readable tick failure with its message and keeps the loop running', async () => {
    const controller = new AbortController();
    let sleeps = 0;
    const cleanup = vi.fn(async () => { throw new Error('database unavailable'); });
    const diagnostic = captureExpectedStderr(message => message === '[ax/routines] tick error: database unavailable\n');
    const log = recordingLogger();
    await runTickLoop({
      db: f.db, fire: vi.fn(async () => result), cleanup, logger: log.logger,
      clock: { now: () => due, sleep: async () => { if (++sleeps >= 2) controller.abort(); } },
      signal: controller.signal, tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(diagnostic.messages).toHaveLength(2);
    expect(log.entries()).toEqual([]);
  });
  it('keeps leadership while its session answers: one election across three ticks (TASK-1048)', async () => {
    const controller = new AbortController();
    let sleeps = 0;
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    const cleanup = vi.fn(async () => {});
    const log = recordingLogger();
    await runTickLoop({
      db: f.db, fire: vi.fn(async () => result), cleanup, logger: log.logger,
      clock: { now: () => due, sleep: async () => { if (++sleeps >= 3) controller.abort(); } },
      signal: controller.signal, tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    const sent = queries.mock.calls.map(([text]) => String(text));
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(sent.filter((text) => text.includes('pg_try_advisory_lock'))).toHaveLength(1);
    expect(sent.filter((text) => text.trim() === 'SELECT 1')).toHaveLength(2); // before ticks 2 and 3; none at shutdown
    expect(log.entries()).toEqual([]);
  });
  it('steps down with a code-only line when a live session refuses the probe, then re-elects (TASK-1048)', async () => {
    // A session can refuse a statement without dying (a cancel, a timeout).
    // The client emits no 'error' then, so the database plugin writes nothing:
    // this line is the only record of why the leader gave up its lock.
    const controller = new AbortController();
    let sleeps = 0;
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    const cleanup = vi.fn(async () => {});
    const log = recordingLogger();
    const restore = failQueries(/^\s*SELECT 1\s*$/, Object.assign(new Error('PRIVATE canceling statement at 10.0.0.7'), { code: '57014' }));
    try {
      await runTickLoop({
        db: f.db, fire: vi.fn(async () => result), cleanup, logger: log.logger,
        clock: { now: () => due, sleep: async () => { if (++sleeps >= 2) controller.abort(); } },
        signal: controller.signal, tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 50, claimWindowMinutes: 5,
      });
    } finally { restore(); }
    const sent = queries.mock.calls.map(([text]) => String(text));
    // Tick 1, the refused probe, the step-down, an immediate second election, tick 2.
    expect(sent.filter((text) => text.includes('pg_try_advisory_lock'))).toHaveLength(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(log.entries()).toStrictEqual([{ code: '57014', name: 'Error', level: 'warn', msg: 'routines_tick_leader_stepped_down' }]);
    expect(JSON.stringify(log.entries())).not.toContain('PRIVATE');
  });
  it('keeps scheduling when the election query fails once, and logs it in codes only (TASK-1041)', async () => {
    const row = await f.store.createAuthored(createInput());
    const controller = new AbortController();
    const sleeps: number[] = [];
    const fire = vi.fn(async (_d: AcceptedDispatch) => result);
    const log = recordingLogger();
    const restore = failQueries(/pg_try_advisory_lock/, Object.assign(new Error('PRIVATE election detail at 10.0.0.7'), { code: '57P01' }));
    try {
      await runTickLoop({
        db: f.db, fire, logger: log.logger,
        clock: { now: () => due, sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 2) controller.abort(); } },
        signal: controller.signal, tickIntervalMs: 1000, electionRetryMs: 50_000, claimBatchSize: 50, claimWindowMinutes: 5,
      });
    } finally { restore(); }
    expect(sleeps).toEqual([1000, 1000]); // the wait after the failure, then the elected ticker's own tick
    expect(fire).toHaveBeenCalledOnce();
    expect(fire.mock.calls[0]![0].row.routineId).toBe(row.routineId);
    expect(log.entries()).toStrictEqual([{ code: '57P01', name: 'Error', consecutiveFailures: 1, retryInMs: 1000, level: 'warn', msg: 'routines_tick_election_failed' }]);
    expect(log.text()).not.toContain('PRIVATE');
  });
  it('backs off from one tick to the election wait while elections fail, and starts over once one answers (TASK-1041)', async () => {
    const controller = new AbortController();
    const refused = () => Promise.reject(Object.assign(new Error('PRIVATE connect detail at 10.0.0.7:5432'), { code: 'ECONNREFUSED' }));
    const outcomes: Array<() => Promise<boolean>> = [refused, refused, refused, refused, async () => false, refused];
    const db = { connection: () => ({ execute: () => outcomes.shift()!() }) } as unknown as Parameters<typeof runTickLoop>[0]['db'];
    const sleeps: number[] = [];
    const log = recordingLogger();
    await runTickLoop({
      db, fire: vi.fn(async () => result), logger: log.logger,
      clock: { now: () => due, sleep: async (ms) => { sleeps.push(ms); if (outcomes.length === 0) controller.abort(); } },
      signal: controller.signal, tickIntervalMs: 1000, electionRetryMs: 3000, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    // Doubling from one tick, capped at the election wait; a lost election waits the election wait and ends the run.
    expect(sleeps).toEqual([1000, 2000, 3000, 3000, 3000, 1000]);
    expect(log.entries().map(e => [e.msg, e.code, e.consecutiveFailures, e.retryInMs])).toEqual([
      ['routines_tick_election_failed', 'ECONNREFUSED', 1, 1000],
      ['routines_tick_election_failed', 'ECONNREFUSED', 2, 2000],
      ['routines_tick_election_failed', 'ECONNREFUSED', 3, 3000],
      ['routines_tick_election_failed', 'ECONNREFUSED', 4, 3000],
      ['routines_tick_election_failed', 'ECONNREFUSED', 1, 1000],
    ]);
    expect(log.text()).not.toContain('PRIVATE');
  });
  it('stops at once when shut down while waiting after a failed election (TASK-1041)', async () => {
    const controller = new AbortController();
    const db = { connection: () => ({ execute: () => Promise.reject(Object.assign(new Error('PRIVATE'), { code: '57P03' })) }) } as unknown as Parameters<typeof runTickLoop>[0]['db'];
    const log = recordingLogger();
    const loop = runTickLoop({
      db, fire: vi.fn(async () => result), logger: log.logger, clock: systemClock,
      signal: controller.signal, tickIntervalMs: 600_000, electionRetryMs: 600_000, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    await vi.waitFor(() => expect(log.entries()).toHaveLength(1));
    const abortedAt = Date.now();
    controller.abort();
    await loop;
    expect(Date.now() - abortedAt).toBeLessThan(1000);
  });
});

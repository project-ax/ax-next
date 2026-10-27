import { describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type { ActiveHours, RoutinePatch } from '@ax/routines-contract';
import { fixture, createInput, defaultDefinition } from './store-fixture.js';
import { createRoutinesStore } from '../store.js';
import { createRequestHashes } from '../definition.js';
import { routineView } from '../services.js';
import { runTickOnce } from '../tick.js';
import type { AcceptedDispatch } from '../types.js';

const f = fixture();
const monday = new Date('2026-10-26T21:00:00Z');
const hours: ActiveHours = { start: '22:00', end: '06:00', tz: 'UTC', days: ['mon'] };
const input = (requestId = 'hours') => ({ ...createInput(requestId), now: monday,
  definition: { ...createInput().definition, activeHours: hours } });
const edit = (row: { agentId: string; routineId: string; revision: string }, patch: RoutinePatch, now = monday) => ({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision,
  actorUserId: 'editor', requestId: crypto.randomUUID(), patch, stopOnly: false, now,
});
const fire = () => vi.fn(async (_accepted: AcceptedDispatch) => ({ status: 'ok' as const, error: null, renderedPrompt: null, recordedAtTurnEnd: true }));

describe('selected active days through real durable storage and tick', () => {
  it('persists canonical days through a reopened store and equivalent receipt replay', async () => {
    const request = { ...input(), definition: { ...input().definition, activeHours: { ...hours, days: ['sun', 'mon'] as ActiveHours['days'] } } };
    const row = await f.store.createAuthored(request);
    const reopened = createRoutinesStore(f.db);
    expect((await reopened.findOne(row))?.activeHours?.days).toEqual(['mon', 'sun']);
    const replay = await reopened.createAuthored({ ...request,
      definition: { ...request.definition, activeHours: { ...hours, days: ['mon', 'sun'] } },
    });
    expect(replay.routineId).toBe(row.routineId);
    expect(await reopened.list({ agentId: row.agentId })).toHaveLength(1);
  });

  it('makes tick and preview agree, including overnight carryover and day edits', async () => {
    const row = await f.store.createAuthored(input());
    const invoke = fire();
    expect(routineView(row, 'owner', true).nextRunAt).toBe('2026-10-26T22:00:00.000Z');
    await runTickOnce({ store: f.store, fire: invoke, now: new Date('2026-10-26T21:01:00Z'), claimBatchSize: 50, claimWindowMinutes: 5 });
    expect(invoke).not.toHaveBeenCalled();
    expect((await f.store.findOne(row))?.nextRunAt).toEqual(new Date('2026-10-26T22:00:00Z'));
    await runTickOnce({ store: f.store, fire: invoke, now: new Date('2026-10-26T22:00:00Z'), claimBatchSize: 50, claimWindowMinutes: 5 });
    expect(invoke).toHaveBeenCalledTimes(1);
    const current = (await f.store.findOne(row))!;
    const changed = await f.store.updateAuthored(edit(current, { activeHours: { ...hours, days: ['wed'] } }, new Date('2026-10-27T06:00:00Z')));
    expect(changed.nextRunAt).toEqual(new Date('2026-10-27T06:01:00Z'));
    expect(routineView(changed, 'owner', true).nextRunAt).toBe('2026-10-28T22:00:00.000Z');
  });

  it('keeps one historical empty row readable, vetoes its timer, allows Stop and repair', async () => {
    const at = new Date('2026-10-26T09:00:00Z');
    const row = await f.store.createAuthored({ ...input(), now: at,
      definition: { ...input().definition, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } },
    });
    await f.store.createAuthored({ ...input('good'), now: at, definition: { ...input().definition, activeHours: null } });
    await sql`UPDATE routines_v1_definitions SET active_hours=${JSON.stringify({ start: '09:00', end: '09:00', tz: 'UTC' })}::jsonb
      WHERE agent_id=${row.agentId} AND routine_id=${row.routineId}`.execute(f.db);
    const bad = (await f.store.list({ agentId: row.agentId })).find(value => value.routineId === row.routineId)!;
    expect(routineView(bad, 'owner', true)).toMatchObject({ nextRunAt: null, lastWarning: expect.stringMatching(/scheduled runs.*different start and end/i) });
    const invoke = fire();
    await runTickOnce({ store: f.store, fire: invoke, now: new Date('2026-10-26T10:00:00Z'), claimBatchSize: 50, claimWindowMinutes: 5 });
    expect(invoke.mock.calls.some(([accepted]) => accepted.row.routineId === row.routineId)).toBe(false);
    expect((await f.store.findOne(row))?.nextRunAt).toBeNull();
    const stopped = await f.store.updateAuthored({ ...edit(bad, { enabled: false }), stopOnly: true });
    expect(stopped.enabled).toBe(false);
    const repaired = await f.store.updateAuthored(edit(stopped, { enabled: true, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } }, new Date('2026-10-26T10:00:00Z')));
    expect(routineView(repaired, 'owner', true).nextRunAt).toBe('2026-10-26T10:01:00.000Z');
    await runTickOnce({ store: f.store, fire: invoke, now: new Date('2026-10-26T10:01:00Z'), claimBatchSize: 50, claimWindowMinutes: 5 });
    expect(invoke.mock.calls.some(([accepted]) => accepted.row.routineId === row.routineId)).toBe(true);
  });

  it('replays a settled legacy equal-window receipt before applying new authoring rules', async () => {
    const request = { ...input(), definition: { ...input().definition, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } } };
    const row = await f.store.createAuthored(request);
    const old = await f.db.selectFrom('routines_v1_requests').select('result').where('request_id', '=', request.requestId).executeTakeFirstOrThrow();
    const { schedule, webhook: _webhook, ...legacy } = old.result as Record<string, unknown>;
    const empty = { start: '09:00', end: '09:00', tz: 'UTC' };
    const retry = { ...request, definition: { ...request.definition, activeHours: empty } };
    const hashes = createRequestHashes(retry);
    expect(hashes.length).toBeGreaterThan(1);
    await sql`UPDATE routines_v1_requests SET input_hash=${hashes[1]!}, result=${JSON.stringify({ ...legacy, trigger: schedule, activeHours: empty })}::jsonb
      WHERE agent_id=${row.agentId} AND request_id=${request.requestId}`.execute(f.db);
    expect((await f.store.createAuthored(retry)).activeHours).toEqual(empty);
    await expect(f.store.createAuthored({ ...retry, requestId: 'fresh-invalid' })).rejects.toMatchObject({ toolCode: 'validation', field: 'activeHours.end' });
  });

  it('materializes selected default days and keeps the required-null scheduling target', async () => {
    await sql`UPDATE default_routines_v1 SET enabled=false`.execute(f.db);
    const saved = await f.store.upsertDefault({ ...defaultDefinition(), name: 'night-default', enabled: true,
      activeHours: { ...hours, days: ['sun', 'mon'] },
    });
    await f.store.materializeMissing({ agents: [{ agentId: 'a', ownerUserId: 'owner' }], now: monday });
    const row = (await f.store.list({ agentId: 'a' })).find(value => value.definitionId === saved.defaultRoutineId)!;
    expect(row.activeHours?.days).toEqual(['mon', 'sun']);
    const invoke = fire();
    await runTickOnce({ store: f.store, fire: invoke, now: new Date('2026-10-26T21:01:00Z'), claimBatchSize: 50, claimWindowMinutes: 5 });
    expect(invoke).not.toHaveBeenCalled();
    const deferred = (await f.store.findOne(row))!;
    expect(deferred.nextRunAt).toBeNull();
    expect(deferred.lastRunAt).toEqual(new Date('2026-10-26T22:00:00Z'));
    await runTickOnce({ store: f.store, fire: invoke, now: new Date('2026-10-26T22:01:00Z'), claimBatchSize: 50, claimWindowMinutes: 5 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((await f.store.findOne(row))?.nextRunAt).toBeNull();
  });
});

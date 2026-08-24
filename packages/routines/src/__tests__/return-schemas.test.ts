import { describe, it, expect } from 'vitest';
import {
  FireNowOutputSchema,
  ListOutputSchema,
  RecentFiresOutputSchema,
  RecentFiresForAgentOutputSchema,
  RoutinesDeleteDefaultOutputSchema,
  RoutinesGetDefaultOutputSchema,
  RoutinesListDefaultsOutputSchema,
  RoutinesUpsertDefaultOutputSchema,
  RoutinesSetAgentDefaultEnabledOutputSchema,
  RoutinesListAgentDefaultsOutputSchema,
  type DefaultRoutineDetail,
  type DefaultRoutineSummary,
  type FireNowOutput,
  type FireRow,
  type ListOutput,
  type RecentFiresOutput,
  type RecentFiresForAgentOutput,
  type RoutineRow,
  type RoutinesDeleteDefaultOutput,
  type RoutinesListDefaultsOutput,
  type RoutinesUpsertDefaultOutput,
  type RoutinesSetAgentDefaultEnabledOutput,
  type RoutinesListAgentDefaultsOutput,
} from '../types.js';

// ARCH-13 drift guard for the `routines:*` returns schemas. A fully-populated
// interface-typed value must round-trip through `.parse` without losing a
// field. RoutineRow/FireRow carry real Date instances (z.date()); the default
// summaries project updatedAt to an ISO string (z.string()).

const routineRow: RoutineRow = {
  agentId: 'ag1',
  path: 'notify',
  authorUserId: 'u1',
  name: 'Notify',
  description: 'pings on event',
  specHash: 'abc123',
  trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
  activeHours: { start: '09:00', end: '17:00', tz: 'UTC' },
  silenceToken: 'tok',
  silenceMaxChars: 500,
  conversation: 'shared',
  promptBody: 'do the thing',
  nextRunAt: new Date('2026-02-01T09:00:00.000Z'),
  lastRunAt: new Date('2026-01-31T09:00:00.000Z'),
  lastStatus: 'ok',
  lastError: null,
  definitionId: 'def1',
  definitionUpdatedAt: new Date('2026-01-30T00:00:00.000Z'),
};

const fireRow: FireRow = {
  id: 42,
  agentId: 'ag1',
  path: 'notify',
  firedAt: new Date('2026-01-31T09:00:00.000Z'),
  triggerSource: 'webhook',
  conversationId: 'c1',
  status: 'ok',
  error: null,
  renderedPrompt: 'rendered',
};

const defaultSummary: DefaultRoutineSummary = {
  defaultRoutineId: 'dr1',
  name: 'Daily digest',
  description: 'sends a digest',
  trigger: { kind: 'interval', every: '1d' },
  enabled: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const defaultDetail: DefaultRoutineDetail = {
  ...defaultSummary,
  sourceMd: '# digest',
  silenceToken: null,
  silenceMax: 1000,
  conversation: 'per-fire',
  activeHours: null,
  promptBody: 'summarize',
};

describe('routines return schemas', () => {
  it('routines:list round-trips a fully-populated RoutineRow (Dates intact)', () => {
    const full: ListOutput = { routines: [routineRow] };
    expect(ListOutputSchema.parse(full)).toEqual(full);
  });

  // This pair is load-bearing and must stay a pair (TASK-251, then TASK-312).
  // `FireRowSchema` is the store's own row type and still carries the
  // `BIGSERIAL` `id`; both fires hooks narrow it away via a DERIVED
  // `omit` (`WireFireRowSchema`), because `HookBus.call` returns
  // `returns.safeParse(...).data` and a zod object STRIPS undeclared keys.
  // Both halves matter: neither hook may leak `id` (invariant 1), and nothing
  // in tsc would catch a regression either way, since the HTTP hop that
  // carries these rows is an untyped `get<T>` plus a cast. TASK-251 narrowed
  // the for-agent hook while the admin table still keyed off `id`; TASK-312
  // moved that key and narrowed this one, so the pair now asserts the same
  // thing about two different hooks — keep it a pair.
  it('routines:recent-fires DROPS the row id (storage vocabulary)', () => {
    // Deliberately fed the wider domain row: the store hands the handler a
    // `FireRow`, and the `returns` schema is what strips `id` at the bus edge.
    const out: RecentFiresOutput = RecentFiresOutputSchema.parse({ fires: [fireRow] });
    expect('id' in out.fires[0]!).toBe(false);
    // Everything else still round-trips.
    const { id: _id, ...withoutId } = fireRow;
    expect(out).toEqual({ fires: [withoutId] });
  });

  it('routines:recent-fires-for-agent DROPS the row id (storage vocabulary)', () => {
    const out: RecentFiresForAgentOutput = RecentFiresForAgentOutputSchema.parse({
      fires: [fireRow],
    });
    expect('id' in out.fires[0]!).toBe(false);
    const { id: _id, ...withoutId } = fireRow;
    expect(out).toEqual({ fires: [withoutId] });
  });

  it('routines:fire-now round-trips both of the shapes it can actually return', () => {
    // Only two: `'silenced'` is written to the fire row later, by the
    // chat:turn-end subscriber, and never travels on this hook.
    const ok: FireNowOutput = { status: 'ok' };
    expect(FireNowOutputSchema.parse(ok)).toEqual(ok);
    const failed: FireNowOutput = { status: 'error' };
    expect(FireNowOutputSchema.parse(failed)).toEqual(failed);
  });

  it('routines:fire-now DROPS both the fire-row id and the conversation id', () => {
    // The handler returns neither, but the schema is the boundary that makes
    // that a guarantee rather than a convention. `fireId` was the store's
    // BIGSERIAL, which reached users as "Fired (#7, ok)". `conversationId`
    // was dropped separately: nothing above the bus could show it, because
    // routine-fired conversations are hidden and have no per-fire transcript
    // to link to (TASK-313).
    //
    // This is the load-bearing case in this file. A field re-added to the
    // handler but not to the schema is stripped silently by `z.object`, and
    // one re-added to BOTH would sail past every other assertion here.
    const parsed = FireNowOutputSchema.parse({
      fireId: 7,
      status: 'ok',
      conversationId: 'cnv_1',
    }) as Record<string, unknown>;
    expect('fireId' in parsed).toBe(false);
    expect('conversationId' in parsed).toBe(false);
    expect(parsed).toEqual({ status: 'ok' });
  });

  it('routines:list-defaults round-trips a fully-populated summary', () => {
    const full: RoutinesListDefaultsOutput = { defaults: [defaultSummary] };
    expect(RoutinesListDefaultsOutputSchema.parse(full)).toEqual(full);
  });

  it('routines:get-default round-trips a fully-populated detail (webhook trigger)', () => {
    const full: DefaultRoutineDetail = {
      ...defaultDetail,
      trigger: {
        kind: 'webhook',
        path: '/wh/abc',
        events: ['push'],
        hmac: { secretRef: 'ref', header: 'X-Sig', algorithm: 'sha256', prefix: 'sha256=' },
      },
    };
    expect(RoutinesGetDefaultOutputSchema.parse(full)).toEqual(full);
  });

  it('routines:upsert-default round-trips', () => {
    const full: RoutinesUpsertDefaultOutput = { defaultRoutineId: 'dr1', created: false };
    expect(RoutinesUpsertDefaultOutputSchema.parse(full)).toEqual(full);
  });

  it('routines:delete-default round-trips the empty output (strict)', () => {
    const full: RoutinesDeleteDefaultOutput = {};
    expect(RoutinesDeleteDefaultOutputSchema.parse(full)).toEqual(full);
    expect(RoutinesDeleteDefaultOutputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('routines:set-agent-default-enabled round-trips the empty output (strict)', () => {
    const full: RoutinesSetAgentDefaultEnabledOutput = {};
    expect(RoutinesSetAgentDefaultEnabledOutputSchema.parse(full)).toEqual(full);
    expect(RoutinesSetAgentDefaultEnabledOutputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('routines:list-agent-defaults round-trips per-agent state', () => {
    const full: RoutinesListAgentDefaultsOutput = {
      defaults: [
        { defaultRoutineId: 'dr1', name: 'heartbeat', enabled: true },
        { defaultRoutineId: 'dr2', name: 'reflection', enabled: false },
      ],
    };
    expect(RoutinesListAgentDefaultsOutputSchema.parse(full)).toEqual(full);
  });

  it('rejects a string firedAt (handler returns a Date)', () => {
    expect(
      RecentFiresOutputSchema.safeParse({
        fires: [{ ...fireRow, firedAt: '2026-01-31' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown trigger kind', () => {
    expect(
      ListOutputSchema.safeParse({
        routines: [{ ...routineRow, trigger: { kind: 'sometime', every: '1h' } }],
      }).success,
    ).toBe(false);
  });
});

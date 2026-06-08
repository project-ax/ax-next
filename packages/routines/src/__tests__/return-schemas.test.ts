import { describe, it, expect } from 'vitest';
import {
  FireNowOutputSchema,
  ListOutputSchema,
  RecentFiresOutputSchema,
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

  it('routines:recent-fires round-trips a fully-populated FireRow', () => {
    const full: RecentFiresOutput = { fires: [fireRow] };
    expect(RecentFiresOutputSchema.parse(full)).toEqual(full);
  });

  it('routines:fire-now round-trips', () => {
    const full: FireNowOutput = { fireId: 7, status: 'silenced', conversationId: null };
    expect(FireNowOutputSchema.parse(full)).toEqual(full);
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

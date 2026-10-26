import { describe, expect, it } from 'vitest';
import { RoutineDefinitionSchema, RoutinePatchSchema, applyRoutinePatch } from '../index.js';

const schedule = { kind: 'interval' as const, every: '1h' };
const webhook = {
  kind: 'webhook' as const, path: '/github', events: ['push'],
  hmac: { header: 'X-Hub-Signature-256', algorithm: 'sha256' as const, prefix: 'sha256=' },
};
const brief = {
  name: 'Morning brief', description: 'Catch up', promptBody: 'Review new work.', enabled: true,
  activeHours: null, silenceToken: null, silenceMaxChars: 300,
  conversation: 'per-fire' as const, kind: 'repeat' as const, goodWhen: null,
};

describe('independent authored wake methods', () => {
  it.each([
    { schedule, webhook: null },
    { schedule: null, webhook },
    { schedule, webhook },
  ])('accepts and preserves an independent repeat definition %#', methods => {
    const input = { ...brief, ...methods };
    const result = RoutineDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual(input);
    expect(result.data).not.toHaveProperty('trigger');
  });

  it('applies work hours to the schedule without removing the app-update method', () => {
    const activeHours = { start: '09:00', end: '18:00', tz: 'America/New_York' };
    const result = RoutineDefinitionSchema.safeParse({ ...brief, schedule, webhook, activeHours });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ schedule, webhook, activeHours });
  });

  it.each(['stay-on-top', 'get-done'] as const)('%s keeps its required schedule and refuses app updates until the inbox exists', kind => {
    const input = { ...brief, kind, goodWhen: 'No unreviewed work.', schedule, webhook: null };
    expect(RoutineDefinitionSchema.safeParse(input).success).toBe(true);
    expect(RoutineDefinitionSchema.safeParse({ ...input, schedule: null }).success).toBe(false);
    expect(RoutineDefinitionSchema.safeParse({ ...input, webhook }).success).toBe(false);
  });

  it('refuses a repeat with no wake method', () => {
    expect(RoutineDefinitionSchema.safeParse({ ...brief, schedule: null, webhook: null }).success).toBe(false);
  });

  it('creates schedule-only definitions with a canonical absent webhook', () => {
    const result = RoutineDefinitionSchema.safeParse({ name: brief.name, promptBody: brief.promptBody, schedule });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ schedule, webhook: null, kind: 'repeat', enabled: true });
    expect(result.data).not.toHaveProperty('trigger');
  });

  it.each([
    { legacy: schedule, methods: { schedule, webhook: null } },
    { legacy: webhook, methods: { schedule: null, webhook } },
  ])('normalizes a saved exclusive trigger at the boundary %#', ({ legacy, methods }) => {
    expect(RoutineDefinitionSchema.parse({ ...brief, trigger: legacy })).toEqual({ ...brief, ...methods });
  });

  it.each([
    { trigger: schedule, schedule },
    { trigger: webhook, webhook },
    { trigger: schedule, webhook: null },
    { trigger: webhook, schedule: null },
  ])('refuses mixed legacy and canonical definition keys %#', mixed => {
    expect(RoutineDefinitionSchema.safeParse({ ...brief, ...mixed }).success).toBe(false);
  });

  it('keeps strict nested validation for both methods', () => {
    expect(RoutineDefinitionSchema.safeParse({ ...brief, schedule: { ...schedule, every: '59s' }, webhook: null }).success).toBe(false);
    expect(RoutineDefinitionSchema.safeParse({ ...brief, schedule: { ...schedule, unknown: true }, webhook }).success).toBe(false);
    expect(RoutineDefinitionSchema.safeParse({ ...brief, schedule, webhook: { ...webhook, unknown: true } }).success).toBe(false);
    expect(RoutineDefinitionSchema.safeParse({ ...brief, schedule, webhook: { ...webhook, path: '/../outside' } }).success).toBe(false);
  });
});

describe('independent wake-method patches', () => {
  it('leaves omitted methods absent from the patch rather than adding defaults', () => {
    expect(RoutinePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(RoutinePatchSchema.parse({ schedule: null })).toEqual({ schedule: null });
    expect(RoutinePatchSchema.parse({ webhook: null })).toEqual({ webhook: null });
  });

  it('changes a schedule without changing webhook events or signature configuration', () => {
    const input = RoutineDefinitionSchema.parse({ ...brief, schedule, webhook });
    const nextSchedule = { kind: 'cron' as const, expr: '0 8 * * 1-5', tz: 'UTC' };
    const changed = applyRoutinePatch(input, RoutinePatchSchema.parse({ schedule: nextSchedule }));
    expect(changed).toMatchObject({ schedule: nextSchedule, webhook });
  });

  it('changes app updates without resetting the schedule', () => {
    const input = RoutineDefinitionSchema.parse({ ...brief, schedule, webhook });
    const nextWebhook = { kind: 'webhook' as const, path: '/new' };
    const changed = applyRoutinePatch(input, RoutinePatchSchema.parse({ webhook: nextWebhook }));
    expect(changed).toMatchObject({ schedule, webhook: nextWebhook });
    expect(changed.webhook).not.toHaveProperty('events');
    expect(changed.webhook).not.toHaveProperty('hmac');
  });

  it.each([
    { patch: { schedule: null }, expected: { schedule: null, webhook } },
    { patch: { webhook: null }, expected: { schedule, webhook: null } },
  ])('removes one method while preserving the other %#', ({ patch, expected }) => {
    const input = RoutineDefinitionSchema.parse({ ...brief, schedule, webhook });
    expect(applyRoutinePatch(input, RoutinePatchSchema.parse(patch))).toEqual({ ...brief, ...expected });
  });

  it('refuses removing the last wake method after merging', () => {
    const input = RoutineDefinitionSchema.parse({ ...brief, schedule, webhook: null });
    expect(() => applyRoutinePatch(input, RoutinePatchSchema.parse({ schedule: null }))).toThrow();
  });

  it.each([
    { legacy: schedule, expected: { schedule, webhook: null } },
    { legacy: webhook, expected: { schedule: null, webhook } },
  ])('keeps an old trigger patch exclusive instead of making it additive %#', ({ legacy, expected }) => {
    const patch = RoutinePatchSchema.parse({ trigger: legacy });
    expect(patch).toEqual(expected);
    const input = RoutineDefinitionSchema.parse({ ...brief, schedule, webhook });
    expect(applyRoutinePatch(input, patch)).toEqual({ ...brief, ...expected });
  });

  it.each([
    { trigger: schedule, schedule },
    { trigger: webhook, webhook },
    { trigger: schedule, webhook: null },
    { trigger: webhook, schedule: null },
  ])('refuses mixed legacy and canonical patch keys %#', input => {
    expect(RoutinePatchSchema.safeParse(input).success).toBe(false);
  });
});

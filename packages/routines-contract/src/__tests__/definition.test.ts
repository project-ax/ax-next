import { describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import * as contract from '../index.js';
import {
  ActiveHoursSchema, RoutineDefinitionSchema, RoutinePatchSchema, RoutineViewSchema,
  RoutineCreateInputSchema, RoutineSecretInputSchema, RoutineUpdateInputSchema,
  RoutineToolInputSchemas, RoutineToolJsonSchemas, RoutineRecentFiresOutputSchema,
  RoutineUpsertDefaultInputSchema, RoutineGetDefaultOutputSchema,
  applyRoutinePatch, durationToSeconds, routineToolKind, validateWebhookPath,
} from '../index.js';

const base = {
  name: 'Morning brief', description: 'Catch up', promptBody: 'first\nsecond\n', enabled: true,
  trigger: { kind: 'interval' as const, every: '1h' }, activeHours: null,
  silenceToken: null, silenceMaxChars: 300, conversation: 'per-fire' as const,
  kind: 'repeat' as const, goodWhen: null,
};
const webhook = (extra = {}) => ({ ...base, trigger: { kind: 'webhook', path: '/github', ...extra } });

describe('editable definitions', () => {
  it('fills only create defaults and preserves prompt bytes', () => {
    expect(RoutineDefinitionSchema.parse({ name: base.name, promptBody: base.promptBody, trigger: base.trigger }))
      .toEqual({ ...base, description: '' });
    expect(RoutinePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
  it('replaces nested objects and preserves omitted fields and prompt bytes', () => {
    const changed = applyRoutinePatch(base, {
      trigger: { kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/New_York' },
      activeHours: { start: '22:00', end: '24:00', tz: 'UTC' },
    });
    expect(changed.promptBody).toBe('first\nsecond\n');
    expect(changed.trigger).toEqual({ kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/New_York' });
    expect(applyRoutinePatch(changed, { activeHours: null }).activeHours).toBeNull();
    expect(applyRoutinePatch({ ...base, silenceToken: 'quiet' }, { silenceToken: null }).silenceToken).toBeNull();
  });
  it.each([
    base,
    { ...base, trigger: { kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/New_York' }, activeHours: { start: '22:00', end: '06:00', tz: 'Europe/London' } },
    webhook({ events: ['push', 'release_v2'], hmac: { header: 'X-Hub-Signature-256', algorithm: 'sha256', prefix: 'sha256=' } }),
  ])('round-trips every editable field %#', value => {
    expect(RoutineDefinitionSchema.parse(value)).toEqual(value);
    expect(applyRoutinePatch(base, value)).toEqual(value);
  });
  it('replaces optional webhook fields rather than deep merging', () => {
    const current = RoutineDefinitionSchema.parse(webhook({ events: ['push'], hmac: { header: 'X-Sig' } }));
    expect(applyRoutinePatch(current, { trigger: { kind: 'webhook', path: '/new' } }).trigger).toEqual({ kind: 'webhook', path: '/new' });
  });
  it.each([{}, { name: undefined }, { ownerUserId: 'u' }, { trigger: { kind: 'cron', expr: '* * * * *' } }, { activeHours: { start: '12:00' } }, { enabled: null }])('rejects empty, protected and incomplete patches %#', patch => {
    expect(RoutinePatchSchema.safeParse(patch).success).toBe(false);
  });
  it.each([null, [], 0, 'routine', { ...base, protected: true }, { ...base, trigger: { ...base.trigger, unknown: true } }])('rejects invalid JSON-like definitions %#', value => {
    expect(RoutineDefinitionSchema.safeParse(value).success).toBe(false);
  });
  it('rejects webhook active hours after merging patches', () => {
    const current = { ...base, activeHours: { start: '12:00', end: '13:00', tz: 'UTC' } };
    expect(() => applyRoutinePatch(current, { trigger: { kind: 'webhook', path: '/hook' } })).toThrow();
    expect(applyRoutinePatch(current, { trigger: { kind: 'webhook', path: '/hook' }, activeHours: null }).activeHours).toBeNull();
  });
  it.each([
    ['name', 'a'.repeat(128), 'a'.repeat(129)], ['description', 'a'.repeat(2048), 'a'.repeat(2049)],
    ['silenceToken', 'a'.repeat(128), 'a'.repeat(129)], ['silenceMaxChars', 65536, 65537],
    ['silenceMaxChars', 0, -1], ['silenceMaxChars', 1, 1.5], ['name', 'a', ''],
  ])('enforces %s bounds', (field, valid, invalid) => {
    expect(RoutineDefinitionSchema.safeParse({ ...base, [field]: valid }).success).toBe(true);
    expect(RoutineDefinitionSchema.safeParse({ ...base, [field]: invalid }).success).toBe(false);
  });
  it('limits the complete serialized definition to 64 KiB UTF-8', () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ ...base, promptBody: '' })).length;
    expect(RoutineDefinitionSchema.safeParse({ ...base, promptBody: 'a'.repeat(65536 - overhead) }).success).toBe(true);
    expect(RoutineDefinitionSchema.safeParse({ ...base, promptBody: 'a'.repeat(65537 - overhead) }).success).toBe(false);
    expect(RoutineDefinitionSchema.safeParse({ ...base, promptBody: '😀'.repeat(18000) }).success).toBe(false);
    expect(RoutinePatchSchema.safeParse({ promptBody: '😀'.repeat(18000) }).success).toBe(false);
  });
});

describe('triggers and timing', () => {
  it.each([['60s', 60], ['1m', 60], ['1h', 3600], ['1d', 86400], ['00060s', 60]])('converts %s', (value, seconds) => expect(durationToSeconds(value)).toBe(seconds));
  it.each(['59s', '0m', '-1h', '1.5m', '1H', ' 1h', '1h ', '1w', '9007199254740992d', '8640000000000s'])('rejects invalid interval %s', value => {
    expect(durationToSeconds(value)).toBeNull();
    expect(RoutineDefinitionSchema.safeParse({ ...base, trigger: { kind: 'interval', every: value } }).success).toBe(false);
  });
  it('checks valid next-date overflow at the exact boundary', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      expect(durationToSeconds('8640000000000s')).toBe(8640000000000);
      expect(durationToSeconds('8640000000001s')).toBeNull();
    } finally { vi.restoreAllMocks(); }
  });
  it.each(['America/New_York', 'Europe/London', 'UTC'])('accepts timezone/DST cron syntax for %s', tz => {
    expect(RoutineDefinitionSchema.safeParse({ ...base, trigger: { kind: 'cron', expr: '0 2 * * *', tz } }).success).toBe(true);
  });
  it.each([{ expr: 'invalid', tz: 'UTC' }, { expr: '* * * * *', tz: 'Fake/Timezone' }, { expr: 'a'.repeat(257), tz: 'UTC' }])('rejects invalid cron %#', trigger => {
    expect(RoutineDefinitionSchema.safeParse({ ...base, trigger: { kind: 'cron', ...trigger } }).success).toBe(false);
  });
  it('accepts a cron expression at its text limit', () => {
    const expr = ['00', ...Array(123).fill('0')].join(',') + ' * * * *';
    expect(expr.length).toBe(256);
    expect(RoutineDefinitionSchema.safeParse({ ...base, trigger: { kind: 'cron', expr, tz: 'UTC' } }).success).toBe(true);
    expect(RoutineDefinitionSchema.safeParse({ ...base, trigger: { kind: 'cron', expr: Array(125).fill('0').join(',') + ' * * * *', tz: 'UTC' } }).success).toBe(false);
  });
  it('validates cron syntax without starting a scheduler', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      RoutineDefinitionSchema.parse({ ...base, trigger: { kind: 'cron', expr: '0 2 * * *', tz: 'America/New_York' } });
      expect(timer).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); }
  });
  it.each([{ start: '24:00', end: '06:00', tz: 'UTC' }, { start: '00:00', end: '24:01', tz: 'UTC' }, { start: '9:00', end: '12:00', tz: 'UTC' }, { start: '10:00', end: '12:00', tz: 'bad' }])('rejects invalid active hours %#', value => expect(ActiveHoursSchema.safeParse(value).success).toBe(false));
});

describe('webhooks', () => {
  it.each(['/../a', '/a//b', '/a/', '/%61', '/webhooks/a', '/a?token=x', '/', '/./a', '/a#b', '/a\\b', '/a b', '/日本語', '/a\n'])('rejects %s', path => {
    expect(validateWebhookPath(path)).toBe(false);
    expect(RoutineDefinitionSchema.safeParse(webhook({ path })).success).toBe(false);
  });
  it.each(['/a', '/github/events-v2.json', '/a_b', '/webhooks-other', '/' + 'a'.repeat(127)])('accepts %s', path => expect(validateWebhookPath(path)).toBe(true));
  it('enforces webhook path, event and HMAC limits', () => {
    expect(validateWebhookPath('/' + 'a'.repeat(128))).toBe(false);
    expect(RoutineDefinitionSchema.safeParse(webhook({ events: Array(32).fill('a'.repeat(64)), hmac: { header: 'a'.repeat(128), prefix: 'a'.repeat(128) } })).success).toBe(true);
    for (const extra of [{ events: Array(33).fill('push') }, { events: ['a'.repeat(65)] }, { events: [''] }, { events: ['bad.event'] }, { hmac: { header: 'a'.repeat(129) } }, { hmac: { header: 'X-Sig', prefix: 'a'.repeat(129) } }]) {
      expect(RoutineDefinitionSchema.safeParse(webhook(extra)).success).toBe(false);
    }
  });
  it.each(['', 'X Sig', 'X:Sig', 'X\r\nInjected', '日本語'])('rejects malformed HMAC header %s', header => expect(RoutineDefinitionSchema.safeParse(webhook({ hmac: { header } })).success).toBe(false));
  it('defaults algorithm and supports both HMAC options without accepting credentials', () => {
    expect(RoutineDefinitionSchema.parse(webhook({ hmac: { header: 'X-Sig' } })).trigger).toEqual({ kind: 'webhook', path: '/github', hmac: { header: 'X-Sig', algorithm: 'sha256' } });
    expect(RoutineDefinitionSchema.safeParse(webhook({ hmac: { header: 'X-Sig', algorithm: 'sha1', prefix: '' } })).success).toBe(true);
    for (const hmac of [{ header: 'X-Sig', algorithm: 'md5' }, { header: 'X-Sig', secretRef: 'private' }, { header: 'X-Sig', secret: 'private' }]) expect(RoutineDefinitionSchema.safeParse(webhook({ hmac })).success).toBe(false);
  });
});

describe('public services and tools', () => {
  const view = { ...base, agentId: 'a', routineId: 'legacy/default.id', revision: 'opaque revision', origin: 'authored', defaultRoutineId: null, nextRunAt: '2026-10-09T12:00:00.000Z', lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null, permissions: { edit: true, stop: true, fire: true, manageSecret: false } };
  it('round-trips the full view and forbids protected state and Date objects', () => {
    expect(RoutineViewSchema.parse(view)).toEqual(view);
    for (const extra of [{ ownerUserId: 'u' }, { specHash: 'hash' }, { nextRunAt: new Date() }, { nextRunAt: 'not-a-date' }, { permissions: { ...view.permissions, isAdmin: true } }]) expect(RoutineViewSchema.safeParse({ ...view, ...extra }).success).toBe(false);
  });
  it('bounds IDs, revisions and logical request IDs without parsing encoding', () => {
    const input = { agentId: 'opaque agent/value', routineId: 'legacy/default.id', requestId: 'retry opaque', expectedRevision: 'revision +/= !', patch: { enabled: false } };
    expect(RoutineUpdateInputSchema.parse(input)).toEqual(input);
    for (const key of ['agentId', 'routineId', 'requestId', 'expectedRevision']) for (const value of ['', 'a'.repeat(257)]) expect(RoutineUpdateInputSchema.safeParse({ ...input, [key]: value }).success).toBe(false);
    expect(RoutineCreateInputSchema.safeParse({ agentId: 'a', requestId: 'r', definition: base, actorUserId: 'u' }).success).toBe(false);
  });
  it('bounds secret bytes and validates the strict set/delete union', () => {
    const key = { agentId: 'a', routineId: 'r', expectedRevision: 'rev' };
    expect(RoutineSecretInputSchema.parse({ ...key, operation: 'set', secret: new Uint8Array(65536) }).secret).toBeDefined();
    expect(RoutineSecretInputSchema.parse({ ...key, operation: 'delete' })).toEqual({ ...key, operation: 'delete' });
    for (const input of [{ ...key, operation: 'set', secret: new Uint8Array(0) }, { ...key, operation: 'set', secret: new Uint8Array(65537) }, { ...key, operation: 'set', secret: 'private' }, { ...key, operation: 'delete', secret: new Uint8Array(1) }]) expect(RoutineSecretInputSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    ['routine_list', {}, 'read'], ['routine_get', { routineId: 'r' }, 'read'],
    ['routine_create', { requestId: 'req', definition: base }, 'write'],
    ['routine_update', { routineId: 'r', requestId: 'req', expectedRevision: 'rev', patch: { enabled: false } }, 'write'],
    ['routine_delete', { routineId: 'r', requestId: 'req', expectedRevision: 'rev' }, 'write'],
    ['routine_fire_now', { routineId: 'r', requestId: 'req', expectedRevision: 'rev' }, 'write'],
  ] as const)('strictly validates %s without caller identity', (name, input, kind) => {
    expect(RoutineToolInputSchemas[name].parse(input)).toEqual(input);
    expect(routineToolKind(name)).toBe(kind);
    for (const field of ['agentId', 'ownerUserId', 'isAdmin', 'source', 'payload']) expect(RoutineToolInputSchemas[name].safeParse({ ...input, [field]: 'injected' }).success).toBe(false);
    expect(RoutineToolJsonSchemas[name]).toMatchObject({ type: 'object', additionalProperties: false });
  });
  it('does not classify prototype names or other tools as routine tools', () => {
    for (const name of ['routine_unknown', 'constructor', 'toString', '__proto__', 'Bash']) expect(routineToolKind(name)).toBeNull();
  });
  it('round-trips canonical interval defaults while retaining omitted enabled', () => {
    const { enabled: _enabled, ...input } = base;
    expect(RoutineUpsertDefaultInputSchema.parse(input)).toEqual(input);
    expect(RoutineGetDefaultOutputSchema.parse({ ...base, defaultRoutineId: 'default.legacy', updatedAt: '2026-10-09T00:00:00.000Z' })).toEqual({ ...base, defaultRoutineId: 'default.legacy', updatedAt: '2026-10-09T00:00:00.000Z' });
    expect(RoutineUpsertDefaultInputSchema.safeParse({ ...input, trigger: { kind: 'cron', expr: '* * * * *', tz: 'UTC' } }).success).toBe(false);
    expect(RoutineUpsertDefaultInputSchema.safeParse({ ...input, sourceMd: 'legacy' }).success).toBe(false);
  });
  it('round-trips history as ISO strings without row IDs', () => {
    const fire = { agentId: 'a', routineId: 'r', firedAt: '2026-10-09T00:00:00.000Z', triggerSource: 'manual', conversationId: 'c', status: 'silenced', error: null, renderedPrompt: 'first\nsecond\n', warning: 'Unavailable connector' };
    expect(RoutineRecentFiresOutputSchema.parse({ fires: [fire] })).toEqual({ fires: [fire] });
    expect(RoutineRecentFiresOutputSchema.safeParse({ fires: [{ ...fire, id: 1 }] }).success).toBe(false);
  });
  it('validates all strict service inputs and outputs without wrappers', () => {
    const key = { agentId: 'a', routineId: 'r' };
    const mutation = { ...key, requestId: 'request', expectedRevision: 'revision' };
    const defaultSummary = { defaultRoutineId: 'default', name: base.name, description: base.description, trigger: base.trigger, enabled: true, updatedAt: '2026-10-09T00:00:00.000Z' };
    const cases = [
      [contract.RoutineListInputSchema, { agentId: 'a' }], [contract.RoutineGetInputSchema, key],
      [contract.RoutineListOutputSchema, { routines: [view] }], [contract.RoutineGetOutputSchema, view],
      [contract.RoutineCreateInputSchema, { agentId: 'a', requestId: 'request', definition: base }], [contract.RoutineCreateOutputSchema, view],
      [contract.RoutineUpdateInputSchema, { ...mutation, patch: { enabled: false } }], [contract.RoutineUpdateOutputSchema, view],
      [contract.RoutineDeleteInputSchema, mutation], [contract.RoutineDeleteOutputSchema, { deleted: true, cleanupPending: false }],
      [contract.RoutineFireNowInputSchema, mutation], [contract.RoutineFireNowOutputSchema, { status: 'error' }],
      [contract.RoutineSecretOutputSchema, { saved: true }],
      [contract.RoutineRecentFiresInputSchema, { ...key, limit: 200 }],
      [contract.RoutineRecentFiresForAgentInputSchema, { agentId: 'a', limit: 1, before: '2026-10-09T00:00:00.000Z' }],
      [contract.RoutineRecentFiresForAgentOutputSchema, { fires: [] }],
      [contract.RoutineListDefaultsInputSchema, {}], [contract.RoutineListDefaultsOutputSchema, { defaults: [defaultSummary] }],
      [contract.RoutineGetDefaultInputSchema, { defaultRoutineId: 'default' }],
      [contract.RoutineUpsertDefaultOutputSchema, { defaultRoutineId: 'default', created: false }],
      [contract.RoutineDeleteDefaultInputSchema, { defaultRoutineId: 'default' }], [contract.RoutineDeleteDefaultOutputSchema, {}],
      [contract.RoutineSetAgentDefaultEnabledInputSchema, { agentId: 'a', defaultRoutineId: 'default', enabled: false }],
      [contract.RoutineSetAgentDefaultEnabledOutputSchema, {}], [contract.RoutineListAgentDefaultsInputSchema, { agentId: 'a' }],
      [contract.RoutineListAgentDefaultsOutputSchema, { defaults: [{ defaultRoutineId: 'default', name: 'Morning brief', enabled: false }] }],
    ] as const;
    for (const [schema, value] of cases) {
      expect(schema.parse(value)).toEqual(value);
      expect(schema.safeParse({ ...value, untrustedField: 'secret' }).success).toBe(false);
    }
    expect(contract.RoutineGetOutputSchema.safeParse({ routine: view }).success).toBe(false);
    expect(contract.RoutineFireNowOutputSchema.safeParse({ status: 'silenced' }).success).toBe(false);
    for (const value of [0, 201, 1.5]) expect(contract.RoutineRecentFiresInputSchema.safeParse({ ...key, limit: value }).success).toBe(false);
  });
  it('keeps JSON schema fields and required keys aligned with runtime tools', () => {
    for (const name of Object.keys(RoutineToolInputSchemas) as (keyof typeof RoutineToolInputSchemas)[]) {
      const runtime = RoutineToolInputSchemas[name];
      const json = RoutineToolJsonSchemas[name];
      expect(Object.keys(json.properties).sort()).toEqual(Object.keys(runtime.shape).sort());
      const required = Object.entries(runtime.shape).filter(([, field]) => !field.isOptional()).map(([name]) => name).sort();
      expect(('required' in json ? [...json.required] : []).sort()).toEqual(required);
    }
    expect(Object.keys(contract.RoutineDefinitionJsonSchema.properties).sort()).toEqual(Object.keys(contract.RoutineEditableShape).sort());
    expect(Object.keys(contract.RoutinePatchJsonSchema.properties).sort()).toEqual(Object.keys(contract.RoutineEditableShape).sort());
    expect(contract.RoutinePatchJsonSchema).toMatchObject({ minProperties: 1, additionalProperties: false });
    expect(JSON.stringify(contract.RoutinePatchJsonSchema.properties)).not.toContain('"default":true');
  });
  it('bundles the public entry for browsers without Node or plugin imports', async () => {
    const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, lib: { entry: new URL('../index.ts', import.meta.url).pathname, formats: ['es'] } } });
    const outputs = Array.isArray(result) ? result : [result];
    for (const output of outputs) if ('output' in output) for (const item of output.output) if (item.type === 'chunk') expect(item.code).not.toMatch(/(?:node:|@ax\/core|__vite-browser-external)/);
  });
});

describe('task kinds (TASK-906)', () => {
  const task = {
    ...base, kind: 'stay-on-top' as const, goodWhen: 'No ticket stays open longer than an hour.',
    trigger: { kind: 'interval' as const, every: '15m' },
  };
  const view = {
    ...task, agentId: 'a', routineId: 'r', revision: 'rev', origin: 'authored', defaultRoutineId: null,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null,
    permissions: { edit: true, stop: true, fire: true, manageSecret: false },
  };

  it('defaults kind to repeat and goodWhen to null', () => {
    expect(RoutineDefinitionSchema.parse({ name: base.name, promptBody: base.promptBody, trigger: base.trigger }))
      .toMatchObject({ kind: 'repeat', goodWhen: null });
  });

  it.each([
    task,
    { ...task, trigger: { kind: 'interval', every: '900s' } },
    { ...task, trigger: { kind: 'interval', every: '1h' } },
    { ...task, trigger: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' } },
    { ...task, trigger: { kind: 'cron', expr: '*/15 * * * *', tz: 'UTC' } },
    { ...task, trigger: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/New_York' } },
  ])('accepts a stay-on-top task at the floor %#', value => {
    expect(RoutineDefinitionSchema.parse(value)).toEqual(value);
  });

  it.each([
    [{ ...base, goodWhen: 'x' }, ['goodWhen']],
    [{ ...task, goodWhen: null }, ['goodWhen']],
    [{ ...task, goodWhen: '   ' }, ['goodWhen']],
    [{ ...task, goodWhen: 'a'.repeat(1025) }, ['goodWhen']],
    [{ ...task, trigger: { kind: 'webhook', path: '/zendesk' } }, ['trigger']],
    [{ ...task, conversation: 'shared' }, ['conversation']],
    [{ ...task, silenceToken: 'ALL_GOOD' }, ['silenceToken']],
    [{ ...task, trigger: { kind: 'interval', every: '14m' } }, ['trigger', 'every']],
    [{ ...task, trigger: { kind: 'interval', every: '899s' } }, ['trigger', 'every']],
    [{ ...task, trigger: { kind: 'cron', expr: '*/10 * * * *', tz: 'UTC' } }, ['trigger', 'expr']],
    [{ ...task, trigger: { kind: 'cron', expr: '*/14 * * * *', tz: 'UTC' } }, ['trigger', 'expr']],
    [{ ...task, trigger: { kind: 'cron', expr: '*/30 * * * * *', tz: 'UTC' } }, ['trigger', 'expr']],
  ] as const)('rejects each per-kind rule with a field path %#', (value, path) => {
    const result = RoutineDefinitionSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(i => i.path)).toContainEqual([...path]);
  });

  it('words the check-in floor in plain words', () => {
    const result = RoutineDefinitionSchema.safeParse({ ...task, trigger: { kind: 'interval', every: '14m' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.find(i => i.path.join('.') === 'trigger.every')?.message)
        .toBe('Check-ins need to be at least 15 minutes apart.');
    }
  });

  it('repeat keeps everything it allows today', () => {
    expect(RoutineDefinitionSchema.safeParse({ ...base, trigger: { kind: 'interval', every: '60s' } }).success).toBe(true);
    expect(RoutineDefinitionSchema.safeParse({
      ...base, trigger: { kind: 'webhook', path: '/zendesk' }, silenceToken: 'OK', conversation: 'shared',
    }).success).toBe(true);
  });

  it('the cron floor gives the same verdict whatever the clock says', () => {
    const crons = [
      { expr: '0 * * * *', tz: 'UTC' }, { expr: '*/10 * * * *', tz: 'UTC' },
      { expr: '0,50 1,3 * * *', tz: 'America/New_York' }, { expr: '0 0 29 2 *', tz: 'UTC' },
    ];
    const verdicts = (now: Date): boolean[] => {
      vi.useFakeTimers({ now });
      try {
        return crons.map(trigger => RoutineDefinitionSchema.safeParse({ ...task, trigger: { kind: 'cron', ...trigger } }).success);
      } finally { vi.useRealTimers(); }
    };
    const first = verdicts(new Date('2026-03-08T06:30:00Z'));
    const second = verdicts(new Date('2031-07-01T00:00:00Z'));
    expect(second).toEqual(first);
    expect(first[2]).toBe(true);
  });

  it('checks the floor without starting a scheduler', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      RoutineDefinitionSchema.parse({ ...task, trigger: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' } });
      expect(timer).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); }
  });

  it('revalidates kind rules after a patch merges', () => {
    expect(() => applyRoutinePatch(task, { trigger: { kind: 'webhook', path: '/x' } })).toThrow();
    expect(() => applyRoutinePatch(task, { kind: 'repeat' })).toThrow();
    expect(applyRoutinePatch(task, { kind: 'repeat', goodWhen: null }).kind).toBe('repeat');
    expect(applyRoutinePatch(base, { kind: 'stay-on-top', goodWhen: 'x' }).kind).toBe('stay-on-top');
  });

  it('RoutinePatchSchema accepts kind and a goodWhen clear', () => {
    expect(RoutinePatchSchema.safeParse({ goodWhen: null }).success).toBe(true);
    expect(RoutinePatchSchema.safeParse({ kind: 'stay-on-top' }).success).toBe(true);
  });

  it('views require kind and goodWhen and recheck them', () => {
    expect(RoutineViewSchema.parse(view)).toEqual(view);
    const { kind: _kind, ...withoutKind } = view;
    expect(RoutineViewSchema.safeParse(withoutKind).success).toBe(false);
    expect(RoutineViewSchema.safeParse({ ...view, trigger: { kind: 'webhook', path: '/x' } }).success).toBe(false);
  });

  it('default routines stay repeat', () => {
    const { enabled: _enabled, ...input } = task;
    expect(RoutineUpsertDefaultInputSchema.safeParse({ ...input, trigger: { kind: 'interval', every: '1h' } }).success).toBe(false);
    const detail = { ...task, trigger: { kind: 'interval', every: '1h' }, defaultRoutineId: 'd', updatedAt: '2026-10-09T00:00:00.000Z' };
    expect(RoutineGetDefaultOutputSchema.safeParse(detail).success).toBe(false);
    const { kind: _k, ...noKind } = { ...base, defaultRoutineId: 'd', updatedAt: '2026-10-09T00:00:00.000Z' };
    expect(RoutineGetDefaultOutputSchema.safeParse(noKind).success).toBe(false);
  });

  it('the JSON schema offers both fields', () => {
    expect(contract.RoutineDefinitionJsonSchema.properties.kind).toMatchObject({ enum: ['repeat', 'stay-on-top'], default: 'repeat' });
    expect(contract.RoutineDefinitionJsonSchema.properties.goodWhen).toMatchObject({ default: null });
  });
});

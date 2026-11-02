import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import {
  RoutineCreateToolInputSchema, RoutineDefinitionSchema, RoutinePatchSchema, RoutineToolJsonSchemas, RoutineUpdateToolInputSchema,
  WebhookHmacSchema,
} from '../index.js';

const advertisedCreate = new Ajv({ strict: false }).compile(RoutineToolJsonSchemas.routine_create);
const advertisedUpdate = new Ajv({ strict: false }).compile(RoutineToolJsonSchemas.routine_update);

describe('webhook app signing settings', () => {
  it.each(['stripe', 'slack', 'zendesk'] as const)('round-trips %s without custom overrides', app => {
    const webhook = { kind: 'webhook', path: '/updates', hmac: { app } };
    expect(RoutineDefinitionSchema.parse({ name: 'Updates', promptBody: 'Review', schedule: null, webhook }).webhook).toEqual(webhook);
    expect(RoutinePatchSchema.parse({ webhook })).toEqual({ webhook });
    expect(WebhookHmacSchema.safeParse({ app, header: 'anything' }).success).toBe(false);
    expect(WebhookHmacSchema.safeParse({ app, algorithm: 'sha1' }).success).toBe(false);
    expect(WebhookHmacSchema.safeParse({ app, prefix: 'anything' }).success).toBe(false);
  });
  it('preserves legacy custom defaults and rejects unknown protocols and secret-bearing settings', () => {
    expect(WebhookHmacSchema.parse({ header: 'X-Signature' })).toEqual({ header: 'X-Signature', algorithm: 'sha256' });
    expect(WebhookHmacSchema.parse({ header: 'sig', algorithm: 'sha1', prefix: 'sha1=' })).toEqual({ header: 'sig', algorithm: 'sha1', prefix: 'sha1=' });
    for (const value of [{ app: 'unknown' }, { app: 'stripe', secret: 'private' }, { app: 'slack', secretRef: 'private' }, {}]) {
      expect(WebhookHmacSchema.safeParse(value).success).toBe(false);
    }
  });
});

// TASK-1026: the host detects the signing format, and a person pastes the secret on the task page.
// Settings saved before then still parse everywhere, but an agent neither sees nor sends them.
describe('signature settings on the agent tool surface', () => {
  const plain = { kind: 'webhook', path: '/updates' };
  const legacySettings = [{ app: 'stripe' }, { header: 'X-Signature' }] as const;
  const create = (definition: Record<string, unknown>) => ({ requestId: 'create-updates', definition: { name: 'Updates', promptBody: 'Review', ...definition } });
  const update = (patch: Record<string, unknown>) => ({ routineId: 'routine', requestId: 'edit-updates', expectedRevision: 'revision', patch });
  const issuePaths = (result: { success: boolean; error?: { issues: Array<{ path: Array<string | number> }> } }) =>
    result.error?.issues.map(issue => issue.path) ?? [];

  it('stops advertising signature settings', () => {
    // Every create alternative that takes app updates: webhook-only repeat, schedule plus webhook, and a task.
    const methods = [
      { schedule: null }, { schedule: { kind: 'interval', every: '1h' } },
      { kind: 'stay-on-top', goodWhen: 'No update waits.', schedule: { kind: 'interval', every: '1h' } },
    ];
    for (const method of methods) {
      for (const hmac of legacySettings) {
        expect(advertisedCreate(create({ ...method, webhook: { ...plain, hmac } })), JSON.stringify({ method, hmac })).toBe(false);
      }
      expect(advertisedCreate(create({ ...method, webhook: plain })), JSON.stringify(advertisedCreate.errors)).toBe(true);
    }
    for (const hmac of legacySettings) expect(advertisedUpdate(update({ webhook: { ...plain, hmac } })), JSON.stringify(hmac)).toBe(false);
    expect(advertisedUpdate(update({ webhook: plain })), JSON.stringify(advertisedUpdate.errors)).toBe(true);
    // Nothing on the tools' input schemas names a signature setting or the apps the old picker offered.
    expect(JSON.stringify(RoutineToolJsonSchemas)).not.toMatch(/hmac|"app"|stripe|slack|zendesk/i);
  });

  it('refuses signature settings from an agent but still parses saved ones', () => {
    for (const hmac of legacySettings) {
      const webhook = { ...plain, hmac };
      // Refused, not dropped: an agent that sent one must not believe it set up verification.
      for (const definition of [{ schedule: null, webhook }, { trigger: webhook }]) {
        const created = RoutineCreateToolInputSchema.safeParse(create(definition));
        expect(created.success, JSON.stringify(definition)).toBe(false);
        expect(issuePaths(created)).toEqual([['definition', 'webhook', 'hmac']]);
      }
      // The legacy `trigger` form normalizes to `webhook`, so it's refused at the same path.
      for (const patch of [{ webhook }, { trigger: webhook }]) {
        const edited = RoutineUpdateToolInputSchema.safeParse(update(patch));
        expect(edited.success, JSON.stringify(patch)).toBe(false);
        expect(issuePaths(edited)).toEqual([['patch', 'webhook', 'hmac']]);
      }
      // Saved tasks, receipts and a person's own edits keep both legacy shapes.
      const saved = { ...plain, hmac: WebhookHmacSchema.parse(hmac) };
      expect(RoutineDefinitionSchema.parse({ name: 'Updates', promptBody: 'Review', schedule: null, webhook }).webhook).toEqual(saved);
      expect(RoutinePatchSchema.parse({ webhook })).toEqual({ webhook: saved });
    }
    expect(RoutineCreateToolInputSchema.safeParse(create({ schedule: null, webhook: plain })).success).toBe(true);
    expect(RoutineUpdateToolInputSchema.safeParse(update({ webhook: plain })).success).toBe(true);
    expect(RoutineUpdateToolInputSchema.safeParse(update({ webhook: null })).success).toBe(true);
  });
});

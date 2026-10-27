import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { RoutineDefinitionSchema, RoutinePatchSchema, RoutineToolJsonSchemas, WebhookHmacSchema } from '../index.js';

const advertisedCreate = new Ajv({ strict: false }).compile(RoutineToolJsonSchemas.routine_create);

describe('webhook app signing settings', () => {
  it.each(['stripe', 'slack', 'zendesk'] as const)('round-trips %s without custom overrides', app => {
    const webhook = { kind: 'webhook', path: '/updates', hmac: { app } };
    expect(RoutineDefinitionSchema.parse({ name: 'Updates', promptBody: 'Review', schedule: null, webhook }).webhook).toEqual(webhook);
    expect(RoutinePatchSchema.parse({ webhook })).toEqual({ webhook });
    const create = (hmac: unknown) => ({ requestId: 'app-signature', definition: { name: 'Updates', promptBody: 'Review', schedule: null, webhook: { ...webhook, hmac } } });
    expect(advertisedCreate(create({ app })), JSON.stringify(advertisedCreate.errors)).toBe(true);
    expect(advertisedCreate(create({ app, header: 'anything' }))).toBe(false);
    expect(advertisedCreate(create({ app: 'unknown' }))).toBe(false);
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

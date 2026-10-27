import { describe, expect, it } from 'vitest';
import { RoutineDefinitionSchema, RoutinePatchSchema, RoutineDefinitionJsonSchema, WebhookHmacSchema } from '../index.js';

describe('webhook app signing settings', () => {
  it.each(['stripe', 'slack', 'zendesk'] as const)('round-trips %s without custom overrides', app => {
    const webhook = { kind: 'webhook', path: '/updates', hmac: { app } };
    expect(RoutineDefinitionSchema.parse({ name: 'Updates', promptBody: 'Review', schedule: null, webhook }).webhook).toEqual(webhook);
    expect(RoutinePatchSchema.parse({ webhook })).toEqual({ webhook });
    expect(WebhookHmacSchema.safeParse({ app, header: 'anything' }).success).toBe(false);
    expect(WebhookHmacSchema.safeParse({ app, algorithm: 'sha1' }).success).toBe(false);
    expect(WebhookHmacSchema.safeParse({ app, prefix: 'anything' }).success).toBe(false);
    const json = RoutineDefinitionJsonSchema.properties.webhook.anyOf[0].properties.hmac;
    expect(json.oneOf[1]).toEqual({ type: 'object', additionalProperties: false, required: ['app'], properties: {
      app: { type: 'string', enum: ['stripe', 'slack', 'zendesk'], description: expect.any(String) },
    } });
  });
  it('preserves legacy custom defaults and rejects unknown protocols and secret-bearing settings', () => {
    expect(WebhookHmacSchema.parse({ header: 'X-Signature' })).toEqual({ header: 'X-Signature', algorithm: 'sha256' });
    expect(WebhookHmacSchema.parse({ header: 'sig', algorithm: 'sha1', prefix: 'sha1=' })).toEqual({ header: 'sig', algorithm: 'sha1', prefix: 'sha1=' });
    for (const value of [{ app: 'unknown' }, { app: 'stripe', secret: 'private' }, { app: 'slack', secretRef: 'private' }, {}]) {
      expect(WebhookHmacSchema.safeParse(value).success).toBe(false);
    }
  });
});

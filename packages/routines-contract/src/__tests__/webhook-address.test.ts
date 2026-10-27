import { describe, expect, it } from 'vitest';
import { RoutineWebhookAddressInputSchema, RoutineReplaceWebhookAddressInputSchema, RoutineWebhookAddressOutputSchema, RoutineCreateInputSchema } from '../services.js';

describe('owner-only webhook address contracts', () => {
  const key = { agentId: 'a', routineId: 'r' };
  it('requires a bounded current version and refuses caller-supplied identity', () => {
    expect(RoutineWebhookAddressInputSchema.parse(key)).toEqual(key);
    expect(RoutineWebhookAddressInputSchema.safeParse({ ...key, actorUserId: 'owner' }).success).toBe(false);
    expect(RoutineReplaceWebhookAddressInputSchema.safeParse(key).success).toBe(false);
    expect(RoutineReplaceWebhookAddressInputSchema.safeParse({ ...key, expectedVersion: 'a'.repeat(64) }).success).toBe(true);
    expect(RoutineReplaceWebhookAddressInputSchema.safeParse({ ...key, expectedVersion: 'a'.repeat(65) }).success).toBe(false);
  });
  it('keeps tokens out of agent-authored definitions and closes the private output', () => {
    const token = 'rt_' + 'a'.repeat(43);
    expect(RoutineWebhookAddressOutputSchema.parse({ token, version: 'a'.repeat(64), legacyActive: false }).token).toBe(token);
    expect(RoutineWebhookAddressOutputSchema.safeParse({ token, version: 'a'.repeat(64), legacyActive: false, owner: 'owner' }).success).toBe(false);
    expect(RoutineCreateInputSchema.safeParse({ agentId: 'a', requestId: 'new', definition: { name: 'Task', promptBody: 'Run', schedule: null, webhook: { kind: 'webhook', path: '/updates', token } } }).success).toBe(false);
  });
});

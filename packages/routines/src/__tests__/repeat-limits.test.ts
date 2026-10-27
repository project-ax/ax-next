import { describe, expect, it } from 'vitest';
import * as routing from '../webhook-handler.js';
const api = routing as unknown as {
  githubDeliveryId(value: string | undefined): string | null;
  repeatQueueFits(input: { waiting: number; ownerPending: number; ownerBytes: number; incomingBytes: number }): boolean;
};
describe('repeat delivery input and aggregate bounds', () => {
  it('has a bounded ID validator before durable admission', () => {
    expect(api.githubDeliveryId).toBeTypeOf('function');
    expect(api.githubDeliveryId(undefined)).toBeNull();
    expect(api.githubDeliveryId('delivery-1_abc:DEF.9')).toBe('delivery-1_abc:DEF.9');
    expect(api.githubDeliveryId('a'.repeat(128))).toHaveLength(128);
    for (const value of ['', 'a'.repeat(129), ' a', 'a\n', 'a/b', '💥']) expect(() => api.githubDeliveryId(value)).toThrow();
  });
  it('bounds waiting jobs and pending owner bytes across task creation', () => {
    expect(api.repeatQueueFits).toBeTypeOf('function');
    const input = { waiting: 31, ownerPending: 63, ownerBytes: 8 * 1024 * 1024 - 1, incomingBytes: 1 };
    expect(api.repeatQueueFits(input)).toBe(true);
    for (const over of [{ waiting: 32 }, { ownerPending: 64 }, { incomingBytes: 2 }]) expect(api.repeatQueueFits({ ...input, ...over })).toBe(false);
    expect(api.repeatQueueFits({ ...input, incomingBytes: -1 })).toBe(false);
  });
});

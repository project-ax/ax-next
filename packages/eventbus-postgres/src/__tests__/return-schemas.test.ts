import { describe, it, expect } from 'vitest';
import { EventbusSubscriptionSchema, type EventbusSubscription } from '../plugin.js';

// ARCH-13 drift guard for `eventbus:subscribe` (postgres peer — identical to
// the in-process backend, the I2 two-backend pattern). LIVE handle: the
// unsubscribe function must survive by reference.

describe('eventbus-postgres return schemas', () => {
  it('preserves the live unsubscribe function by reference', () => {
    let called = false;
    const unsubscribe = (): void => {
      called = true;
    };
    const sub: EventbusSubscription = { unsubscribe };
    const parsed = EventbusSubscriptionSchema.parse(sub);
    expect(parsed.unsubscribe).toBe(unsubscribe);
    parsed.unsubscribe();
    expect(called).toBe(true);
  });

  it('rejects a non-object return', () => {
    expect(EventbusSubscriptionSchema.safeParse(42).success).toBe(false);
  });
});

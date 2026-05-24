import { describe, it, expect } from 'vitest';
import { EventbusSubscriptionSchema, type EventbusSubscription } from '../plugin.js';

// ARCH-13 drift guard for `eventbus:subscribe`. The result is a LIVE handle
// ({ unsubscribe: () => void }); the .passthrough() schema must preserve the
// function by reference (z.function() would wrap it and break identity — the
// ARCH-6 live-handle trap). `eventbus:emit` returns void, so no schema.

describe('eventbus-inprocess return schemas', () => {
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

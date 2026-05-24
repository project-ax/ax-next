import { describe, it, expect } from 'vitest';
import { HttpRegisterRouteOutputSchema, type HttpRegisterRouteOutput } from '../types.js';

// ARCH-13 drift guard for `http:register-route`. The hook returns a LIVE
// capability handle ({ unregister(): void }); the .passthrough() schema must
// preserve the function by reference — a strict z.object would strip it and
// silently break route lifecycle (the ARCH-6 sandbox:open-session trap). NOTE:
// modeling `unregister` with z.function() would WRAP it in a new proxy and
// break identity, so the schema deliberately does not model the handle.

describe('HttpRegisterRouteOutputSchema', () => {
  it('preserves the live unregister function by reference (and it still runs)', () => {
    let called = false;
    const unregister = (): void => {
      called = true;
    };
    const out: HttpRegisterRouteOutput = { unregister };
    const parsed = HttpRegisterRouteOutputSchema.parse(out);
    // The same function object must survive — NOT a wrapped clone.
    expect((parsed as { unregister: () => void }).unregister).toBe(unregister);
    (parsed as { unregister: () => void }).unregister();
    expect(called).toBe(true);
  });

  it('passes through extra serializable keys alongside the handle', () => {
    const unregister = (): void => {};
    const parsed = HttpRegisterRouteOutputSchema.parse({ unregister, routeId: 'r1' }) as Record<
      string,
      unknown
    >;
    expect(parsed.routeId).toBe('r1');
    expect(parsed.unregister).toBe(unregister);
  });

  it('rejects a non-object return', () => {
    expect(HttpRegisterRouteOutputSchema.safeParse('nope').success).toBe(false);
  });
});

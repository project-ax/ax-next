import { describe, it, expect } from 'vitest';
import {
  BootstrapResetOutputSchema,
  BootstrapStatusOutputSchema,
  type BootstrapResetOutput,
  type BootstrapStatusOutput,
} from '../types.js';

// ARCH-13 drift guard for the data-returning bootstrap:* hooks. completedAt is
// a real Date (z.date()); bootstrap:reset is a discriminated union on `ok`.

describe('onboarding return schemas', () => {
  it('bootstrap:status round-trips a completed status with completedAt (Date)', () => {
    const full: BootstrapStatusOutput = {
      status: 'completed',
      completedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    expect(BootstrapStatusOutputSchema.parse(full)).toEqual(full);
  });

  it('bootstrap:status round-trips a non-terminal status without completedAt', () => {
    const full: BootstrapStatusOutput = { status: 'uninitialized' };
    expect(BootstrapStatusOutputSchema.parse(full)).toEqual(full);
  });

  it('bootstrap:status rejects a string completedAt (handler returns a Date)', () => {
    expect(
      BootstrapStatusOutputSchema.safeParse({ status: 'completed', completedAt: '2026-01-01' })
        .success,
    ).toBe(false);
  });

  it('bootstrap:status rejects an unknown status', () => {
    expect(BootstrapStatusOutputSchema.safeParse({ status: 'half-done' }).success).toBe(false);
  });

  it('bootstrap:reset round-trips the ok=true branch', () => {
    const full: BootstrapResetOutput = {
      ok: true,
      token: 'tok-abc',
      baseUrl: 'http://localhost:8080',
      previousStatus: 'completed',
    };
    expect(BootstrapResetOutputSchema.parse(full)).toEqual(full);
  });

  it('bootstrap:reset round-trips ok=true with a null previousStatus', () => {
    const full: BootstrapResetOutput = {
      ok: true,
      token: 'tok',
      baseUrl: 'http://x',
      previousStatus: null,
    };
    expect(BootstrapResetOutputSchema.parse(full)).toEqual(full);
  });

  it('bootstrap:reset round-trips the ok=false branch', () => {
    const full: BootstrapResetOutput = { ok: false, reason: 'completed-without-force' };
    expect(BootstrapResetOutputSchema.parse(full)).toEqual(full);
  });

  it('bootstrap:reset rejects an ok=false with an unknown reason', () => {
    expect(BootstrapResetOutputSchema.safeParse({ ok: false, reason: 'nope' }).success).toBe(false);
  });
});

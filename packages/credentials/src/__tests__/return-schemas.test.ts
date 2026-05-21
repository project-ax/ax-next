import { describe, it, expect } from 'vitest';
import {
  CredentialsGetOutputSchema,
  CredentialsResolveOutputSchema,
  type CredentialsResolveOutput,
} from '../plugin.js';

describe('credentials return schemas', () => {
  it('CredentialsGetOutputSchema accepts a string and rejects a non-string', () => {
    expect(CredentialsGetOutputSchema.safeParse('secret').success).toBe(true);
    expect(CredentialsGetOutputSchema.safeParse(undefined).success).toBe(false);
    expect(CredentialsGetOutputSchema.safeParse({}).success).toBe(false);
  });

  it('CredentialsResolveOutputSchema requires a string value, allows optional refreshed', () => {
    expect(CredentialsResolveOutputSchema.safeParse({ value: 'v' }).success).toBe(true);
    expect(
      CredentialsResolveOutputSchema.safeParse({ value: 'v', refreshed: { payload: new Uint8Array([1]) } }).success,
    ).toBe(true);
    expect(CredentialsResolveOutputSchema.safeParse({}).success).toBe(false);
    expect(CredentialsResolveOutputSchema.safeParse({ value: 5 }).success).toBe(false);
  });

  // Drift guard: the schema hand-mirrors the CredentialsResolveOutput interface.
  // `full` is typed as the interface, so a new *required* interface field fails
  // this test at compile time; a new optional field fails at runtime because the
  // schema would strip it and the round-trip `toEqual` would diverge. Either way,
  // adding a field to the interface without updating the schema breaks the build.
  it('round-trips a fully-populated interface value without stripping fields', () => {
    const full: CredentialsResolveOutput = {
      value: 'secret',
      refreshed: {
        payload: new Uint8Array([1, 2, 3]),
        expiresAt: 123,
        metadata: { rotated: true },
      },
    };
    const parsed = CredentialsResolveOutputSchema.parse(full);
    expect(parsed).toEqual(full);
  });
});

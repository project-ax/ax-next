import { describe, it, expect } from 'vitest';
import { CredentialsGetOutputSchema, CredentialsResolveOutputSchema } from '../plugin.js';

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
});
